package v1

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/usememos/memos/internal/filter"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

const maxMemoCaptureBytes = 1024 * 1024

var xStatusPath = regexp.MustCompile(`^/(?:[A-Za-z0-9_]{1,15}|i/web)/status/([1-9][0-9]{0,23})/?$`)

func validateMemoCapture(capture *v1pb.MemoCapture) error {
	if capture == nil {
		return nil
	}
	if capture.Kind != "STAR" && capture.Kind != "PICK_UP" {
		return status.Errorf(codes.InvalidArgument, "capture kind must be STAR or PICK_UP")
	}
	if capture.Platform != "X" && capture.Platform != "WEB" {
		return status.Errorf(codes.InvalidArgument, "capture platform must be WEB or X")
	}
	if capture.Kind == "PICK_UP" && capture.Platform != "X" {
		return status.Errorf(codes.InvalidArgument, "PICK_UP requires platform X")
	}
	if !validCaptureSourceURL(capture.SourceUrl) || len(capture.SourceId) > 128 {
		return status.Errorf(codes.InvalidArgument, "capture requires a valid HTTP(S) source URL")
	}
	if capture.Platform == "X" && !validXStatusURL(capture.SourceUrl, capture.SourceId) {
		return status.Errorf(codes.InvalidArgument, "capture source URL must identify its X status ID")
	}
	if len(capture.Comment) > 64*1024 || len(capture.Context) > 64*1024 {
		return status.Errorf(codes.InvalidArgument, "capture comment or context exceeds 64 KiB")
	}
	if len(capture.Posts) > 32 || (capture.Kind == "PICK_UP" && len(capture.Posts) == 0) {
		return status.Errorf(codes.InvalidArgument, "capture supports up to 32 posts; PICK_UP requires at least one")
	}
	seen := make(map[string]bool, len(capture.Posts))
	for _, post := range capture.Posts {
		if post == nil || !validXStatusURL(post.Url, post.Id) {
			return status.Errorf(codes.InvalidArgument, "capture post URL must identify its X status ID")
		}
		if seen[post.Id] {
			return status.Errorf(codes.InvalidArgument, "capture contains duplicate post IDs")
		}
		seen[post.Id] = true
		if len(post.Content) > 128*1024 || len(post.Author) > 128 || len(post.AuthorName) > 1024 || len(post.Images) > 16 {
			return status.Errorf(codes.InvalidArgument, "capture post exceeds its size limit")
		}
		if post.PublishedAt != "" {
			if _, err := time.Parse(time.RFC3339Nano, post.PublishedAt); err != nil {
				return status.Errorf(codes.InvalidArgument, "capture publication time must be RFC 3339")
			}
		}
		for _, imageURL := range post.Images {
			parsed, err := url.Parse(imageURL)
			if err != nil || len(imageURL) > 4096 || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
				return status.Errorf(codes.InvalidArgument, "capture images must have absolute HTTPS URLs")
			}
		}
	}
	if capture.Kind == "PICK_UP" && !seen[capture.SourceId] {
		return status.Errorf(codes.InvalidArgument, "capture must include the selected source post")
	}
	encoded, err := protojson.Marshal(capture)
	if err != nil || len(encoded) > maxMemoCaptureBytes {
		return status.Errorf(codes.InvalidArgument, "capture exceeds 1 MiB")
	}
	return nil
}

func validCaptureSourceURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	return err == nil && len(rawURL) <= 4096 && (parsed.Scheme == "https" || parsed.Scheme == "http") && parsed.Hostname() != "" && parsed.User == nil
}

func validXStatusURL(rawURL, id string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil || len(rawURL) > 512 || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.twitter.com":
	default:
		return false
	}
	match := xStatusPath.FindStringSubmatch(parsed.EscapedPath())
	return len(match) == 2 && match[1] == id
}

// Capture metadata is private even when its memo body is shared publicly.
func scopeMemoCaptureFilter(ctx context.Context, expression string, find *store.FindMemo, user *store.User) error {
	engine, err := filter.DefaultEngine()
	if err != nil {
		return status.Errorf(codes.Internal, "failed to load memo filter")
	}
	program, err := engine.Compile(ctx, expression)
	if err != nil {
		return status.Errorf(codes.InvalidArgument, "invalid filter: %v", err)
	}
	if !program.ReferencesField("has_capture", "capture_source_id", "capture_kind", "capture_source_url") {
		return nil
	}
	if user == nil {
		return status.Errorf(codes.Unauthenticated, "capture history requires authentication")
	}
	find.CreatorID = &user.ID
	return nil
}

func convertMemoCaptureToStore(capture *v1pb.MemoCapture) *storepb.MemoCapture {
	if capture == nil {
		return nil
	}
	result := &storepb.MemoCapture{
		Kind: capture.Kind, Platform: capture.Platform, SourceUrl: capture.SourceUrl, SourceId: capture.SourceId,
		Comment: capture.Comment, Context: capture.Context,
	}
	for _, post := range capture.Posts {
		result.Posts = append(result.Posts, &storepb.MemoCapture_Post{
			Id: post.Id, Url: post.Url, Author: post.Author, AuthorName: post.AuthorName,
			Content: post.Content, PublishedAt: post.PublishedAt, Images: append([]string(nil), post.Images...),
		})
	}
	return result
}

func convertMemoCaptureFromStore(capture *storepb.MemoCapture) *v1pb.MemoCapture {
	if capture == nil {
		return nil
	}
	result := &v1pb.MemoCapture{
		Kind: capture.Kind, Platform: capture.Platform, SourceUrl: capture.SourceUrl, SourceId: capture.SourceId,
		Comment: capture.Comment, Context: capture.Context,
	}
	for _, post := range capture.Posts {
		result.Posts = append(result.Posts, &v1pb.MemoCapture_Post{
			Id: post.Id, Url: post.Url, Author: post.Author, AuthorName: post.AuthorName,
			Content: post.Content, PublishedAt: post.PublishedAt, Images: append([]string(nil), post.Images...),
		})
	}
	return result
}
