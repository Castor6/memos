package test

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func storageCacheFixture() *storepb.InstanceSetting {
	return &storepb.InstanceSetting{
		Key: storepb.InstanceSettingKey_STORAGE,
		Value: &storepb.InstanceSetting_StorageSetting{StorageSetting: &storepb.InstanceStorageSetting{
			StorageType: storepb.InstanceStorageSetting_S3,
			S3Config:    &storepb.StorageS3Config{Bucket: "shared-bucket", Endpoint: "https://storage.example.com"},
		}},
	}
}

func TestInstanceSettingCacheOwnsWriteSnapshot(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	defer ts.Close()
	stored, err := ts.UpsertInstanceSetting(ctx, storageCacheFixture())
	require.NoError(t, err)
	stored.GetStorageSetting().UploadSizeLimitMb = 999
	stored.GetStorageSetting().S3Config.Bucket = "caller-mutated"
	setting, err := ts.GetInstanceSetting(ctx, &store.FindInstanceSetting{Name: "STORAGE"})
	require.NoError(t, err)
	require.Zero(t, setting.GetStorageSetting().UploadSizeLimitMb)
	require.Equal(t, "shared-bucket", setting.GetStorageSetting().S3Config.Bucket)
}

func TestInstanceSettingCacheReturnsIndependentSnapshots(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	defer ts.Close()
	_, err := ts.UpsertInstanceSetting(ctx, storageCacheFixture())
	require.NoError(t, err)
	find := &store.FindInstanceSetting{Name: "STORAGE"}
	first, err := ts.GetInstanceSetting(ctx, find)
	require.NoError(t, err)
	second, err := ts.GetInstanceSetting(ctx, find)
	require.NoError(t, err)
	first.GetStorageSetting().S3Config.Bucket = "first-reader"
	require.Equal(t, "shared-bucket", second.GetStorageSetting().S3Config.Bucket)

	typed, err := ts.GetInstanceStorageSetting(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 30, typed.UploadSizeLimitMb)
	typed.S3Config.Bucket = "typed-reader"
	setting, err := ts.GetInstanceStorageSetting(ctx)
	require.NoError(t, err)
	require.Equal(t, "shared-bucket", setting.S3Config.Bucket)

	listed, err := ts.ListInstanceSettings(ctx, find)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	listed[0].GetStorageSetting().S3Config.Bucket = "list-reader"
	setting, err = ts.GetInstanceStorageSetting(ctx)
	require.NoError(t, err)
	require.Equal(t, "shared-bucket", setting.S3Config.Bucket)
}

func TestInstanceStorageSettingConcurrentDefaults(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	defer ts.Close()
	_, err := ts.UpsertInstanceSetting(ctx, storageCacheFixture())
	require.NoError(t, err)
	const workers = 32
	type result struct {
		err     error
		setting *storepb.InstanceStorageSetting
	}
	start := make(chan struct{})
	results := make(chan result, workers)
	var group sync.WaitGroup
	for range workers {
		group.Go(func() {
			<-start
			for range 16 {
				setting, err := ts.GetInstanceStorageSetting(ctx)
				if err != nil {
					results <- result{err: err}
					return
				}
				if setting.StorageType != storepb.InstanceStorageSetting_S3 || setting.UploadSizeLimitMb != 30 ||
					setting.FilepathTemplate != "assets/{timestamp}_{uuid}_{filename}" || setting.S3Config.Bucket != "shared-bucket" {
					results <- result{setting: setting}
					return
				}
				// Callers can modify their snapshot without racing with later defaults.
				setting.UploadSizeLimitMb = 0
				setting.FilepathTemplate = ""
				setting.S3Config.Bucket = "caller-local"
			}
			results <- result{}
		})
	}
	close(start)
	group.Wait()
	close(results)
	for result := range results {
		require.NoError(t, result.err)
		require.Nil(t, result.setting, "readers must receive complete defaults and an isolated S3 configuration")
	}
	setting, err := ts.GetInstanceStorageSetting(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 30, setting.UploadSizeLimitMb)
	require.Equal(t, "assets/{timestamp}_{uuid}_{filename}", setting.FilepathTemplate)
	require.Equal(t, "shared-bucket", setting.S3Config.Bucket)
}
