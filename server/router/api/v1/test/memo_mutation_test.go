package test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestUpdateMemoValidatesEntireRequestBeforeRemovingAttachments(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := context.Background()
	user, err := ts.CreateHostUser(ctx, "mutation-owner")
	require.NoError(t, err)
	ctx = ts.CreateUserContext(ctx, user.ID)
	memo, err := ts.Service.CreateMemo(ctx, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "before", Visibility: v1pb.Visibility_PRIVATE}})
	require.NoError(t, err)
	uid := memo.Name[len("memos/"):]
	raw, err := ts.Store.GetMemo(ctx, &store.FindMemo{UID: &uid})
	require.NoError(t, err)
	path := filepath.Join(ts.Profile.Data, "retained.txt")
	require.NoError(t, os.WriteFile(path, []byte("retained"), 0600))
	attachment, err := ts.Store.CreateAttachment(ctx, &store.Attachment{
		UID: "mutation-retained", CreatorID: user.ID, MemoID: &raw.ID, Filename: "retained.txt",
		StorageType: storepb.AttachmentStorageType_LOCAL, Reference: "retained.txt",
	})
	require.NoError(t, err)
	for _, test := range []struct {
		name      string
		paths     []string
		relations []*v1pb.MemoRelation
	}{
		{name: "immutable field after attachment", paths: []string{"attachments", "space"}},
		{name: "unknown field after attachment", paths: []string{"attachments", "unknown"}},
		{name: "invalid timestamp after attachment", paths: []string{"attachments", "create_time"}},
		{name: "editor order with missing referenced memo", paths: []string{"content", "attachments", "relations", "update_time"}, relations: []*v1pb.MemoRelation{{RelatedMemo: &v1pb.MemoRelation_Memo{Name: "memos/no-longer-exists"}, Type: v1pb.MemoRelation_REFERENCE}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := ts.Service.UpdateMemo(ctx, &v1pb.UpdateMemoRequest{
				Memo:       &v1pb.Memo{Name: memo.Name, Content: "after", Relations: test.relations},
				UpdateMask: &fieldmaskpb.FieldMask{Paths: test.paths},
			})
			require.Equal(t, codes.InvalidArgument, status.Code(err))
			kept, err := ts.Store.GetAttachment(ctx, &store.FindAttachment{ID: &attachment.ID})
			require.NoError(t, err)
			require.NotNil(t, kept)
			require.FileExists(t, path)
			saved, err := ts.Service.GetMemo(ctx, &v1pb.GetMemoRequest{Name: memo.Name})
			require.NoError(t, err)
			require.Equal(t, "before", saved.Content)
			var jobs int
			require.NoError(t, ts.Store.GetDriver().GetDB().QueryRow("SELECT COUNT(*) FROM attachment_cleanup").Scan(&jobs))
			require.Zero(t, jobs)
		})
	}
	_, err = ts.Service.UpdateMemo(store.WithMemoMutationFailpoint(ctx), &v1pb.UpdateMemoRequest{
		Memo: &v1pb.Memo{Name: memo.Name, Content: "after"}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"content", "attachments", "update_time"}},
	})
	require.Equal(t, codes.Internal, status.Code(err))
	require.FileExists(t, path)
	saved, err := ts.Service.GetMemo(ctx, &v1pb.GetMemoRequest{Name: memo.Name})
	require.NoError(t, err)
	require.Equal(t, "before", saved.Content)
	require.Len(t, saved.Attachments, 1)
}
