package test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
	"github.com/usememos/memos/store/db"
)

func createMutationAttachment(t *testing.T, ts *store.Store, memo *store.Memo, index int) (*store.Attachment, string) {
	t.Helper()
	reference := fmt.Sprintf("mutation-%d.txt", index)
	path := filepath.Join(ts.GetDataDir(), reference)
	require.NoError(t, os.WriteFile(path, []byte("original file"), 0600))
	attachment, err := ts.CreateAttachment(context.Background(), &store.Attachment{
		UID: fmt.Sprintf("mutation-file-%d", index), CreatorID: memo.CreatorID, MemoID: &memo.ID,
		Filename: reference, StorageType: storepb.AttachmentStorageType_LOCAL, Reference: reference,
	})
	require.NoError(t, err)
	return attachment, path
}

func cleanupJobCount(t *testing.T, ts *store.Store) int {
	t.Helper()
	var count int
	require.NoError(t, ts.GetDriver().GetDB().QueryRow("SELECT COUNT(*) FROM attachment_cleanup").Scan(&count))
	return count
}

func TestMemoMutationRollbackPreservesFilesAndAssociations(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, ts.Close()) })
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	memo, err := ts.CreateMemo(ctx, &store.Memo{UID: "mutation-memo", CreatorID: user.ID, Content: "before", Visibility: store.Private})
	require.NoError(t, err)
	target, err := ts.CreateMemo(ctx, &store.Memo{UID: "mutation-target", CreatorID: user.ID, Visibility: store.Private})
	require.NoError(t, err)
	_, err = ts.UpsertMemoRelation(ctx, &store.MemoRelation{MemoID: memo.ID, RelatedMemoID: target.ID, Type: store.MemoRelationReference})
	require.NoError(t, err)
	attachment, path := createMutationAttachment(t, ts, memo, 1)
	ids, relations := []int32{}, []*store.MemoRelation{}
	content := "after\n\nhttps://example.com/atomic-link"
	mutation := &store.MemoMutation{Update: &store.UpdateMemo{ID: memo.ID, Content: &content}, AttachmentIDs: &ids, Relations: &relations, ActorID: user.ID}
	err = ts.ApplyMemoMutation(store.WithMemoMutationFailpoint(ctx), mutation)
	require.ErrorContains(t, err, "failpoint")
	saved, err := ts.GetMemo(ctx, &store.FindMemo{ID: &memo.ID})
	require.NoError(t, err)
	require.Equal(t, "before", saved.Content)
	kept, err := ts.GetAttachment(ctx, &store.FindAttachment{ID: &attachment.ID})
	require.NoError(t, err)
	require.NotNil(t, kept)
	links, err := ts.ListMemoRelations(ctx, &store.FindMemoRelation{MemoID: &memo.ID})
	require.NoError(t, err)
	require.Len(t, links, 1)
	require.FileExists(t, path)
	require.Zero(t, cleanupJobCount(t, ts))
	var queuedLinks int
	require.NoError(t, ts.GetDriver().GetDB().QueryRow("SELECT COUNT(*) FROM link_metadata_job").Scan(&queuedLinks))
	require.Zero(t, queuedLinks)

	require.NoError(t, ts.ApplyMemoMutation(ctx, mutation))
	require.NoError(t, ts.GetDriver().GetDB().QueryRow("SELECT COUNT(*) FROM link_metadata_job").Scan(&queuedLinks))
	require.Equal(t, 1, queuedLinks)
	saved, err = ts.GetMemo(ctx, &store.FindMemo{ID: &memo.ID})
	require.NoError(t, err)
	require.Equal(t, content, saved.Content)
	kept, err = ts.GetAttachment(ctx, &store.FindAttachment{ID: &attachment.ID})
	require.NoError(t, err)
	require.Nil(t, kept)
	links, err = ts.ListMemoRelations(ctx, &store.FindMemoRelation{MemoID: &memo.ID})
	require.NoError(t, err)
	require.Empty(t, links)
	require.FileExists(t, path)
	require.Equal(t, 1, cleanupJobCount(t, ts))
}

