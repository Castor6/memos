package test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/wechatkf"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

func kfMessage(id, kind string, data map[string]any) wechatkf.Message {
	return wechatkf.Message{"msgid": id, "msgtype": kind, kind: data, "origin": 3, "external_userid": "owner", "open_kfid": "kf"}
}
func kfBinding() wechatkf.Binding {
	return wechatkf.Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"owner"}, DefaultTags: []string{"微信剪藏"}, ChatTag: "微信聊天记录"}
}

func TestWeChatKFPrivateMemoAndReplay(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := context.Background()
	user, err := ts.CreateRegularUser(ctx, "kf-owner")
	require.NoError(t, err)
	processor, err := wechatkf.NewProcessor(kfBinding(), ts.Service.NewWeChatKFNotes(user.ID, ""), nil)
	require.NoError(t, err)
	message := kfMessage("one", "text", map[string]any{"content": "原文 #标签"})
	// Ambient browser space and identity must not override the configured binding.
	ambient := store.WithSpace(ts.CreateUserContext(ctx, 9999), "other")
	out, err := processor.Process(ambient, message)
	require.NoError(t, err)
	require.Equal(t, "文字保存成功", out.Reply)
	second, err := processor.Process(ctx, message)
	require.NoError(t, err)
	require.Equal(t, out, second)
	memos, err := ts.Store.ListMemos(ctx, &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, memos, 1)
	require.Equal(t, store.Private, memos[0].Visibility)
	require.Equal(t, "", memos[0].Space)
	require.Equal(t, user.ID, memos[0].CreatorID)
	require.Equal(t, "原文", memos[0].Content)
	memo, err := ts.Service.GetMemo(ts.CreateUserContext(ctx, user.ID), &v1pb.GetMemoRequest{Name: "memos/" + out.MemoID})
	require.NoError(t, err)
	require.Equal(t, []string{"微信剪藏", "标签"}, memo.Tags)
	require.True(t, memo.ExplicitTags)
}
func TestWeChatKFMediaRecoveryAndIdempotency(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := context.Background()
	user, err := ts.CreateRegularUser(ctx, "kf-media")
	require.NoError(t, err)
	calls := 0
	download := func(context.Context, string) (wechatkf.Media, error) {
		calls++
		if calls == 1 {
			return wechatkf.Media{}, errors.New("private download URL")
		}
		return wechatkf.Media{Filename: "report.txt", Type: "text/plain", Data: []byte("content")}, nil
	}
	processor, err := wechatkf.NewProcessor(kfBinding(), ts.Service.NewWeChatKFNotes(user.ID, ""), download)
	require.NoError(t, err)
	message := kfMessage("file-one", "file", map[string]any{"media_id": "media"})
	partial, err := processor.Process(ctx, message)
	require.Error(t, err)
	require.NotEmpty(t, partial.MemoID)
	require.Empty(t, partial.Reply)
	require.NotContains(t, err.Error(), "private")
	out, err := processor.Process(ctx, message)
	require.NoError(t, err)
	require.Equal(t, "文件保存成功", out.Reply)
	require.Equal(t, partial.MemoID, out.MemoID)
	_, err = processor.Process(ctx, message)
	require.NoError(t, err)
	require.Equal(t, 2, calls)
	memos, err := ts.Store.ListMemos(ctx, &store.FindMemo{})
	require.NoError(t, err)
	require.Len(t, memos, 1)
	require.Contains(t, memos[0].Content, "/file/attachments/")
	attachments, err := ts.Store.ListAttachments(ctx, &store.FindAttachment{GetBlob: true})
	require.NoError(t, err)
	require.Len(t, attachments, 1)
	require.Equal(t, memos[0].ID, *attachments[0].MemoID)
	saved, err := ts.Service.GetAttachmentBlob(attachments[0])
	require.NoError(t, err)
	require.Equal(t, []byte("content"), saved)
}
func TestWeChatKFAllowlistAndUnsupportedNote(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := context.Background()
	user, err := ts.CreateRegularUser(ctx, "kf-allow")
	require.NoError(t, err)
	binding := kfBinding()
	processor, err := wechatkf.NewProcessor(binding, ts.Service.NewWeChatKFNotes(user.ID, ""), nil)
	require.NoError(t, err)
	binding.AllowedUsers[0] = "stranger"
	for key, value := range map[string]any{"external_userid": "stranger", "open_kfid": "other", "origin": 4} {
		msg := kfMessage("blocked", "text", map[string]any{"content": "no"})
		msg[key] = value
		out, err := processor.Process(ctx, msg)
		require.NoError(t, err)
		require.True(t, out.Ignored)
	}
	out, err := processor.Process(ctx, kfMessage("unsupported", "note", nil))
	require.NoError(t, err)
	require.Empty(t, out.MemoID)
	require.Equal(t, "微信笔记保存失败：微信接口未提供微信笔记内容", out.Reply)
	memos, err := ts.Store.ListMemos(ctx, &store.FindMemo{})
	require.NoError(t, err)
	require.Empty(t, memos)
}
func TestWeChatKFRejectsUnsafeExistingResources(t *testing.T) {
	for _, scenario := range []string{"foreign", "public", "archived", "attachment", "disabled", "space"} {
		t.Run(scenario, func(t *testing.T) {
			ts := NewTestService(t)
			defer ts.Cleanup()
			ctx := context.Background()
			user, err := ts.CreateRegularUser(ctx, "kf-safe")
			require.NoError(t, err)
			other, err := ts.CreateRegularUser(ctx, "kf-other")
			require.NoError(t, err)
			uid := wechatkf.StableID("corp", "kf", "collision")
			creator := user.ID
			visibility := store.Private
			row := store.Normal
			if scenario == "foreign" {
				creator = other.ID
			}
			if scenario == "public" {
				visibility = store.Public
			}
			if scenario == "archived" {
				row = store.Archived
			}
			memo, err := ts.Store.CreateMemo(ctx, &store.Memo{UID: uid, CreatorID: creator, Content: "untouched", Visibility: visibility, RowStatus: row})
			require.NoError(t, err)
			if scenario == "archived" {
				require.NoError(t, ts.Store.UpdateMemo(ctx, &store.UpdateMemo{ID: memo.ID, RowStatus: &row}))
			}
			if scenario == "attachment" {
				_, err = ts.Store.CreateAttachment(ctx, &store.Attachment{UID: wechatkf.StableID(uid, "media"), CreatorID: other.ID, Filename: "wrong.txt", Type: "text/plain"})
				require.NoError(t, err)
			}
			if scenario == "disabled" {
				disabled := store.Archived
				_, err = ts.Store.UpdateUser(ctx, &store.UpdateUser{ID: user.ID, RowStatus: &disabled})
				require.NoError(t, err)
			}
			space := ""
			if scenario == "space" {
				space = "unknown"
			}
			processor, err := wechatkf.NewProcessor(kfBinding(), ts.Service.NewWeChatKFNotes(user.ID, space), func(context.Context, string) (wechatkf.Media, error) {
				t.Fatal("must not download for unsafe resource")
				return wechatkf.Media{}, nil
			})
			require.NoError(t, err)
			_, err = processor.Process(ctx, kfMessage("collision", "file", map[string]any{"media_id": "media"}))
			require.Error(t, err)
			existing, err := ts.Store.GetMemo(ctx, &store.FindMemo{ID: &memo.ID})
			require.NoError(t, err)
			require.Equal(t, "untouched", existing.Content)
		})
	}
}
