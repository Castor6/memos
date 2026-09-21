package linkmetadata

import (
	"context"
	"testing"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/httpgetter"
	"github.com/usememos/memos/store"
	teststore "github.com/usememos/memos/store/test"
)

func TestBackfillKeepsSnapshotsAndRetriesFailures(t *testing.T) {
	ctx := context.Background()
	db := teststore.NewTestingStore(ctx, t)
	t.Cleanup(func() { db.Close() })
	user, err := db.CreateUser(ctx, &store.User{Username: "preview-user", Role: store.RoleUser})
	require.NoError(t, err)
	_, err = db.CreateMemo(ctx, &store.Memo{UID: "preview-test", CreatorID: user.ID, Content: "https://example.com/success\n\nhttps://example.com/retry", Visibility: store.Private})
	require.NoError(t, err)
	calls := map[string]int{}
	fetch := func(_ context.Context, url string) (*httpgetter.HTMLMeta, error) {
		calls[url]++
		if url == "https://example.com/retry" && calls[url] == 1 {
			return nil, errors.New("temporary")
		}
		return &httpgetter.HTMLMeta{Title: "历史标题"}, nil
	}
	runOnce(ctx, db, fetch)
	runOnce(ctx, db, fetch)
	runOnce(ctx, db, fetch)
	require.Equal(t, 1, calls["https://example.com/success"])
	require.Equal(t, 2, calls["https://example.com/retry"])
	saved, err := db.GetLinkMetadata(ctx, "https://example.com/retry")
	require.NoError(t, err)
	require.Equal(t, "历史标题", saved.Title)
}
