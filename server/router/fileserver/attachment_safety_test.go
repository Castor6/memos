package fileserver

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func oversizedPNGHeader(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'})
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], 100_000)
	binary.BigEndian.PutUint32(ihdr[4:8], 100_000)
	ihdr[8], ihdr[9] = 8, 2
	require.NoError(t, binary.Write(&buf, binary.BigEndian, uint32(len(ihdr))))
	chunk := append([]byte("IHDR"), ihdr...)
	buf.Write(chunk)
	require.NoError(t, binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(chunk)))
	return buf.Bytes()
}

func TestThumbnailBoundsAndFailureCaching(t *testing.T) {
	ctx := context.Background()
	_, fs, _, cleanup := newShareAttachmentTestServices(ctx, t)
	defer cleanup()
	for name, data := range map[string][]byte{"oversized": oversizedPNGHeader(t), "undecodable": []byte("invalid image")} {
		t.Run(name, func(t *testing.T) {
			attachment := &store.Attachment{UID: name, Type: "image/png", Blob: data}
			_, err := fs.getOrGenerateThumbnail(ctx, attachment)
			require.ErrorIs(t, err, errUseOriginalForThumbnail)
			path, err := fs.getThumbnailPath(attachment)
			require.NoError(t, err)
			require.FileExists(t, path+thumbnailFailedMarkerSuffix)
			attachment.StorageType = storepb.AttachmentStorageType_LOCAL
			attachment.Reference = "missing.png"
			_, err = fs.getOrGenerateThumbnail(ctx, attachment)
			require.ErrorIs(t, err, errUseOriginalForThumbnail, "a remembered verdict skips further source reads")
		})
	}
	attachment := &store.Attachment{UID: "transient", Type: "image/png", StorageType: storepb.AttachmentStorageType_LOCAL, Reference: "missing.png"}
	_, err := fs.getOrGenerateThumbnail(ctx, attachment)
	require.Error(t, err)
	path, err := fs.getThumbnailPath(attachment)
	require.NoError(t, err)
	require.NoFileExists(t, path+thumbnailFailedMarkerSuffix)
	var content bytes.Buffer
	require.NoError(t, png.Encode(&content, image.NewRGBA(image.Rect(0, 0, 8, 8))))
	require.NoError(t, os.WriteFile(filepath.Join(fs.Profile.Data, attachment.Reference), content.Bytes(), 0600))
	_, err = fs.getOrGenerateThumbnail(ctx, attachment)
	require.NoError(t, err, "a transient read error must recover")
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	attachment = &store.Attachment{UID: "canceled", Type: "image/png", Blob: []byte("invalid")}
	_, err = fs.getOrGenerateThumbnail(canceled, attachment)
	require.Error(t, err)
	path, err = fs.getThumbnailPath(attachment)
	require.NoError(t, err)
	require.NoFileExists(t, path+thumbnailFailedMarkerSuffix)
}

type blobCountingDriver struct {
	store.Driver
	blobReads int
}

func (d *blobCountingDriver) ListAttachments(ctx context.Context, find *store.FindAttachment) ([]*store.Attachment, error) {
	if find.GetBlob {
		d.blobReads++
	}
	return d.Driver.ListAttachments(ctx, find)
}

// The original store owns the shared driver's lifecycle.
func (*blobCountingDriver) Close() error { return nil }

