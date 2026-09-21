package v1

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

func TestPDFExportChecksMemoAndImagePermissions(t *testing.T) {
	s := newIntegrationService(t)
	ctx := context.Background()
	owner, err := s.Store.CreateUser(ctx, &store.User{Username: "pdf-owner", Role: store.RoleUser})
	require.NoError(t, err)
	stranger, err := s.Store.CreateUser(ctx, &store.User{Username: "pdf-stranger", Role: store.RoleUser})
	require.NoError(t, err)
	memo, err := s.Store.CreateMemo(ctx, &store.Memo{UID: "private-pdf", CreatorID: owner.ID, Content: "正文", Visibility: store.Private})
	require.NoError(t, err)
	_, err = s.ExportMemoPdf(userCtx(ctx, stranger.ID), &v1pb.ExportMemoPdfRequest{Name: "memos/" + memo.UID})
	require.Equal(t, codes.PermissionDenied, status.Code(err))
	_, err = s.ExportMemoPdf(ctx, &v1pb.ExportMemoPdfRequest{Name: "memos/" + memo.UID})
	require.Error(t, err)
	attachment, err := s.Store.CreateAttachment(ctx, &store.Attachment{UID: "private-image", CreatorID: owner.ID, Filename: "test.png", Type: "image/png", Blob: []byte("private data")})
	require.NoError(t, err)
	_, err = s.pdfImage(userCtx(ctx, stranger.ID), "/file/attachments/"+attachment.UID+"/test.png", nil)
	require.Equal(t, codes.PermissionDenied, status.Code(err))
	data, err := s.pdfImage(userCtx(ctx, owner.ID), "/file/attachments/"+attachment.UID+"/test.png", nil)
	require.NoError(t, err)
	require.Equal(t, []byte("private data"), data)
	_, err = s.pdfImage(userCtx(ctx, owner.ID), "http://127.0.0.1/private.png", nil)
	require.Error(t, err)
}

func TestPDFShareDoesNotBypassGrant(t *testing.T) {
	s := newIntegrationService(t)
	ctx := context.Background()
	_, err := s.ExportSharedMemoPdf(ctx, &v1pb.ExportSharedMemoPdfRequest{ShareToken: "invalid"})
	require.Equal(t, codes.NotFound, status.Code(err))
	owner, err := s.Store.CreateUser(ctx, &store.User{Username: "pdf-share-owner", Role: store.RoleUser})
	require.NoError(t, err)
	attachment, err := s.Store.CreateAttachment(ctx, &store.Attachment{UID: "share-image", CreatorID: owner.ID, Filename: "image.png", Type: "image/png", Blob: []byte("image bytes")})
	require.NoError(t, err)
	address := "/file/attachments/" + attachment.UID + "/image.png"
	_, err = s.pdfImage(ctx, address, map[string]bool{})
	require.Equal(t, codes.PermissionDenied, status.Code(err))
	data, err := s.pdfImage(ctx, address, map[string]bool{attachment.UID: true})
	require.NoError(t, err)
	require.Equal(t, []byte("image bytes"), data)
}
