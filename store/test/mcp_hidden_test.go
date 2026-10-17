package test

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestMCPHiddenStore(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	defer s.Close()
	user, err := createTestingHostUser(ctx, s)
	require.NoError(t, err)
	create := func(uid string, hidden bool, created int64) *store.Memo {
		memo, createErr := s.CreateMemo(ctx, &store.Memo{
			UID: uid, CreatorID: user.ID, Content: "preserved body", Visibility: store.Private,
			MCPHidden: hidden, CreatedTs: created, Payload: &storepb.MemoPayload{Tags: []string{"preserved-tag"}},
		})
		require.NoError(t, createErr)
		return memo
	}
	older := create("visible-older", false, 1700000000)
	newer := create("visible-newer", false, 1700000100)
	hidden := create("hidden-note", true, 1700000200)
	inherited := create("hidden-parent-comment", false, 1700000300)
	grandchild := create("hidden-ancestor-comment", false, 1700000350)
	privateComment := create("independent-hidden-comment", true, 1700000400)
	for _, relation := range []*store.MemoRelation{
		{MemoID: inherited.ID, RelatedMemoID: hidden.ID, Type: store.MemoRelationComment},
		{MemoID: grandchild.ID, RelatedMemoID: inherited.ID, Type: store.MemoRelationComment},
		{MemoID: privateComment.ID, RelatedMemoID: older.ID, Type: store.MemoRelationComment},
		{MemoID: older.ID, RelatedMemoID: hidden.ID, Type: store.MemoRelationReference},
		{MemoID: older.ID, RelatedMemoID: newer.ID, Type: store.MemoRelationReference},
	} {
		_, err = s.UpsertMemoRelation(ctx, relation)
		require.NoError(t, err)
	}

	all, err := s.ListMemos(ctx, &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, all, 6, "ordinary queries retain every memo")
	limit := 1
	for offset, expected := range []*store.Memo{newer, older} {
		page, listErr := s.ListMemos(ctx, &store.FindMemo{ExcludeMCPHidden: true, Limit: &limit, Offset: &offset})
		require.NoError(t, listErr)
		require.Len(t, page, 1)
		require.Equal(t, expected.UID, page[0].UID, "hidden rows must be filtered before pagination")
	}
	for _, memo := range []*store.Memo{hidden, inherited, grandchild, privateComment} {
		found, getErr := s.GetMemo(ctx, &store.FindMemo{UID: &memo.UID, ExcludeMCPHidden: true})
		require.NoError(t, getErr)
		require.Nil(t, found)
	}
	relations, err := s.ListMemoRelations(ctx, &store.FindMemoRelation{ExcludeMCPHidden: true})
	require.NoError(t, err)
	require.Len(t, relations, 1)
	require.Equal(t, newer.ID, relations[0].RelatedMemoID)

	for i, memoID := range []*int32{nil, &older.ID, &hidden.ID, &inherited.ID, &grandchild.ID, &privateComment.ID} {
		_, err = s.CreateAttachment(ctx, &store.Attachment{
			UID: fmt.Sprintf("privacy-file-%d", i), CreatorID: user.ID, Filename: "file.txt", MemoID: memoID,
		})
		require.NoError(t, err)
	}
	files, err := s.ListAttachments(ctx, &store.FindAttachment{ExcludeMCPHidden: true})
	require.NoError(t, err)
	require.Len(t, files, 2, "unattached and visible memo attachments remain accessible")
	for _, file := range files {
		if file.MemoID != nil {
			require.Equal(t, older.ID, *file.MemoID)
		}
	}

	disabled := false
	require.NoError(t, s.UpdateMemo(ctx, &store.UpdateMemo{ID: hidden.ID, MCPHidden: &disabled}))
	visible, err := s.ListMemos(ctx, &store.FindMemo{ExcludeMCPHidden: true})
	require.NoError(t, err)
	require.Len(t, visible, 5, "clearing the parent flag also restores its comments")
	enabled := true
	require.NoError(t, s.ApplyMemoMutation(ctx, &store.MemoMutation{ActorID: user.ID, Update: &store.UpdateMemo{ID: older.ID, MCPHidden: &enabled}}))
	reloaded, err := s.GetMemo(ctx, &store.FindMemo{ID: &older.ID})
	require.NoError(t, err)
	require.True(t, reloaded.MCPHidden)
	require.Equal(t, "preserved body", reloaded.Content)
	require.Equal(t, []string{"preserved-tag"}, reloaded.Payload.Tags)
}

func TestMCPHiddenMigration(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	defer s.Close()
	user, err := createTestingHostUser(ctx, s)
	require.NoError(t, err)
	memo, err := s.CreateMemo(ctx, &store.Memo{
		UID: "pre-mcp-hidden", CreatorID: user.ID, Content: "legacy content", Visibility: store.Private,
		Space: "original-space", IsTodo: true, Payload: &storepb.MemoPayload{Tags: []string{"legacy-tag"}},
	})
	require.NoError(t, err)
	// Recreate the immediately preceding schema without keeping a duplicate SQL fixture.
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "ALTER TABLE memo DROP COLUMN mcp_hidden")
	require.NoError(t, err)
	_, err = s.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
		Key:   storepb.InstanceSettingKey_BASIC,
		Value: &storepb.InstanceSetting_BasicSetting{BasicSetting: &storepb.InstanceBasicSetting{SchemaVersion: "0.30.6"}},
	})
	require.NoError(t, err)
	require.NoError(t, s.Migrate(ctx))
	require.NoError(t, s.Migrate(ctx), "restarting must not replay the migration")
	reloaded, err := s.GetMemo(ctx, &store.FindMemo{ID: &memo.ID})
	require.NoError(t, err)
	require.False(t, reloaded.MCPHidden, "existing memos retain their prior MCP visibility")
	require.Equal(t, memo.Content, reloaded.Content)
	require.Equal(t, memo.Space, reloaded.Space)
	require.Equal(t, memo.IsTodo, reloaded.IsTodo)
	require.Equal(t, memo.Payload.Tags, reloaded.Payload.Tags)
}
