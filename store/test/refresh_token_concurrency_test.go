package test

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestConcurrentRefreshTokenMutations(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, ts.Close()) })
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)

	const tokenCount = 16
	runConcurrently := func(operations []func() error) {
		t.Helper()
		start := make(chan struct{})
		errs := make(chan error, len(operations))
		var wg sync.WaitGroup
		for _, operation := range operations {
			wg.Go(func() {
				<-start
				errs <- operation()
			})
		}
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			require.NoError(t, err)
		}
	}
	assertTokens := func(want []string) {
		t.Helper()
		tokens, err := ts.GetUserRefreshTokens(ctx, user.ID)
		require.NoError(t, err)
		got := make([]string, 0, len(tokens))
		for _, token := range tokens {
			got = append(got, token.TokenId)
		}
		require.ElementsMatch(t, want, got)
	}

	var operations []func() error
	var want []string
	for i := range tokenCount {
		tokenID := fmt.Sprintf("original-%d", i)
		want = append(want, tokenID)
		operations = append(operations, func() error {
			return ts.AddUserRefreshToken(ctx, user.ID, &storepb.RefreshTokensUserSetting_RefreshToken{TokenId: tokenID})
		})
	}
	runConcurrently(operations)
	assertTokens(want)

	// Concurrent sign-outs and sign-ins must neither revive revoked sessions nor
	// discard unrelated sessions. Readers must also be safe during the updates.
	operations = nil
	want = nil
	for i := range tokenCount {
		originalID := fmt.Sprintf("original-%d", i)
		if i%2 == 0 {
			operations = append(operations, func() error {
				return ts.RemoveUserRefreshToken(ctx, user.ID, originalID)
			})
		} else {
			want = append(want, originalID)
		}
		newID := fmt.Sprintf("new-%d", i)
		want = append(want, newID)
		operations = append(operations, func() error {
			return ts.AddUserRefreshToken(ctx, user.ID, &storepb.RefreshTokensUserSetting_RefreshToken{TokenId: newID})
		}, func() error {
			_, err := ts.GetUserRefreshTokens(ctx, user.ID)
			return err
		})
	}
	runConcurrently(operations)
	assertTokens(want)
}

func TestRefreshTokensReturnIndependentSnapshots(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, ts.Close()) })
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	require.NoError(t, ts.AddUserRefreshToken(ctx, user.ID, &storepb.RefreshTokensUserSetting_RefreshToken{TokenId: "original"}))

	snapshot, err := ts.GetUserRefreshTokens(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, snapshot, 1)
	snapshot[0].TokenId = "modified-by-reader"

	require.NoError(t, ts.AddUserRefreshToken(ctx, user.ID, &storepb.RefreshTokensUserSetting_RefreshToken{TokenId: "another"}))
	tokens, err := ts.GetUserRefreshTokens(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, tokens, 2)
	require.Equal(t, "original", tokens[0].TokenId)
	require.Equal(t, "another", tokens[1].TokenId)
}

func TestRefreshTokensIgnoreStaleSettingsCache(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, ts.Close()) })
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	require.NoError(t, ts.AddUserRefreshToken(ctx, user.ID, &storepb.RefreshTokensUserSetting_RefreshToken{TokenId: "revoked"}))

	// Leave the old setting cached while the persisted session is revoked. This
	// represents a generic setting read repopulating the cache after revocation.
	require.NoError(t, ts.GetDriver().DeleteUserSettings(ctx, &store.DeleteUserSetting{
		UserID: &user.ID,
		Key:    storepb.UserSetting_REFRESH_TOKENS,
	}))
	token, err := ts.GetUserRefreshTokenByID(ctx, user.ID, "revoked")
	require.NoError(t, err)
	require.Nil(t, token)

	require.NoError(t, ts.AddUserRefreshToken(ctx, user.ID, &storepb.RefreshTokensUserSetting_RefreshToken{TokenId: "new"}))
	tokens, err := ts.GetUserRefreshTokens(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	require.Equal(t, "new", tokens[0].TokenId)
}
