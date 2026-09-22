package test

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/usememos/memos/internal/memoexport"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func archiveFixture(t *testing.T) (*TestService, context.Context, *v1pb.ExportMemoArchiveResponse) {
	t.Helper()
	ts := NewTestService(t)
	t.Cleanup(ts.Cleanup)
	user, err := ts.CreateRegularUser(context.Background(), "archive-owner")
	require.NoError(t, err)
	ctx := ts.CreateUserContext(context.Background(), user.ID)
	_, err = ts.Store.UpsertUserSetting(ctx, &storepb.UserSetting{UserId: user.ID, Key: storepb.UserSetting_GENERAL, Value: &storepb.UserSetting_General{General: &storepb.GeneralUserSetting{Spaces: map[string]string{"company": "公司", "empty-space": "空空间"}}}})
	require.NoError(t, err)
	attachment, err := ts.Service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{AttachmentId: "archive-file", Attachment: &v1pb.Attachment{Filename: "hello.txt", Type: "text/plain", Content: []byte("original attachment bytes")}})
	require.NoError(t, err)
	stamp := timestamppb.New(time.Unix(1700000000, 0))
	note, err := ts.Service.CreateMemo(store.WithSpace(ctx, ""), &v1pb.CreateMemoRequest{MemoId: "archive-note", Memo: &v1pb.Memo{Content: "![file](/file/attachments/archive-file/hello.txt) #正文标签", Visibility: v1pb.Visibility_PRIVATE, ExplicitTags: true, Tags: []string{"独立标签"}, CreateTime: stamp, UpdateTime: stamp, Attachments: []*v1pb.Attachment{attachment}}})
	require.NoError(t, err)
	_, err = ts.Service.CreateMemoComment(ctx, &v1pb.CreateMemoCommentRequest{Name: note.Name, CommentId: "archive-comment", Comment: &v1pb.Memo{Content: "comment", CreateTime: stamp, UpdateTime: stamp}})
	require.NoError(t, err)
	_, err = ts.Service.CreateMemo(ctx, &v1pb.CreateMemoRequest{MemoId: "archive-reference", Memo: &v1pb.Memo{Content: "reference", Visibility: v1pb.Visibility_PRIVATE, Relations: []*v1pb.MemoRelation{{Type: v1pb.MemoRelation_REFERENCE, RelatedMemo: &v1pb.MemoRelation_Memo{Name: note.Name}}}}})
	require.NoError(t, err)
	todo, err := ts.Service.CreateMemo(store.WithSpace(ctx, "company"), &v1pb.CreateMemoRequest{MemoId: "archive-todo", Memo: &v1pb.Memo{Content: "- [x] 归档待办", IsTodo: true, ExplicitTags: true, Tags: []string{"待办标签"}, Visibility: v1pb.Visibility_PRIVATE, CreateTime: stamp, UpdateTime: stamp}})
	require.NoError(t, err)
	todo.State = v1pb.State_ARCHIVED
	todo.Pinned = true
	_, err = ts.Service.UpdateMemo(store.WithSpace(ctx, "company"), &v1pb.UpdateMemoRequest{Memo: todo, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"state", "pinned", "update_time"}}})
	require.NoError(t, err)
	other, err := ts.CreateRegularUser(context.Background(), "not-exported")
	require.NoError(t, err)
	_, err = ts.Service.CreateMemo(ts.CreateUserContext(context.Background(), other.ID), &v1pb.CreateMemoRequest{MemoId: "foreign-secret", Memo: &v1pb.Memo{Content: "must not export", Visibility: v1pb.Visibility_PRIVATE}})
	require.NoError(t, err)
	exported, err := ts.Service.ExportMemoArchive(store.WithSpace(ctx, "company"), &v1pb.ExportMemoArchiveRequest{})
	require.NoError(t, err)
	require.EqualValues(t, 4, exported.MemoCount)
	require.EqualValues(t, 1, exported.AttachmentCount)
	return ts, ctx, exported
}

func archiveDestination(t *testing.T) (*TestService, context.Context, *store.User) {
	t.Helper()
	ts := NewTestService(t)
	t.Cleanup(ts.Cleanup)
	user, err := ts.CreateRegularUser(context.Background(), "archive-destination")
	require.NoError(t, err)
	return ts, ts.CreateUserContext(context.Background(), user.ID), user
}

