package v1

import (
	"context"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/usememos/memos/internal/httpgetter"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

var fetchHTMLMetaWithContext = httpgetter.GetHTMLMetaWithContext

// GetLinkMetadata gets metadata for a link.
func (s *APIV1Service) GetLinkMetadata(ctx context.Context, request *v1pb.GetLinkMetadataRequest) (*v1pb.LinkMetadata, error) {
	return s.cachedLinkMetadata(ctx, request.GetUrl())
}

// BatchGetLinkMetadata gets metadata for links.
func (s *APIV1Service) BatchGetLinkMetadata(ctx context.Context, request *v1pb.BatchGetLinkMetadataRequest) (*v1pb.BatchGetLinkMetadataResponse, error) {
	if len(request.Urls) == 0 {
		return nil, status.Errorf(codes.InvalidArgument, "urls are required")
	}
	if len(request.Urls) > maxBatchGetLinkMetadata {
		return nil, status.Errorf(codes.InvalidArgument, "too many urls (max %d)", maxBatchGetLinkMetadata)
	}

	linkMetadata := make([]*v1pb.LinkMetadata, 0, len(request.Urls))
	for _, url := range request.Urls {
		metadata, err := s.cachedLinkMetadata(ctx, url)
		if err != nil {
			return nil, err
		}
		linkMetadata = append(linkMetadata, metadata)
	}

	return &v1pb.BatchGetLinkMetadataResponse{
		LinkMetadata: linkMetadata,
	}, nil
}

func getLinkMetadata(inputURL string) (*v1pb.LinkMetadata, error) {
	url := strings.TrimSpace(inputURL)
	if url == "" {
		return nil, status.Errorf(codes.InvalidArgument, "url is required")
	}
	htmlMeta, err := fetchHTMLMeta(url)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "failed to fetch link metadata: %v", err)
	}

	return &v1pb.LinkMetadata{
		Url:         inputURL,
		Title:       htmlMeta.Title,
		Description: htmlMeta.Description,
		Image:       htmlMeta.Image,
	}, nil
}

func (s *APIV1Service) cachedLinkMetadata(ctx context.Context, input string) (*v1pb.LinkMetadata, error) {
	url := strings.TrimSpace(input)
	if url == "" {
		return nil, status.Error(codes.InvalidArgument, "url is required")
	}
	if s.Store == nil {
		return getLinkMetadata(url)
	}
	result, err := s.Store.FetchLinkMetadata(ctx, url, func(ctx context.Context, url string) (*store.LinkMetadata, error) {
		meta, err := fetchHTMLMetaWithContext(ctx, url)
		if err != nil || meta == nil {
			return nil, err
		}
		return &store.LinkMetadata{URL: url, Title: meta.Title, Description: meta.Description, Image: meta.Image}, nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		return nil, status.Errorf(codes.Unavailable, "failed to fetch link preview: %v", err)
	}
	return linkMetadataFromStore(result), nil
}

func linkMetadataFromStore(value *store.LinkMetadata) *v1pb.LinkMetadata {
	return &v1pb.LinkMetadata{Url: value.URL, Title: value.Title, Description: value.Description, Image: value.Image}
}
