package test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestDeleteAttachmentWithCleanupIsAtomicAndRetryable(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	defer ts.Close()
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	path := filepath.Join(ts.GetDataDir(), "rollback-attachment.txt")
	require.NoError(t, os.WriteFile(path, []byte("original file"), 0600))
	attachment, err := ts.CreateAttachment(store.WithSpace(ctx, "archive-space"), &store.Attachment{
		UID: "rollback-attachment", CreatorID: user.ID, Filename: "rollback-attachment.txt",
		StorageType: storepb.AttachmentStorageType_LOCAL, Reference: path,
	})
	require.NoError(t, err)
	request := &store.DeleteAttachment{ID: attachment.ID}

	err = ts.DeleteAttachmentWithCleanup(store.WithSpace(ctx, "wrong-space"), request)
	require.ErrorContains(t, err, "outside the selected space")
	require.Zero(t, cleanupJobCount(t, ts))
	kept, err := ts.GetAttachment(ctx, &store.FindAttachment{ID: &attachment.ID})
	require.NoError(t, err)
	require.NotNil(t, kept)
	require.FileExists(t, path)

	selected := store.WithSpace(ctx, "archive-space")
	err = ts.DeleteAttachmentWithCleanup(store.WithMemoMutationFailpoint(selected), request)
	require.ErrorContains(t, err, "failpoint")
	require.Zero(t, cleanupJobCount(t, ts), "the cleanup insert must roll back with the attachment deletion")
	kept, err = ts.GetAttachment(ctx, &store.FindAttachment{ID: &attachment.ID})
	require.NoError(t, err)
	require.NotNil(t, kept)
	require.FileExists(t, path)

	require.NoError(t, ts.DeleteAttachmentWithCleanup(selected, request))
	kept, err = ts.GetAttachment(ctx, &store.FindAttachment{ID: &attachment.ID})
	require.NoError(t, err)
	require.Nil(t, kept)
	require.Equal(t, 1, cleanupJobCount(t, ts))
	require.FileExists(t, path, "physical cleanup happens only after the deletion is committed")
	require.NoError(t, ts.DeleteAttachmentWithCleanup(selected, request))
	require.Equal(t, 1, cleanupJobCount(t, ts), "repeating deletion must not duplicate its pending job")

	now := time.Now().Unix()
	require.NoError(t, ts.ProcessAttachmentCleanup(store.WithDeleteAttachmentStorageFailpoint(ctx), now, 100))
	require.Equal(t, 1, cleanupJobCount(t, ts))
	require.FileExists(t, path)
	var attempts int
	var nextAt int64
	require.NoError(t, ts.GetDriver().GetDB().QueryRow("SELECT attempts, next_at FROM attachment_cleanup").Scan(&attempts, &nextAt))
	require.Equal(t, 1, attempts)
	require.Greater(t, nextAt, now)
	require.NoError(t, ts.ProcessAttachmentCleanup(ctx, nextAt, 100))
	require.Zero(t, cleanupJobCount(t, ts))
	require.NoFileExists(t, path)
	require.NoError(t, ts.DeleteAttachmentWithCleanup(selected, request))
	require.Zero(t, cleanupJobCount(t, ts))
}

func TestDeleteAttachmentWithCleanupSnapshotsS3Configuration(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	defer ts.Close()
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	config := &storepb.StorageS3Config{Bucket: "archive-bucket", Endpoint: "https://archive.example.com"}
	_, err = ts.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
		Key: storepb.InstanceSettingKey_STORAGE,
		Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{
			S3Config: config,
		}},
	})
	require.NoError(t, err)
	attachment, err := ts.CreateAttachment(ctx, &store.Attachment{
		UID: "archive-s3-rollback", CreatorID: user.ID, StorageType: storepb.AttachmentStorageType_S3,
		Payload: &storepb.AttachmentPayload{Payload: &storepb.AttachmentPayload_S3Object_{
			S3Object: &storepb.AttachmentPayload_S3Object{Key: "archive-original-key"},
		}},
	})
	require.NoError(t, err)
	require.NoError(t, ts.DeleteAttachmentWithCleanup(ctx, &store.DeleteAttachment{ID: attachment.ID}))
	var data string
	require.NoError(t, ts.GetDriver().GetDB().QueryRow("SELECT payload FROM attachment_cleanup").Scan(&data))
	var snapshot struct{ Payload json.RawMessage }
	require.NoError(t, json.Unmarshal([]byte(data), &snapshot))
	payload := &storepb.AttachmentPayload{}
	require.NoError(t, protojson.Unmarshal(snapshot.Payload, payload))
	require.Equal(t, "archive-original-key", payload.GetS3Object().Key)
	require.Equal(t, config.Bucket, payload.GetS3Object().S3Config.Bucket)
	require.Equal(t, config.Endpoint, payload.GetS3Object().S3Config.Endpoint)
}