func TestMemoAttachmentsBeyondDefaultPageAndDeleteRollback(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, ts.Close()) })
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	memo, err := ts.CreateMemo(ctx, &store.Memo{UID: "many-attachments", CreatorID: user.ID, Visibility: store.Private})
	require.NoError(t, err)
	paths := make([]string, 0, 101)
	for i := range 101 {
		_, path := createMutationAttachment(t, ts, memo, i)
		paths = append(paths, path)
	}
	attachments, err := ts.ListAttachments(ctx, &store.FindAttachment{MemoID: &memo.ID})
	require.NoError(t, err)
	require.Len(t, attachments, 101)
	attachments, err = ts.ListAttachments(ctx, &store.FindAttachment{MemoID: &memo.ID, GetBlob: true})
	require.NoError(t, err)
	require.Len(t, attachments, 10)
	require.Error(t, ts.DeleteMemo(store.WithMemoMutationFailpoint(ctx), &store.DeleteMemo{ID: memo.ID}))
	attachments, err = ts.ListAttachments(ctx, &store.FindAttachment{MemoID: &memo.ID})
	require.NoError(t, err)
	require.Len(t, attachments, 101)
	require.Zero(t, cleanupJobCount(t, ts))
	keep := make([]int32, 0, 100)
	for _, attachment := range attachments[:100] {
		keep = append(keep, attachment.ID)
	}
	require.NoError(t, ts.ApplyMemoMutation(ctx, &store.MemoMutation{Update: &store.UpdateMemo{ID: memo.ID}, AttachmentIDs: &keep, ActorID: user.ID}))
	remaining, err := ts.ListAttachments(ctx, &store.FindAttachment{MemoID: &memo.ID})
	require.NoError(t, err)
	require.Len(t, remaining, 100)
	require.Equal(t, 1, cleanupJobCount(t, ts))
	require.NoError(t, ts.DeleteMemo(ctx, &store.DeleteMemo{ID: memo.ID}))
	attachments, err = ts.ListAttachments(ctx, &store.FindAttachment{MemoID: &memo.ID})
	require.NoError(t, err)
	require.Empty(t, attachments)
	require.Equal(t, 101, cleanupJobCount(t, ts))
	require.NoError(t, ts.ProcessAttachmentCleanup(ctx, time.Now().Unix(), 100))
	require.Equal(t, 1, cleanupJobCount(t, ts))
	require.NoError(t, ts.ProcessAttachmentCleanup(ctx, time.Now().Unix(), 100))
	require.Zero(t, cleanupJobCount(t, ts))
	for _, path := range paths {
		require.NoFileExists(t, path)
	}
}

func TestAttachmentCleanupSurvivesRestartAndRetriesIdempotently(t *testing.T) {
	ctx := context.Background()
	profile := getTestingProfileForDriver(t, getDriverFromEnv())
	driver, err := db.NewDBDriver(profile)
	require.NoError(t, err)
	ts := store.New(driver, profile)
	require.NoError(t, ts.Migrate(ctx))
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	memo, err := ts.CreateMemo(ctx, &store.Memo{UID: "cleanup-retry", CreatorID: user.ID, Visibility: store.Private})
	require.NoError(t, err)
	_, path := createMutationAttachment(t, ts, memo, 1)
	ids := []int32{}
	require.NoError(t, ts.ApplyMemoMutation(ctx, &store.MemoMutation{Update: &store.UpdateMemo{ID: memo.ID}, AttachmentIDs: &ids, ActorID: user.ID}))
	now := time.Now().Unix()
	require.NoError(t, ts.ProcessAttachmentCleanup(store.WithDeleteAttachmentStorageFailpoint(ctx), now, 100))
	require.Equal(t, 1, cleanupJobCount(t, ts))
	require.FileExists(t, path)
	var attempts int
	var nextAt int64
	require.NoError(t, ts.GetDriver().GetDB().QueryRow("SELECT attempts, next_at FROM attachment_cleanup").Scan(&attempts, &nextAt))
	require.Equal(t, 1, attempts)
	require.Greater(t, nextAt, now)
	require.NoError(t, ts.Close())
	driver, err = db.NewDBDriver(profile)
	require.NoError(t, err)
	ts = store.New(driver, profile)
	t.Cleanup(func() { require.NoError(t, ts.Close()) })
	require.NoError(t, ts.ProcessAttachmentCleanup(ctx, now, 100))
	require.FileExists(t, path)
	// A process can stop after removing the file and before acknowledging the job.
	require.NoError(t, os.Remove(path))
	require.NoError(t, ts.ProcessAttachmentCleanup(ctx, nextAt, 100))
	require.Zero(t, cleanupJobCount(t, ts))
	require.NoError(t, ts.ProcessAttachmentCleanup(ctx, nextAt, 100))
}

