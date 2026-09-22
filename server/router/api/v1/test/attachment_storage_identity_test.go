package test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestAttachmentStorageIdentitySurvivesUIDReuseAndCleanupReplay(t *testing.T) {
	for _, storageType := range []storepb.InstanceStorageSetting_StorageType{storepb.InstanceStorageSetting_LOCAL, storepb.InstanceStorageSetting_S3} {
		t.Run(storageType.String(), func(t *testing.T) {
			ts := NewTestService(t)
			defer ts.Cleanup()
			ctx := context.Background()
			owner, err := ts.CreateHostUser(ctx, "storage-identity-owner")
			require.NoError(t, err)
			ctx = ts.CreateUserContext(ctx, owner.ID)
			objects := map[string][]byte{}
			var mu sync.Mutex
			fakeS3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch r.Method {
				case http.MethodPut:
					data, readErr := io.ReadAll(r.Body)
					if readErr != nil {
						http.Error(w, readErr.Error(), http.StatusBadRequest)
						return
					}
					objects[r.URL.Path] = data
				case http.MethodGet:
					data, exists := objects[r.URL.Path]
					if !exists {
						w.WriteHeader(http.StatusNotFound)
						return
					}
					_, _ = w.Write(data)
				case http.MethodDelete:
					delete(objects, r.URL.Path)
					w.WriteHeader(http.StatusNoContent)
				default:
					w.WriteHeader(http.StatusMethodNotAllowed)
				}
			}))
			defer fakeS3.Close()
			_, err = ts.Store.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
				Key: storepb.InstanceSettingKey_STORAGE,
				Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{
					StorageType: storageType, FilepathTemplate: "custom/folder",
					S3Config: &storepb.StorageS3Config{Endpoint: fakeS3.URL, Bucket: "memos", Region: "us-east-1", AccessKeyId: "test-key", AccessKeySecret: "test-secret", UsePathStyle: true},
				}},
			})
			require.NoError(t, err)
			memo, err := ts.Store.CreateMemo(ctx, &store.Memo{UID: "storage-identity-memo", CreatorID: owner.ID, Visibility: store.Private})
			require.NoError(t, err)
			memoName := "memos/" + memo.UID
			uid := "client-reused-attachment-id"
			first, err := ts.Service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{AttachmentId: uid, Attachment: &v1pb.Attachment{Filename: "report.bin", Content: []byte("first"), Memo: &memoName}})
			require.NoError(t, err)
			require.Equal(t, "report.bin", first.Filename)
			old, err := ts.Store.GetAttachment(ctx, &store.FindAttachment{UID: &uid})
			require.NoError(t, err)
			require.NoError(t, ts.Store.DeleteMemo(ctx, &store.DeleteMemo{ID: memo.ID}))
			// Simulate a stop after deleting the object but before acknowledging its job.
			require.NoError(t, ts.Store.DeleteAttachmentStorage(ctx, old))
			second, err := ts.Service.CreateAttachment(ctx, &v1pb.CreateAttachmentRequest{AttachmentId: uid, Attachment: &v1pb.Attachment{Filename: "report.bin", Content: []byte("second")}})
			require.NoError(t, err)
			require.Equal(t, first.Name, second.Name)
			require.Equal(t, "report.bin", second.Filename)
			fresh, err := ts.Store.GetAttachment(ctx, &store.FindAttachment{UID: &uid})
			require.NoError(t, err)
			if storageType == storepb.InstanceStorageSetting_LOCAL {
				require.NotEqual(t, old.Reference, fresh.Reference)
				require.Equal(t, filepath.Join(ts.Profile.Data, "custom", "folder"), filepath.Dir(fresh.Reference))
			} else {
				require.NotEqual(t, old.Payload.GetS3Object().Key, fresh.Payload.GetS3Object().Key)
				require.True(t, strings.HasPrefix(filepath.ToSlash(fresh.Payload.GetS3Object().Key), "custom/folder/"))
			}
			cache := filepath.Join(ts.Profile.Data, ".thumbnail_cache", uid+".jpeg")
			require.NoError(t, os.MkdirAll(filepath.Dir(cache), 0700))
			require.NoError(t, os.WriteFile(cache, []byte("new thumbnail"), 0600))
			require.NoError(t, ts.Store.ProcessAttachmentCleanup(ctx, time.Now().Unix(), 100))
			blob, err := ts.Service.GetAttachmentBlob(fresh)
			require.NoError(t, err)
			require.Equal(t, []byte("second"), blob)
			require.FileExists(t, cache)
			var jobs int
			require.NoError(t, ts.Store.GetDriver().GetDB().QueryRow("SELECT COUNT(*) FROM attachment_cleanup").Scan(&jobs))
			require.Zero(t, jobs)
		})
	}
}