func TestMemoArchiveRoundTripAndRepeat(t *testing.T) {
	_, _, exported := archiveFixture(t)
	archive, err := memoexport.Read(bytes.NewReader(exported.Content), int64(len(exported.Content)))
	require.NoError(t, err)
	require.Len(t, archive.Memos, 4)
	destination, ctx, user := archiveDestination(t)
	result, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
	require.NoError(t, err)
	require.Empty(t, result.Errors)
	require.EqualValues(t, 4, result.Imported)
	require.EqualValues(t, 1, result.Attachments)
	note, err := destination.Service.GetMemo(store.WithSpace(ctx, ""), &v1pb.GetMemoRequest{Name: "memos/archive-note"})
	require.NoError(t, err)
	require.True(t, note.ExplicitTags)
	require.Equal(t, []string{"独立标签"}, note.Tags)
	require.EqualValues(t, 1700000000, note.CreateTime.Seconds)
	require.EqualValues(t, 1700000000, note.UpdateTime.Seconds)
	comment, err := destination.Service.GetMemo(ctx, &v1pb.GetMemoRequest{Name: "memos/archive-comment"})
	require.NoError(t, err)
	require.Equal(t, "memos/archive-note", comment.GetParent())
	todo, err := destination.Service.GetMemo(store.WithSpace(ctx, "company"), &v1pb.GetMemoRequest{Name: "memos/archive-todo"})
	require.NoError(t, err)
	require.True(t, todo.IsTodo)
	require.True(t, todo.Pinned)
	require.Equal(t, v1pb.State_ARCHIVED, todo.State)
	reference, err := destination.Service.GetMemo(ctx, &v1pb.GetMemoRequest{Name: "memos/archive-reference"})
	require.NoError(t, err)
	require.Len(t, reference.Relations, 1)
	require.Equal(t, "memos/archive-note", reference.Relations[0].RelatedMemo.Name)
	setting, err := destination.Store.GetUserSetting(ctx, &store.FindUserSetting{UserID: &user.ID, Key: storepb.UserSetting_GENERAL})
	require.NoError(t, err)
	require.Equal(t, map[string]string{"company": "公司", "empty-space": "空空间"}, setting.GetGeneral().Spaces)
	uid := "archive-file"
	stored, err := destination.Store.GetAttachment(ctx, &store.FindAttachment{UID: &uid, GetBlob: true})
	require.NoError(t, err)
	blob, err := destination.Service.GetAttachmentBlob(stored)
	require.NoError(t, err)
	require.Equal(t, []byte("original attachment bytes"), blob)
	repeated, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
	require.NoError(t, err)
	require.EqualValues(t, 0, repeated.Imported)
	require.EqualValues(t, 4, repeated.Skipped)
	require.EqualValues(t, 0, repeated.Attachments)
	require.Empty(t, repeated.Errors)
	reexported, err := destination.Service.ExportMemoArchive(ctx, &v1pb.ExportMemoArchiveRequest{})
	require.NoError(t, err)
	require.Equal(t, exported.MemoCount, reexported.MemoCount)
}

func rewriteArchive(t *testing.T, original []byte, mutate func(string, []byte) []byte, extra string) []byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(original), int64(len(original)))
	require.NoError(t, err)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range reader.File {
		in, err := entry.Open()
		require.NoError(t, err)
		data, err := io.ReadAll(in)
		require.NoError(t, err)
		require.NoError(t, in.Close())
		out, err := writer.Create(entry.Name)
		require.NoError(t, err)
		_, err = out.Write(mutate(entry.Name, data))
		require.NoError(t, err)
	}
	if extra != "" {
		_, err = writer.Create(extra)
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	return buffer.Bytes()
}