func TestAttachmentCleanupSnapshotsS3Configuration(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, ts.Close()) })
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	memo, err := ts.CreateMemo(ctx, &store.Memo{UID: "cleanup-s3", CreatorID: user.ID, Visibility: store.Private})
	require.NoError(t, err)
	config := &storepb.StorageS3Config{Bucket: "original-bucket", Endpoint: "https://s3.example.com"}
	_, err = ts.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
		Key:   storepb.InstanceSettingKey_STORAGE,
		Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{S3Config: config}},
	})
	require.NoError(t, err)
	_, err = ts.CreateAttachment(ctx, &store.Attachment{
		UID: "cleanup-s3-object", CreatorID: user.ID, MemoID: &memo.ID, StorageType: storepb.AttachmentStorageType_S3,
		Payload: &storepb.AttachmentPayload{Payload: &storepb.AttachmentPayload_S3Object_{S3Object: &storepb.AttachmentPayload_S3Object{Key: "original-key"}}},
	})
	require.NoError(t, err)
	require.NoError(t, ts.DeleteMemo(ctx, &store.DeleteMemo{ID: memo.ID}))
	var data string
	require.NoError(t, ts.GetDriver().GetDB().QueryRow("SELECT payload FROM attachment_cleanup").Scan(&data))
	var snapshot struct{ Payload json.RawMessage }
	require.NoError(t, json.Unmarshal([]byte(data), &snapshot))
	payload := &storepb.AttachmentPayload{}
	require.NoError(t, protojson.Unmarshal(snapshot.Payload, payload))
	require.Equal(t, "original-key", payload.GetS3Object().Key)
	require.Equal(t, config.Bucket, payload.GetS3Object().S3Config.Bucket)
	require.Equal(t, config.Endpoint, payload.GetS3Object().S3Config.Endpoint)
}

func TestMemoAttachmentCleanupLocksAgainstConcurrentMove(t *testing.T) {
	for _, deleteMemo := range []bool{false, true} {
		t.Run(fmt.Sprintf("delete_memo_%t", deleteMemo), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			ts := NewTestingStore(ctx, t)
			defer ts.Close()
			user, err := createTestingHostUser(ctx, ts)
			require.NoError(t, err)
			source, err := ts.CreateMemo(ctx, &store.Memo{UID: "move-source", CreatorID: user.ID, Visibility: store.Private})
			require.NoError(t, err)
			target, err := ts.CreateMemo(ctx, &store.Memo{UID: "move-target", CreatorID: user.ID, Visibility: store.Private})
			require.NoError(t, err)
			attachment, path := createMutationAttachment(t, ts, source, 1)
			snapshotReady, resumeSnapshot := make(chan struct{}), make(chan struct{})
			release := sync.OnceFunc(func() { close(resumeSnapshot) })
			defer release()
			deleting := store.WithMemoAttachmentSnapshotHook(ctx, func() {
				close(snapshotReady)
				select {
				case <-resumeSnapshot:
				case <-ctx.Done():
				}
			})
			deleteResult := make(chan error, 1)
			go func() {
				if deleteMemo {
					deleteResult <- ts.DeleteMemo(deleting, &store.DeleteMemo{ID: source.ID})
				} else {
					empty := []int32{}
					deleteResult <- ts.ApplyMemoMutation(deleting, &store.MemoMutation{Update: &store.UpdateMemo{ID: source.ID}, AttachmentIDs: &empty, ActorID: user.ID})
				}
			}()
			select {
			case <-snapshotReady:
			case <-ctx.Done():
				t.Fatal("timed out waiting for attachment snapshot")
			}
			moveResult := make(chan error, 1)
			go func() {
				ids := []int32{attachment.ID}
				moveResult <- ts.ApplyMemoMutation(ctx, &store.MemoMutation{Update: &store.UpdateMemo{ID: target.ID}, AttachmentIDs: &ids, ActorID: user.ID})
			}()
			// Moving must wait until the transaction holding the cleanup snapshot finishes.
			select {
			case err := <-moveResult:
				t.Errorf("attachment moved before the cleanup transaction finished: %v", err)
				moveResult <- err
			case <-time.After(200 * time.Millisecond):
			}
			release()
			require.NoError(t, <-deleteResult)
			require.Error(t, <-moveResult)
			require.NoError(t, ts.ProcessAttachmentCleanup(ctx, time.Now().Unix(), 100))
			remaining, err := ts.GetAttachment(ctx, &store.FindAttachment{ID: &attachment.ID})
			require.NoError(t, err)
			require.Nil(t, remaining)
			require.NoFileExists(t, path)
		})
	}
}
