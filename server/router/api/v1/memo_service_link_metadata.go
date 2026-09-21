package v1

import (
	"context"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

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
	if s.Store != nil {
		cached, err := s.Store.GetLinkMetadata(ctx, url)
		if err != nil {
			return nil, status.Error(codes.Internal, "failed to read link preview")
		}
		if cached != nil {
			return linkMetadataFromStore(cached), nil
		}
	}
	result, err := getLinkMetadata(url)
	if err != nil {
		return nil, err
	}
	if s.Store != nil && strings.TrimSpace(result.Title) != "" {
		if err := s.Store.SaveLinkMetadata(ctx, &store.LinkMetadata{URL: url, Title: result.Title, Description: result.Description, Image: result.Image}); err != nil {
			return nil, status.Error(codes.Internal, "failed to save link preview")
		}
		cached, err := s.Store.GetLinkMetadata(ctx, url)
		if err != nil {
			return nil, status.Error(codes.Internal, "failed to read link preview")
		}
		if cached != nil {
			return linkMetadataFromStore(cached), nil
		}
	}
	return result, nil
}

func linkMetadataFromStore(value *store.LinkMetadata) *v1pb.LinkMetadata {
	return &v1pb.LinkMetadata{Url: value.URL, Title: value.Title, Description: value.Description, Image: value.Image}
}
