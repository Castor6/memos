package v1

import (
	"bytes"
	"context"
	"math"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func uploadTestOwner(t *testing.T, s *APIV1Service) (*store.User, context.Context) {
	t.Helper()
	t.Cleanup(s.CloseUploads)
	user, err := s.Store.CreateUser(context.Background(), &store.User{Username: "upload-owner", Role: store.RoleUser})
	require.NoError(t, err)
	_, err = s.Store.UpsertUserSetting(context.Background(), &storepb.UserSetting{
		UserId: user.ID, Key: storepb.UserSetting_GENERAL,
		Value: &storepb.UserSetting_General{General: &storepb.GeneralUserSetting{Spaces: map[string]string{"work": "Work"}}},
	})
	require.NoError(t, err)
	return user, store.WithSpace(userCtx(context.Background(), user.ID), "work")
}

func beginTestUpload(ctx context.Context, t *testing.T, s *APIV1Service, size int64) *v1pb.UploadAttachmentResponse {
	t.Helper()
	response, err := s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_Spec{Spec: &v1pb.UploadAttachmentSpec{
		Attachment: &v1pb.Attachment{Filename: "sample.txt", Type: "text/plain"}, TotalSize: size,
	}}})
	require.NoError(t, err)
	require.Equal(t, int32(uploadChunkSize), response.MaxChunkSize)
	return response
}

func TestChunkUploadIsolationRetryAndCompletion(t *testing.T) {
	s := newIntegrationService(t)
	owner, ctx := uploadTestOwner(t, s)
	response := beginTestUpload(ctx, t, s, 6)
	request := &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_UploadId{UploadId: response.UploadId}, Data: []byte("abc")}
	response, err := s.UploadAttachment(ctx, request)
	require.NoError(t, err)
	require.Equal(t, int64(3), response.CommittedSize)
	response, err = s.UploadAttachment(ctx, request)
	require.NoError(t, err)
	require.Equal(t, int64(3), response.CommittedSize)
	request.Data = []byte("xyz")
	_, err = s.UploadAttachment(ctx, request)
	require.Equal(t, codes.OutOfRange, status.Code(err))
	request.Data = nil
	response, err = s.UploadAttachment(ctx, request)
	require.NoError(t, err)
	require.Equal(t, int64(3), response.CommittedSize)
	_, err = s.UploadAttachment(store.WithSpace(ctx, ""), request)
	require.Equal(t, codes.FailedPrecondition, status.Code(err))
	other, err := s.Store.CreateUser(context.Background(), &store.User{Username: "upload-other", Role: store.RoleUser})
	require.NoError(t, err)
	_, err = s.UploadAttachment(userCtx(context.Background(), other.ID), request)
	require.Equal(t, codes.NotFound, status.Code(err))
	_, err = s.UploadAttachment(context.Background(), request)
	require.Equal(t, codes.Unauthenticated, status.Code(err))

	request.WriteOffset, request.Data, request.FinishWrite = 3, []byte("def"), true
	var wg sync.WaitGroup
	responses := make(chan *v1pb.UploadAttachmentResponse, 8)
	errors := make(chan error, 8)
	for range 8 {
		wg.Go(func() { got, err := s.UploadAttachment(ctx, request); responses <- got; errors <- err })
	}
	wg.Wait()
	close(responses)
	close(errors)
	for err := range errors {
		require.NoError(t, err)
	}
	name := ""
	for got := range responses {
		require.NotNil(t, got.Attachment)
		if name == "" {
			name = got.Attachment.Name
		}
		require.Equal(t, name, got.Attachment.Name)
	}
	attachments, err := s.Store.ListAttachments(ctx, &store.FindAttachment{CreatorID: &owner.ID, GetBlob: true})
	require.NoError(t, err)
	require.Len(t, attachments, 1)
	require.Equal(t, "work", attachments[0].Space)
	blob, err := s.GetAttachmentBlob(attachments[0])
	require.NoError(t, err)
	require.Equal(t, []byte("abcdef"), blob)
	pending, err := filepath.Glob(filepath.Join(s.Profile.Data, attachmentUploadTempPrefix+"*"))
	require.NoError(t, err)
	require.Empty(t, pending)
	require.NoError(t, s.Store.DeleteAttachment(ctx, &store.DeleteAttachment{ID: attachments[0].ID}))
	_, err = s.UploadAttachment(ctx, request)
	require.Equal(t, codes.NotFound, status.Code(err))
	attachments, err = s.Store.ListAttachments(ctx, &store.FindAttachment{CreatorID: &owner.ID})
	require.NoError(t, err)
	require.Empty(t, attachments)
}