func TestMemoArchiveRejectsInvalidDataBeforeAnyWrites(t *testing.T) {
	_, _, exported := archiveFixture(t)
	for _, test := range []struct {
		name   string
		mutate func(string, []byte) []byte
		extra  string
	}{
		{"checksum", func(name string, data []byte) []byte {
			if strings.HasPrefix(name, "attachments/") {
				return bytes.Repeat([]byte{'x'}, len(data))
			}
			return data
		}, ""},
		{"traversal", func(_ string, data []byte) []byte { return data }, "../escape.txt"},
		{"space", func(name string, data []byte) []byte {
			if name == "memos/archive-todo.json" {
				return bytes.ReplaceAll(data, []byte("\"space\":\"company\""), []byte("\"space\":\"missing\""))
			}
			return data
		}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			destination, ctx, user := archiveDestination(t)
			data := rewriteArchive(t, exported.Content, test.mutate, test.extra)
			_, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: data})
			require.Equal(t, codes.InvalidArgument, status.Code(err))
			memos, err := destination.Store.ListMemos(ctx, &store.FindMemo{CreatorID: &user.ID})
			require.NoError(t, err)
			require.Empty(t, memos)
			attachments, err := destination.Store.ListAttachments(ctx, &store.FindAttachment{CreatorID: &user.ID})
			require.NoError(t, err)
			require.Empty(t, attachments)
			setting, err := destination.Store.GetUserSetting(ctx, &store.FindUserSetting{UserID: &user.ID, Key: storepb.UserSetting_GENERAL})
			require.NoError(t, err)
			require.Empty(t, setting.GetGeneral().GetSpaces())
		})
	}
}

func TestMemoArchiveCollisionsPreserveExistingData(t *testing.T) {
	_, _, exported := archiveFixture(t)
	destination, ctx, user := archiveDestination(t)
	_, err := destination.Store.UpsertUserSetting(ctx, &storepb.UserSetting{UserId: user.ID, Key: storepb.UserSetting_GENERAL, Value: &storepb.UserSetting_General{General: &storepb.GeneralUserSetting{Spaces: map[string]string{"company": "原有公司"}}}})
	require.NoError(t, err)
	_, err = destination.Service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{AttachmentId: "archive-file", Attachment: &v1pb.Attachment{Filename: "existing.txt", Type: "text/plain", Content: []byte("existing")}})
	require.NoError(t, err)
	result, err := destination.Service.ImportMemoArchive(ctx, &v1pb.ImportMemoArchiveRequest{Content: exported.Content})
	require.NoError(t, err)
	require.Empty(t, result.Errors)
	require.EqualValues(t, 4, result.Imported)
	note, err := destination.Service.GetMemo(ctx, &v1pb.GetMemoRequest{Name: "memos/archive-note"})
	require.NoError(t, err)
	require.Len(t, note.Attachments, 1)
	require.NotEqual(t, "attachments/archive-file", note.Attachments[0].Name)
	require.Contains(t, note.Content, "/file/"+note.Attachments[0].Name+"/hello.txt")
	setting, err := destination.Store.GetUserSetting(ctx, &store.FindUserSetting{UserID: &user.ID, Key: storepb.UserSetting_GENERAL})
	require.NoError(t, err)
	require.Equal(t, "原有公司", setting.GetGeneral().Spaces["company"])
	uid := "archive-todo"
	todo, err := destination.Store.GetMemo(store.WithoutSpace(ctx), &store.FindMemo{UID: &uid})
	require.NoError(t, err)
	require.NotEqual(t, "company", todo.Space)
	require.Equal(t, "公司", setting.GetGeneral().Spaces[todo.Space])
	uid = "archive-file"
	existing, err := destination.Store.GetAttachment(ctx, &store.FindAttachment{UID: &uid, GetBlob: true})
	require.NoError(t, err)
	blob, err := destination.Service.GetAttachmentBlob(existing)
	require.NoError(t, err)
	require.Equal(t, "existing", string(blob))
}

func TestMemoArchiveRequiresAuthentication(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	_, err := ts.Service.ExportMemoArchive(context.Background(), &v1pb.ExportMemoArchiveRequest{})
	require.Equal(t, codes.Unauthenticated, status.Code(err))
	_, err = ts.Service.ImportMemoArchive(context.Background(), &v1pb.ImportMemoArchiveRequest{})
	require.Equal(t, codes.Unauthenticated, status.Code(err))
}
