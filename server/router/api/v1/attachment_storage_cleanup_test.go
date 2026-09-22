package v1

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

type testUploadedAttachmentObject struct {
	presign func(context.Context, string) (string, error)
	remove  func(context.Context, string) error
}

func (c *testUploadedAttachmentObject) PresignGetObject(ctx context.Context, key string) (string, error) {
	return c.presign(ctx, key)
}

func (c *testUploadedAttachmentObject) DeleteObject(ctx context.Context, key string) error {
	return c.remove(ctx, key)
}

func TestAttachmentPresignFailureCleanup(t *testing.T) {
	presignErr := errors.New("signing failed")
	for _, cleanupFailure := range []bool{false, true} {
		name := "cleanup succeeds"
		if cleanupFailure {
			name = "cleanup fails"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			removed := false
			var cleanupContext context.Context
			client := &testUploadedAttachmentObject{
				presign: func(received context.Context, key string) (string, error) {
					require.Equal(t, ctx, received)
					require.Equal(t, "assets/unique-object", key)
					cancel()
					return "", presignErr
				},
				remove: func(received context.Context, key string) error {
					cleanupContext = received
					require.NoError(t, received.Err(), "request cancellation must not cancel cleanup")
					require.Equal(t, "assets/unique-object", key)
					deadline, hasDeadline := received.Deadline()
					require.True(t, hasDeadline)
					require.Positive(t, time.Until(deadline))
					require.LessOrEqual(t, time.Until(deadline), 30*time.Second)
					removed = true
					if cleanupFailure {
						return errors.New("storage temporarily unavailable")
					}
					return nil
				},
			}
			url, err := presignAttachmentObject(ctx, client, "assets/unique-object")
			require.Empty(t, url)
			require.ErrorIs(t, err, presignErr)
			require.True(t, removed)
			require.ErrorIs(t, cleanupContext.Err(), context.Canceled)
		})
	}
}

func TestAttachmentPresignSuccessKeepsObject(t *testing.T) {
	client := &testUploadedAttachmentObject{
		presign: func(context.Context, string) (string, error) { return "https://storage.example/object", nil },
		remove: func(context.Context, string) error {
			t.Fatal("successfully referenced objects must not be deleted")
			return nil
		},
	}
	url, err := presignAttachmentObject(context.Background(), client, "assets/unique-object")
	require.NoError(t, err)
	require.Equal(t, "https://storage.example/object", url)
}

func TestS3ConcurrentAttachmentUIDDoesNotOverwriteOrDeleteWinner(t *testing.T) {
	for _, distinctUsers := range []bool{false, true} {
		name := "same user"
		if distinctUsers {
			name = "two users"
		}
		t.Run(name, func(t *testing.T) {
			s := newIntegrationService(t)
			owner, ctx := uploadTestOwner(t, s)
			otherCtx := ctx
			if distinctUsers {
				other, err := s.Store.CreateUser(context.Background(), &store.User{Username: "s3-other", Role: store.RoleUser})
				require.NoError(t, err)
				otherCtx = userCtx(context.Background(), other.ID)
			}
			var mu sync.Mutex
			objects := map[string][]byte{}
			putKeys := []string{}
			deleteKeys := []string{}
			putReceived := make(chan struct{}, 2)
			releasePuts := make(chan struct{})
			var releaseOnce sync.Once
			release := func() { releaseOnce.Do(func() { close(releasePuts) }) }
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodPut:
					body, err := io.ReadAll(r.Body)
					if err != nil {
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					mu.Lock()
					objects[r.URL.Path] = body
					putKeys = append(putKeys, r.URL.Path)
					mu.Unlock()
					putReceived <- struct{}{}
					<-releasePuts
					w.Header().Set("ETag", `"test-object"`)
					w.WriteHeader(http.StatusOK)
				case http.MethodDelete:
					mu.Lock()
					delete(objects, r.URL.Path)
					deleteKeys = append(deleteKeys, r.URL.Path)
					mu.Unlock()
					w.WriteHeader(http.StatusNoContent)
				default:
					w.WriteHeader(http.StatusMethodNotAllowed)
				}
			}))
			t.Cleanup(endpoint.Close)
			t.Cleanup(release)
			_, err := s.Store.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
				Key: storepb.InstanceSettingKey_STORAGE,
				Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{
					StorageType: storepb.InstanceStorageSetting_S3, FilepathTemplate: "assets/{filename}",
					S3Config: &storepb.StorageS3Config{Endpoint: endpoint.URL, Region: "us-east-1", Bucket: "test-bucket", AccessKeyId: "test-id", AccessKeySecret: "test-secret", UsePathStyle: true},
				}},
			})
			require.NoError(t, err)
			const uid = "same-attachment-uid"
			contexts := []context.Context{ctx, otherCtx}
			prepared := make([]*store.Attachment, 2)
			for i, requestCtx := range contexts {
				prepared[i], err = s.prepareAttachment(requestCtx, &v1pb.CreateAttachmentRequest{
					AttachmentId: uid, Attachment: &v1pb.Attachment{Filename: "same.txt", Type: "text/plain"},
				})
				require.NoError(t, err)
				prepared[i].Size = 1
			}
			type result struct {
				index int
				err   error
			}
			results := make(chan result, 2)
			for i, requestCtx := range contexts {
				go func() {
					_, err := s.processAndSaveAttachment(requestCtx, prepared[i], bytes.NewReader([]byte{byte('a' + i)}))
					results <- result{index: i, err: err}
				}()
			}
			for range 2 {
				select {
				case <-putReceived:
				case <-time.After(5 * time.Second):
					t.Fatal("concurrent uploads did not reach S3")
				}
			}
			release()
			winner := -1
			failures := 0
			for range 2 {
				select {
				case got := <-results:
					if got.err == nil {
						require.Equal(t, -1, winner, "only one attachment UID may be persisted")
						winner = got.index
					} else {
						failures++
					}
				case <-time.After(5 * time.Second):
					t.Fatal("concurrent uploads did not finish")
				}
			}
			require.NotEqual(t, -1, winner)
			require.Equal(t, 1, failures)
			mu.Lock()
			defer mu.Unlock()
			require.Len(t, putKeys, 2)
			require.NotEqual(t, putKeys[0], putKeys[1], "client-controlled UID must not choose the S3 key")
			require.Len(t, deleteKeys, 1)
			require.Len(t, objects, 1)
			for _, body := range objects {
				require.Equal(t, []byte{byte('a' + winner)}, body)
			}
			stored, err := s.Store.GetAttachment(store.WithoutSpace(ctx), &store.FindAttachment{UID: stringPointer(uid)})
			require.NoError(t, err)
			require.NotNil(t, stored)
			require.Equal(t, prepared[winner].CreatorID, stored.CreatorID)
			if !distinctUsers {
				require.Equal(t, owner.ID, stored.CreatorID)
			}
		})
	}
}
