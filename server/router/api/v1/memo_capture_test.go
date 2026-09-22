package v1

import (
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
)

func TestValidateMemoCapture(t *testing.T) {
	valid := &v1pb.MemoCapture{
		Kind: "PICK_UP", Platform: "X", SourceId: "2102063913437376776", SourceUrl: "https://x.com/canlantiancai/status/2102063913437376776",
		Comment: "My original reply", Context: "Why I replied",
		Posts: []*v1pb.MemoCapture_Post{{
			Id: "2102063913437376776", Url: "https://x.com/canlantiancai/status/2102063913437376776",
			Author: "canlantiancai", Content: "My original reply", PublishedAt: "2026-09-22T01:02:03.123Z", Images: []string{"https://pbs.twimg.com/media/example.jpg"},
		}},
	}
	require.NoError(t, validateMemoCapture(valid))
	require.NoError(t, validateMemoCapture(nil))
	require.NoError(t, validateMemoCapture(&v1pb.MemoCapture{Kind: "STAR", Platform: "WEB", SourceUrl: "https://example.com/article?ref=test#section", Comment: "My thoughts"}))
	for name, mutate := range map[string]func(*v1pb.MemoCapture){
		"unknown kind":       func(c *v1pb.MemoCapture) { c.Kind = "CLIP" },
		"wrong platform":     func(c *v1pb.MemoCapture) { c.Platform = "WEB" },
		"spoofed domain":     func(c *v1pb.MemoCapture) { c.SourceUrl = "https://x.com.example.org/user/status/2102063913437376776" },
		"source mismatch":    func(c *v1pb.MemoCapture) { c.SourceId = "123" },
		"noncanonical query": func(c *v1pb.MemoCapture) { c.SourceUrl += "?s=20" },
		"empty posts":        func(c *v1pb.MemoCapture) { c.Posts = nil },
		"nil post":           func(c *v1pb.MemoCapture) { c.Posts = []*v1pb.MemoCapture_Post{nil} },
		"duplicate post":     func(c *v1pb.MemoCapture) { c.Posts = append(c.Posts, c.Posts[0]) },
		"too many posts":     func(c *v1pb.MemoCapture) { c.Posts = make([]*v1pb.MemoCapture_Post, 33) },
		"long comment":       func(c *v1pb.MemoCapture) { c.Comment = strings.Repeat("x", 64*1024+1) },
		"long context":       func(c *v1pb.MemoCapture) { c.Context = strings.Repeat("x", 64*1024+1) },
		"long post":          func(c *v1pb.MemoCapture) { c.Posts[0].Content = strings.Repeat("x", 128*1024+1) },
		"invalid timestamp":  func(c *v1pb.MemoCapture) { c.Posts[0].PublishedAt = "yesterday" },
		"mismatched comment": func(c *v1pb.MemoCapture) { c.Comment = "Different reply" },
		"mismatched URL": func(c *v1pb.MemoCapture) {
			c.Posts[0].Url = "https://twitter.com/canlantiancai/status/2102063913437376776"
		},
		"missing author": func(c *v1pb.MemoCapture) { c.Posts[0].Author = "" },
		"wrong author":   func(c *v1pb.MemoCapture) { c.Posts[0].Author = "someone_else" },
		"unsafe image":   func(c *v1pb.MemoCapture) { c.Posts[0].Images = []string{"javascript:alert(1)"} },
		"missing source": func(c *v1pb.MemoCapture) { c.Posts[0].Id = "123"; c.Posts[0].Url = "https://x.com/user/status/123" },
	} {
		t.Run(name, func(t *testing.T) {
			capture := proto.CloneOf(valid)
			mutate(capture)
			require.Equal(t, codes.InvalidArgument, status.Code(validateMemoCapture(capture)))
		})
	}
	for _, source := range []string{"javascript:alert(1)", "file:///tmp/test", "https://user:password@example.com", "https:///missing-host"} {
		require.Error(t, validateMemoCapture(&v1pb.MemoCapture{Kind: "STAR", Platform: "WEB", SourceUrl: source}))
	}
	storeCapture := convertMemoCaptureToStore(valid)
	require.True(t, proto.Equal(valid, convertMemoCaptureFromStore(storeCapture)))
	withHandle := proto.CloneOf(valid)
	withHandle.Posts[0].Author = "@Canlantiancai"
	require.NoError(t, validateMemoCapture(withHandle))
	for _, source := range []string{"https://x.com/i/status/2102063913437376776", "https://x.com/i/web/status/2102063913437376776"} {
		withHandle.SourceUrl = source
		withHandle.Posts[0].Url = source
		require.NoError(t, validateMemoCapture(withHandle))
	}
	tooLarge := proto.CloneOf(valid)
	for i := range 9 {
		id := strconv.Itoa(i + 1)
		tooLarge.Posts = append(tooLarge.Posts, &v1pb.MemoCapture_Post{Id: id, Url: "https://x.com/reader/status/" + id, Content: strings.Repeat("x", 128*1024)})
	}
	require.Equal(t, codes.InvalidArgument, status.Code(validateMemoCapture(tooLarge)), "the total limit includes all duplicated metadata and source text")
}
