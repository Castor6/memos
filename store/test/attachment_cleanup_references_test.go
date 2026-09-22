package test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestAttachmentCleanupPreservesLegacySharedObjects(t *testing.T) {
	for _, storageType := range []storepb.AttachmentStorageType{storepb.AttachmentStorageType_LOCAL, storepb.AttachmentStorageType_S3} {
		t.Run(storageType.String(), func(t *testing.T) {
			ctx := context.Background()
			ts := NewTestingStore(ctx, t)
			defer ts.Close()
			user, err := createTestingHostUser(ctx, ts)
			require.NoError(t, err)
			first, err := ts.CreateMemo(ctx, &store.Memo{UID: "shared-first", CreatorID: user.ID, Visibility: store.Private})
			require.NoError(t, err)
			second, err := ts.CreateMemo(ctx, &store.Memo{UID: "shared-second", CreatorID: user.ID, Visibility: store.Private})
			require.NoError(t, err)
			path := filepath.Join(ts.GetDataDir(), "legacy-shared.txt")
			require.NoError(t, os.WriteFile(path, []byte("shared"), 0600))
			var mu sync.Mutex
			deletedPaths := []string{}
			fakeS3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodDelete {
					w.WriteHeader(http.StatusMethodNotAllowed)
					return
				}
				mu.Lock()
				deletedPaths = append(deletedPaths, r.URL.Path)
				mu.Unlock()
				w.WriteHeader(http.StatusNoContent)
			}))
			defer fakeS3.Close()
			config := &storepb.StorageS3Config{Endpoint: fakeS3.URL, Bucket: "shared-bucket", Region: "us-east-1", AccessKeyId: "test-key", AccessKeySecret: "test-secret", UsePathStyle: true}
			_, err = ts.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{Key: storepb.InstanceSettingKey_STORAGE, Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{S3Config: config}}})
			require.NoError(t, err)
			for i, memo := range []*store.Memo{first, second} {
				attachment := &store.Attachment{UID: memo.UID + "-file", CreatorID: user.ID, MemoID: &memo.ID, StorageType: storageType, Reference: "legacy-shared.txt"}
				if storageType == storepb.AttachmentStorageType_LOCAL {
					if i == 1 {
						attachment.Reference = path
					}
				} else {
					object := &storepb.AttachmentPayload_S3Object{Key: "shared-key"}
					if i == 0 {
						object.S3Config = proto.CloneOf(config)
						object.S3Config.Endpoint += "/"
					}
					attachment.Payload = &storepb.AttachmentPayload{Payload: &storepb.AttachmentPayload_S3Object_{S3Object: object}}
					attachment.Reference = fakeS3.URL + "/shared-key?signature=" + memo.UID
				}
				_, err = ts.CreateAttachment(ctx, attachment)
				require.NoError(t, err)
			}
			if storageType == storepb.AttachmentStorageType_S3 {
				otherConfig := proto.CloneOf(config)
				otherConfig.Bucket = "unrelated-bucket"
				_, err = ts.CreateAttachment(ctx, &store.Attachment{UID: "unrelated-same-key", CreatorID: user.ID, StorageType: storageType, Payload: &storepb.AttachmentPayload{Payload: &storepb.AttachmentPayload_S3Object_{S3Object: &storepb.AttachmentPayload_S3Object{Key: "shared-key", S3Config: otherConfig}}}})
				require.NoError(t, err)
			}
			require.NoError(t, ts.DeleteMemo(ctx, &store.DeleteMemo{ID: first.ID}))
			require.NoError(t, ts.ProcessAttachmentCleanup(ctx, time.Now().Unix(), 100))
			require.Zero(t, cleanupJobCount(t, ts))
			require.FileExists(t, path)
			mu.Lock()
			require.Empty(t, deletedPaths)
			mu.Unlock()
			require.NoError(t, ts.DeleteMemo(ctx, &store.DeleteMemo{ID: second.ID}))
			require.NoError(t, ts.ProcessAttachmentCleanup(ctx, time.Now().Unix(), 100))
			require.Zero(t, cleanupJobCount(t, ts))
			if storageType == storepb.AttachmentStorageType_LOCAL {
				require.NoFileExists(t, path)
			} else {
				mu.Lock()
				require.Equal(t, []string{"/shared-bucket/shared-key"}, deletedPaths)
				mu.Unlock()
			}
		})
	}
}