func TestChunkUploadLimitsExpiryAndRestart(t *testing.T) {
	s := newIntegrationService(t)
	_, ctx := uploadTestOwner(t, s)
	for _, request := range []*v1pb.UploadAttachmentRequest{
		{}, {Upload: &v1pb.UploadAttachmentRequest_Spec{}},
		{Upload: &v1pb.UploadAttachmentRequest_Spec{Spec: &v1pb.UploadAttachmentSpec{Attachment: &v1pb.Attachment{Filename: "../bad"}}}},
	} {
		_, err := s.UploadAttachment(ctx, request)
		require.Equal(t, codes.InvalidArgument, status.Code(err))
	}
	_, err := s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Data: make([]byte, uploadChunkSize+1)})
	require.Equal(t, codes.ResourceExhausted, status.Code(err))
	_, err = s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_Spec{Spec: &v1pb.UploadAttachmentSpec{
		Attachment: &v1pb.Attachment{Filename: "too-big.txt"}, TotalSize: 1 << 40,
	}}})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	response := beginTestUpload(ctx, t, s, 3)
	upload, err := s.attachmentUploads.resume(response.UploadId, 1)
	require.NoError(t, err)
	path := upload.path
	upload.expireTime = time.Now().Add(-time.Second)
	upload.mu.Unlock()
	_, err = s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_UploadId{UploadId: response.UploadId}})
	require.Equal(t, codes.NotFound, status.Code(err))
	s.attachmentUploads.mu.Lock()
	s.attachmentUploads.sweepLocked(time.Now(), 0)
	s.attachmentUploads.mu.Unlock()
	_, err = os.Stat(path)
	require.True(t, os.IsNotExist(err))
	for range uploadMaxActivePerUser {
		beginTestUpload(ctx, t, s, 1)
	}
	_, err = s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_Spec{Spec: &v1pb.UploadAttachmentSpec{Attachment: &v1pb.Attachment{Filename: "one-more.txt"}}}})
	require.Equal(t, codes.ResourceExhausted, status.Code(err))
	s.CloseUploads()
	pending, err := filepath.Glob(filepath.Join(s.Profile.Data, attachmentUploadTempPrefix+"*"))
	require.NoError(t, err)
	require.Empty(t, pending)
	restarted := NewAPIV1Service(s.Secret, s.Profile, s.Store)
	t.Cleanup(restarted.CloseUploads)
	_, err = restarted.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_UploadId{UploadId: response.UploadId}})
	require.Equal(t, codes.NotFound, status.Code(err))
}

func TestChunkUploadSizeLimitBeforeSessionAllocation(t *testing.T) {
	for _, tc := range []struct {
		name       string
		configured int64
		limit      int64
	}{
		{name: "ordinary limit", configured: 1, limit: MebiByte},
		{name: "default limit", configured: 0, limit: 30 * MebiByte},
		{name: "below database cap", configured: 2047, limit: 2047 * MebiByte},
		{name: "database cap", configured: 2048, limit: math.MaxInt32},
		{name: "overflowing configuration", configured: math.MaxInt64, limit: math.MaxInt32},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newIntegrationService(t)
			owner, ctx := uploadTestOwner(t, s)
			_, err := s.Store.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
				Key: storepb.InstanceSettingKey_STORAGE,
				Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{
					UploadSizeLimitMb: tc.configured,
				}},
			})
			require.NoError(t, err)
			_, err = s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{
				Upload: &v1pb.UploadAttachmentRequest_Spec{Spec: &v1pb.UploadAttachmentSpec{
					Attachment: &v1pb.Attachment{Filename: "oversized.bin"}, TotalSize: tc.limit + 1,
				}},
			})
			require.Equal(t, codes.InvalidArgument, status.Code(err))
			require.Equal(t, "file size exceeds the limit", status.Convert(err).Message())
			s.attachmentUploads.mu.Lock()
			sessionCount := len(s.attachmentUploads.entries)
			s.attachmentUploads.mu.Unlock()
			require.Zero(t, sessionCount, "rejected files must not consume upload sessions")
			pending, err := filepath.Glob(filepath.Join(s.Profile.Data, attachmentUploadTempPrefix+"*"))
			require.NoError(t, err)
			require.Empty(t, pending, "rejected files must not allocate temporary files")

			// Opening a boundary-sized upload must not preallocate its declared bytes.
			response := beginTestUpload(ctx, t, s, tc.limit)
			upload, err := s.attachmentUploads.resume(response.UploadId, owner.ID)
			require.NoError(t, err)
			uploadPath, totalSize := upload.path, upload.totalSize
			upload.mu.Unlock()
			require.Equal(t, tc.limit, totalSize)
			info, err := os.Stat(uploadPath)
			require.NoError(t, err)
			require.Zero(t, info.Size())
		})
	}
}

