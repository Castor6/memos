package test

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/testutil"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestAttachmentStripsExifDespiteDeclaredMime(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	user, err := ts.CreateRegularUser(context.Background(), "exif-label")
	require.NoError(t, err)
	ctx := ts.CreateUserContext(context.Background(), user.ID)
	var encoded bytes.Buffer
	require.NoError(t, jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil))
	const marker = "GPS-EXIF-TEST-MARKER"
	payload := []byte("Exif\x00\x00" + marker)
	var content bytes.Buffer
	content.Write(encoded.Bytes()[:2])
	content.Write([]byte{0xff, 0xe1})
	require.NoError(t, binary.Write(&content, binary.BigEndian, uint16(len(payload)+2)))
	content.Write(payload)
	content.Write(encoded.Bytes()[2:])
	for _, declared := range []string{"application/octet-stream", "image/png", "text/plain"} {
		created, err := ts.Service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{Attachment: &v1pb.Attachment{
			Filename: "photo.bin", Type: declared, Content: content.Bytes(),
		}})
		require.NoError(t, err)
		uid := strings.TrimPrefix(created.Name, "attachments/")
		stored, err := ts.Store.GetAttachment(ctx, &store.FindAttachment{UID: &uid, GetBlob: true})
		require.NoError(t, err)
		blob, err := ts.Service.GetAttachmentBlob(stored)
		require.NoError(t, err)
		require.NotContains(t, string(blob), marker)
		_, _, err = image.Decode(bytes.NewReader(blob))
		require.NoError(t, err)
	}
}

func TestS3DeterministicTemplatesKeepDistinctObjects(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	user, err := ts.CreateRegularUser(context.Background(), "s3-keys")
	require.NoError(t, err)
	ctx := ts.CreateUserContext(context.Background(), user.ID)
	var mu sync.Mutex
	objects := map[string]string{}
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		body, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		objects[r.URL.Path] = string(body)
		mu.Unlock()
		w.Header().Set("ETag", `"test-object"`)
		w.WriteHeader(http.StatusOK)
	}))
	defer endpoint.Close()
	_, err = ts.Store.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
		Key: storepb.InstanceSettingKey_STORAGE,
		Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{
			StorageType: storepb.InstanceStorageSetting_S3, FilepathTemplate: "assets/{filename}",
			S3Config: &storepb.StorageS3Config{Endpoint: endpoint.URL, Region: "us-east-1", Bucket: "test-bucket", AccessKeyId: "test-id", AccessKeySecret: "test-secret", UsePathStyle: true},
		}},
	})
	require.NoError(t, err)
	for _, content := range []string{"first", "second"} {
		_, err = ts.Service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{Attachment: &v1pb.Attachment{
			Filename: "same.txt", Type: "text/plain", Content: []byte(content),
		}})
		require.NoError(t, err)
	}
	mu.Lock()
	defer mu.Unlock()
	require.Len(t, objects, 2)
	values := []string{}
	for key, value := range objects {
		require.True(t, strings.HasPrefix(key, "/test-bucket/assets/same_"), key)
		require.True(t, strings.HasSuffix(key, ".txt"), key)
		values = append(values, value)
	}
	require.ElementsMatch(t, []string{"first", "second"}, values)
}

func TestMislabeledMotionPhotoPreservesEmbeddedVideo(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	user, err := ts.CreateRegularUser(context.Background(), "motion-label")
	require.NoError(t, err)
	ctx := ts.CreateUserContext(context.Background(), user.ID)
	content := testutil.BuildMotionPhotoJPEG()
	created, err := ts.Service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{Attachment: &v1pb.Attachment{
		Filename: "motion.bin", Type: "application/octet-stream", Content: content,
	}})
	require.NoError(t, err)
	require.Equal(t, v1pb.MotionMediaFamily_ANDROID_MOTION_PHOTO, created.GetMotionMedia().GetFamily())
	require.True(t, created.GetMotionMedia().GetHasEmbeddedVideo())
	uid := strings.TrimPrefix(created.Name, "attachments/")
	stored, err := ts.Store.GetAttachment(ctx, &store.FindAttachment{UID: &uid, GetBlob: true})
	require.NoError(t, err)
	blob, err := ts.Service.GetAttachmentBlob(stored)
	require.NoError(t, err)
	require.Equal(t, content, blob)
}
