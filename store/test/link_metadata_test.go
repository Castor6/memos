package test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/store"
)

func TestLinkMetadataKeepsFirstSnapshot(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	defer s.Close()
	url := "https://example.com/中文?case=A"
	missing, err := s.GetLinkMetadata(ctx, url)
	require.NoError(t, err)
	require.Nil(t, missing)
	original := &store.LinkMetadata{URL: url, Title: "历史标题", Description: "历史摘要", Image: "https://example.com/image.png"}
	require.NoError(t, s.SaveLinkMetadata(ctx, original))
	require.NoError(t, s.SaveLinkMetadata(ctx, &store.LinkMetadata{URL: url, Title: "新标题"}))
	saved, err := s.GetLinkMetadata(ctx, url)
	require.NoError(t, err)
	require.Equal(t, original, saved)
	other, err := s.GetLinkMetadata(ctx, "https://example.com/中文?case=a")
	require.NoError(t, err)
	require.Nil(t, other)
}