func TestAttachmentPermissionPrecedesBlobRead(t *testing.T) {
	ctx := context.Background()
	_, fs, original, cleanup := newShareAttachmentTestServices(ctx, t)
	defer cleanup()
	owner, err := original.CreateUser(ctx, &store.User{Username: "blob-owner", Role: store.RoleUser})
	require.NoError(t, err)
	memo, err := original.CreateMemo(ctx, &store.Memo{UID: "blob-memo", CreatorID: owner.ID, Visibility: store.Private, Content: "private"})
	require.NoError(t, err)
	attachment, err := original.CreateAttachment(ctx, &store.Attachment{UID: "blob-file", CreatorID: owner.ID, MemoID: &memo.ID, Filename: "a.txt", Type: "text/plain", Blob: []byte("private bytes")})
	require.NoError(t, err)
	driver := &blobCountingDriver{Driver: original.GetDriver()}
	wrapped := store.New(driver, fs.Profile)
	defer wrapped.Close()
	fs = NewFileServerService(fs.Profile, wrapped, "test-secret")
	e := echo.New()
	fs.RegisterRoutes(e)
	request := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/file/attachments/"+attachment.UID+"/a.txt", nil))
		return rec
	}
	require.NotEqual(t, http.StatusOK, request().Code)
	require.Zero(t, driver.blobReads)
	visibility := store.Public
	require.NoError(t, original.UpdateMemo(ctx, &store.UpdateMemo{ID: memo.ID, Visibility: &visibility}))
	rec := request()
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "private bytes", rec.Body.String())
	require.Equal(t, 1, driver.blobReads)
}

func TestDeleteAttachmentRemovesAllThumbnailCaches(t *testing.T) {
	ctx := context.Background()
	_, _, testStore, cleanup := newShareAttachmentTestServices(ctx, t)
	defer cleanup()
	owner, err := testStore.CreateUser(ctx, &store.User{Username: "cache-owner", Role: store.RoleUser})
	require.NoError(t, err)
	attachment, err := testStore.CreateAttachment(ctx, &store.Attachment{UID: "cache-file", CreatorID: owner.ID, Filename: "a.png", Type: "image/png"})
	require.NoError(t, err)
	dir := filepath.Join(testStore.GetDataDir(), ThumbnailCacheFolder)
	require.NoError(t, os.MkdirAll(dir, 0700))
	for _, suffix := range []string{".jpeg", ".v2.jpeg", ".v2.jpeg.failed"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, attachment.UID+suffix), []byte("cache"), 0600))
	}
	require.NoError(t, testStore.DeleteAttachment(ctx, &store.DeleteAttachment{ID: attachment.ID}))
	for _, suffix := range []string{".jpeg", ".v2.jpeg", ".v2.jpeg.failed"} {
		require.NoFileExists(t, filepath.Join(dir, attachment.UID+suffix))
	}
}

func TestInterruptedS3ThumbnailDecodeCanRetry(t *testing.T) {
	ctx := context.Background()
	_, fs, _, cleanup := newShareAttachmentTestServices(ctx, t)
	defer cleanup()
	var imageData bytes.Buffer
	require.NoError(t, png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 8, 8))))
	var requests atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(imageData.Len()))
		w.Header().Set("Content-Type", "image/png")
		// Metadata and dimension probes succeed; the full decode loses its stream.
		if requests.Add(1) == 3 {
			_, _ = w.Write(imageData.Bytes()[:40])
			return
		}
		_, _ = w.Write(imageData.Bytes())
	}))
	defer endpoint.Close()
	attachment := &store.Attachment{
		UID: "interrupted", Type: "image/png", StorageType: storepb.AttachmentStorageType_S3,
		Payload: &storepb.AttachmentPayload{Payload: &storepb.AttachmentPayload_S3Object_{
			S3Object: &storepb.AttachmentPayload_S3Object{Key: "image.png", S3Config: &storepb.StorageS3Config{
				Endpoint: endpoint.URL, Region: "us-east-1", Bucket: "test", AccessKeyId: "id", AccessKeySecret: "secret", UsePathStyle: true,
			}},
		}},
	}
	_, err := fs.getOrGenerateThumbnail(ctx, attachment)
	require.Error(t, err)
	require.NotErrorIs(t, err, errUseOriginalForThumbnail)
	path, err := fs.getThumbnailPath(attachment)
	require.NoError(t, err)
	require.NoFileExists(t, path+thumbnailFailedMarkerSuffix)
	_, err = fs.getOrGenerateThumbnail(ctx, attachment)
	require.NoError(t, err)
	require.FileExists(t, path)
}