func TestChunkUploadRevalidatesMemoAndLimit(t *testing.T) {
	s := newIntegrationService(t)
	owner, ctx := uploadTestOwner(t, s)
	memo, err := s.Store.CreateMemo(ctx, &store.Memo{UID: "upload-memo", CreatorID: owner.ID, Visibility: store.Private})
	require.NoError(t, err)
	memoName := "memos/" + memo.UID
	response, err := s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_Spec{Spec: &v1pb.UploadAttachmentSpec{
		Attachment: &v1pb.Attachment{Filename: "linked.txt", Memo: &memoName}, TotalSize: 3,
	}}})
	require.NoError(t, err)
	require.NoError(t, s.Store.DeleteMemo(ctx, &store.DeleteMemo{ID: memo.ID}))
	_, err = s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_UploadId{UploadId: response.UploadId}, Data: []byte("abc"), FinishWrite: true})
	require.Equal(t, codes.NotFound, status.Code(err))
	response = beginTestUpload(ctx, t, s, 2*MebiByte)
	_, err = s.Store.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{Key: storepb.InstanceSettingKey_STORAGE, Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{UploadSizeLimitMb: 1}}})
	require.NoError(t, err)
	_, err = s.UploadAttachment(ctx, &v1pb.UploadAttachmentRequest{Upload: &v1pb.UploadAttachmentRequest_UploadId{UploadId: response.UploadId}, Data: bytes.Repeat([]byte("x"), 2*MebiByte), FinishWrite: true})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	size, err := s.Store.GetAttachmentStorageUsage(ctx, owner.ID)
	require.NoError(t, err)
	require.Zero(t, size)
}

func TestAttachmentStorageStatsOnlyOwnerAcrossSpaces(t *testing.T) {
	s := newIntegrationService(t)
	owner, ctx := uploadTestOwner(t, s)
	other, err := s.Store.CreateUser(context.Background(), &store.User{Username: "stats-other", Role: store.RoleAdmin})
	require.NoError(t, err)
	for _, item := range []struct {
		uid, space string
		owner      int32
		size       int64
	}{
		{"default-upload", "", owner.ID, 17}, {"work-upload", "work", owner.ID, 29}, {"other-upload", "", other.ID, 1000},
	} {
		_, err := s.Store.CreateAttachment(store.WithSpace(context.Background(), item.space), &store.Attachment{UID: item.uid, CreatorID: item.owner, Size: item.size})
		require.NoError(t, err)
	}
	beginTestUpload(ctx, t, s, 123)
	request := &v1pb.GetUserStatsRequest{Name: "users/" + owner.Username}
	own, err := s.GetUserStats(ctx, request)
	require.NoError(t, err)
	require.NotNil(t, own.AttachmentStorageBytes)
	require.Equal(t, int64(46), *own.AttachmentStorageBytes)
	for _, caller := range []context.Context{context.Background(), userCtx(context.Background(), other.ID)} {
		got, err := s.GetUserStats(caller, request)
		require.NoError(t, err)
		require.Nil(t, got.AttachmentStorageBytes)
	}
}
