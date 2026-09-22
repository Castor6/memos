package test

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestMemoCaptureLifecycleAndOwnerPrivacy(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := store.WithSpace(context.Background(), "")
	owner, err := ts.CreateRegularUser(ctx, "capture-owner")
	require.NoError(t, err)
	other, err := ts.CreateRegularUser(ctx, "capture-other")
	require.NoError(t, err)
	ownerCtx := ts.CreateUserContext(ctx, owner.ID)
	otherCtx := ts.CreateUserContext(ctx, other.ID)
	capture := &v1pb.MemoCapture{Kind: "STAR", Platform: "WEB", SourceUrl: "https://example.com/article", Comment: "Original observation", Context: "Private background"}
	request := &v1pb.CreateMemoRequest{MemoId: "stable-capture-id", Memo: &v1pb.Memo{Content: "Shared body", Visibility: v1pb.Visibility_PUBLIC, Capture: capture}}
	memo, err := ts.Service.CreateMemo(ownerCtx, request)
	require.NoError(t, err)
	require.True(t, proto.Equal(capture, memo.Capture))
	_, err = ts.Service.CreateMemo(ownerCtx, request)
	require.Equal(t, codes.AlreadyExists, status.Code(err), "retrying the same save ID must not duplicate the memo")
	restored, err := ts.Service.GetMemo(ts.CreateUserContext(ctx, owner.ID), &v1pb.GetMemoRequest{Name: memo.Name})
	require.NoError(t, err)
	require.True(t, proto.Equal(capture, restored.Capture), "another session of the same account restores the snapshot")
	for _, reader := range []context.Context{ctx, otherCtx} {
		public, err := ts.Service.GetMemo(reader, &v1pb.GetMemoRequest{Name: memo.Name})
		require.NoError(t, err)
		require.Nil(t, public.Capture, "sharing the memo does not expose the structured background")
	}
	_, err = ts.Service.CreateMemo(otherCtx, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "Other public capture", Visibility: v1pb.Visibility_PUBLIC, Capture: capture}})
	require.NoError(t, err)
	_, err = ts.Service.CreateMemo(ownerCtx, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "Ordinary note"}})
	require.NoError(t, err)
	history, err := ts.Service.ListMemos(ownerCtx, &v1pb.ListMemosRequest{Filter: `has_capture == true && capture_kind == "STAR" && capture_source_url == "https://example.com/article"`})
	require.NoError(t, err)
	require.Len(t, history.Memos, 1)
	require.Equal(t, memo.Name, history.Memos[0].Name)
	_, err = ts.Service.ListMemos(ctx, &v1pb.ListMemosRequest{Filter: `has_capture`})
	require.Equal(t, codes.Unauthenticated, status.Code(err))
	stats, err := ts.Service.ListAllUserStats(ownerCtx, &v1pb.ListAllUserStatsRequest{Filter: `capture_kind == "STAR" || visibility == "PUBLIC"`})
	require.NoError(t, err)
	require.Len(t, stats.Stats, 1, "capture filters must not leak another owner's metadata through statistics")
	updated, err := ts.Service.UpdateMemo(ownerCtx, &v1pb.UpdateMemoRequest{
		Memo: &v1pb.Memo{Name: memo.Name, Content: "Edited body", Tags: []string{"review"}}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"content", "tags"}},
	})
	require.NoError(t, err)
	require.True(t, proto.Equal(capture, updated.Capture), "ordinary edits preserve the original capture snapshot")
	_, err = ts.Service.UpdateMemo(ownerCtx, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: memo.Name}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"capture"}}})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	_, err = ts.Service.UpdateMemo(ownerCtx, &v1pb.UpdateMemoRequest{Memo: &v1pb.Memo{Name: memo.Name, State: v1pb.State_ARCHIVED}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"state"}}})
	require.NoError(t, err)
	history, err = ts.Service.ListMemos(ownerCtx, &v1pb.ListMemosRequest{Filter: `has_capture`})
	require.NoError(t, err)
	require.Empty(t, history.Memos)
	history, err = ts.Service.ListMemos(ownerCtx, &v1pb.ListMemosRequest{Filter: `has_capture`, State: v1pb.State_ARCHIVED})
	require.NoError(t, err)
	require.Len(t, history.Memos, 1)
	_, err = ts.Service.DeleteMemo(ownerCtx, &v1pb.DeleteMemoRequest{Name: memo.Name})
	require.NoError(t, err)
	history, err = ts.Service.ListMemos(ownerCtx, &v1pb.ListMemosRequest{Filter: `has_capture`, State: v1pb.State_ARCHIVED})
	require.NoError(t, err)
	require.Empty(t, history.Memos)
}

func TestMemoCaptureSpaceAndValidation(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := context.Background()
	owner, err := ts.CreateRegularUser(ctx, "capture-spaces")
	require.NoError(t, err)
	ctx = ts.CreateUserContext(ctx, owner.ID)
	_, err = ts.Store.UpsertUserSetting(ctx, &storepb.UserSetting{UserId: owner.ID, Key: storepb.UserSetting_GENERAL, Value: &storepb.UserSetting_General{General: &storepb.GeneralUserSetting{Spaces: map[string]string{"work": "Work"}}}})
	require.NoError(t, err)
	personal := store.WithSpace(ctx, "")
	work := store.WithSpace(ctx, "work")
	capture := &v1pb.MemoCapture{Kind: "PICK_UP", Platform: "X", SourceId: "123", SourceUrl: "https://x.com/reader/status/123", Comment: "My reply", Posts: []*v1pb.MemoCapture_Post{{Id: "123", Url: "https://x.com/reader/status/123", Content: "My reply"}}}
	memo, err := ts.Service.CreateMemo(work, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "Reply and source", Capture: capture}})
	require.NoError(t, err)
	require.Equal(t, "work", memo.Space)
	history, err := ts.Service.ListMemos(personal, &v1pb.ListMemosRequest{Filter: `capture_source_id == "123"`})
	require.NoError(t, err)
	require.Empty(t, history.Memos)
	history, err = ts.Service.ListMemos(work, &v1pb.ListMemosRequest{Filter: `capture_source_id == "123"`})
	require.NoError(t, err)
	require.Len(t, history.Memos, 1)
	_, err = ts.Service.GetMemo(personal, &v1pb.GetMemoRequest{Name: memo.Name})
	require.Equal(t, codes.NotFound, status.Code(err))
	for _, invalid := range []*v1pb.Memo{
		{Content: "Invalid type", Capture: &v1pb.MemoCapture{Kind: "UNKNOWN"}},
		{Content: "Wrong space", Space: "other", Capture: capture},
		{Content: "Todo", IsTodo: true, Capture: capture},
		{Content: strings.Repeat("x", store.DefaultContentLengthLimit+1), Capture: capture},
	} {
		_, err := ts.Service.CreateMemo(personal, &v1pb.CreateMemoRequest{Memo: invalid})
		require.Equal(t, codes.InvalidArgument, status.Code(err))
	}
	history, err = ts.Service.ListMemos(personal, &v1pb.ListMemosRequest{Filter: `has_capture`})
	require.NoError(t, err)
	require.Empty(t, history.Memos, "rejected saves must not leave partial records")
	profile, err := ts.Service.GetInstanceProfile(context.Background(), &v1pb.GetInstanceProfileRequest{})
	require.NoError(t, err)
	require.True(t, profile.WebClipperSupported)
	require.EqualValues(t, store.DefaultContentLengthLimit, profile.MemoContentMaxBytes)
}
