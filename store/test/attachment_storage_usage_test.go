package test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/store"
)

func TestAttachmentStorageUsageAcrossSpaces(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, s.Close()) })
	size, err := s.GetAttachmentStorageUsage(ctx, 101)
	require.NoError(t, err)
	require.Zero(t, size)
	first, err := s.CreateAttachment(store.WithSpace(ctx, ""), &store.Attachment{UID: "usage-default", CreatorID: 101, Size: 7})
	require.NoError(t, err)
	_, err = s.CreateAttachment(store.WithSpace(ctx, "work"), &store.Attachment{UID: "usage-work", CreatorID: 101, Size: 3000000000})
	require.NoError(t, err)
	_, err = s.CreateAttachment(ctx, &store.Attachment{UID: "usage-other", CreatorID: 102, Size: 99})
	require.NoError(t, err)
	size, err = s.GetAttachmentStorageUsage(store.WithSpace(ctx, "work"), 101)
	require.NoError(t, err)
	require.Equal(t, int64(3000000007), size)
	require.NoError(t, s.DeleteAttachment(store.WithSpace(ctx, ""), &store.DeleteAttachment{ID: first.ID}))
	size, err = s.GetAttachmentStorageUsage(ctx, 101)
	require.NoError(t, err)
	require.Equal(t, int64(3000000000), size)
}
