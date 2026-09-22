package test

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
)

func TestAvatarSizeLimitAndNegativeAttachmentOffset(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	user, err := ts.CreateRegularUser(context.Background(), "avatar-limit")
	require.NoError(t, err)
	ctx := ts.CreateUserContext(context.Background(), user.ID)
	for _, size := range []int{2 << 20, (2 << 20) + 1, 3 << 20} {
		avatar := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", size)))
		_, err := ts.Service.UpdateUser(ctx, &v1pb.UpdateUserRequest{
			User:       &v1pb.User{Name: "users/" + user.Username, AvatarUrl: avatar},
			UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"avatar_url"}},
		})
		if size == 2<<20 {
			require.NoError(t, err)
		} else {
			require.Equal(t, codes.InvalidArgument, status.Code(err))
		}
	}
	_, err = ts.Service.ListAttachments(ctx, &v1pb.ListAttachmentsRequest{PageToken: "-1"})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestUpdateMemoTimestampValidation(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	user, err := ts.CreateRegularUser(context.Background(), "timestamp-update")
	require.NoError(t, err)
	ctx := ts.CreateUserContext(context.Background(), user.ID)
	memo, err := ts.Service.CreateMemo(ctx, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "timestamp"}})
	require.NoError(t, err)
	want := timestamppb.New(time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC))
	updated, err := ts.Service.UpdateMemo(ctx, &v1pb.UpdateMemoRequest{
		Memo: &v1pb.Memo{Name: memo.Name, UpdateTime: want}, UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"update_time"}},
	})
	require.NoError(t, err)
	require.Equal(t, want.AsTime(), updated.UpdateTime.AsTime())
	_, err = ts.Service.UpdateMemo(ctx, &v1pb.UpdateMemoRequest{
		Memo:       &v1pb.Memo{Name: memo.Name, UpdateTime: &timestamppb.Timestamp{Seconds: 253402300800}},
		UpdateMask: &fieldmaskpb.FieldMask{Paths: []string{"update_time"}},
	})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	stored, err := ts.Service.GetMemo(ctx, &v1pb.GetMemoRequest{Name: memo.Name})
	require.NoError(t, err)
	require.Equal(t, want.AsTime(), stored.UpdateTime.AsTime())
}
