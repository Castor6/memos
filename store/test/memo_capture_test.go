package test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func TestMemoCaptureRoundTripAndFilters(t *testing.T) {
	ctx := context.Background()
	ts := NewTestingStore(ctx, t)
	defer ts.Close()
	user, err := createTestingHostUser(ctx, ts)
	require.NoError(t, err)
	capture := &storepb.MemoCapture{
		Kind: "PICK_UP", Platform: "X", SourceId: "123", SourceUrl: "https://x.com/reader/status/123", Comment: "My reply", Context: "Background",
		Posts: []*storepb.MemoCapture_Post{{Id: "123", Url: "https://x.com/reader/status/123", Content: "My reply", Images: []string{"https://pbs.twimg.com/media/example.jpg"}}},
	}
	memo, err := ts.CreateMemo(ctx, &store.Memo{UID: "capture-test", CreatorID: user.ID, Content: "Body", Visibility: store.Private, Payload: &storepb.MemoPayload{Capture: capture}})
	require.NoError(t, err)
	_, err = ts.CreateMemo(ctx, &store.Memo{UID: "ordinary-test", CreatorID: user.ID, Content: "Ordinary body", Visibility: store.Private})
	require.NoError(t, err)
	for _, expression := range []string{
		`has_capture`,
		`has_capture == true`,
		`capture_source_id == "123" && capture_kind == "PICK_UP"`,
		`capture_source_url == "https://x.com/reader/status/123"`,
	} {
		memos, err := ts.ListMemos(ctx, &store.FindMemo{Filters: []string{expression}})
		require.NoError(t, err, expression)
		require.Len(t, memos, 1)
		require.Equal(t, memo.UID, memos[0].UID)
		require.True(t, proto.Equal(capture, memos[0].Payload.Capture))
	}
	for _, expression := range []string{`!has_capture`, `has_capture == false`, `has_capture != true`} {
		memos, err := ts.ListMemos(ctx, &store.FindMemo{Filters: []string{expression}})
		require.NoError(t, err, expression)
		require.Len(t, memos, 1)
		require.Equal(t, "ordinary-test", memos[0].UID)
	}
}
