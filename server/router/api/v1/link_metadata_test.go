package v1

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/usememos/memos/internal/httpgetter"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

func TestGetLinkMetadata(t *testing.T) {
	originalFetchHTMLMeta := fetchHTMLMeta
	t.Cleanup(func() {
		fetchHTMLMeta = originalFetchHTMLMeta
	})

	fetchHTMLMeta = func(url string) (*httpgetter.HTMLMeta, error) {
		require.Equal(t, "https://example.com/article", url)
		return &httpgetter.HTMLMeta{
			Title:       "Example title",
			Description: "Example description",
			Image:       "https://example.com/cover.png",
		}, nil
	}

	metadata, err := (&APIV1Service{}).GetLinkMetadata(context.Background(), &v1pb.GetLinkMetadataRequest{
		Url: "https://example.com/article",
	})
	require.NoError(t, err)
	require.Equal(t, "https://example.com/article", metadata.Url)
	require.Equal(t, "Example title", metadata.Title)
	require.Equal(t, "Example description", metadata.Description)
	require.Equal(t, "https://example.com/cover.png", metadata.Image)
}

func TestGetLinkMetadataEmptyURL(t *testing.T) {
	_, err := (&APIV1Service{}).GetLinkMetadata(context.Background(), &v1pb.GetLinkMetadataRequest{})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestGetLinkMetadataInternalURL(t *testing.T) {
	_, err := (&APIV1Service{}).GetLinkMetadata(context.Background(), &v1pb.GetLinkMetadataRequest{
		Url: "http://192.168.0.1",
	})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestLinkMetadataInvalidURLsAreNotQueued(t *testing.T) {
	service := newIntegrationService(t)
	original := fetchHTMLMetaWithContext
	t.Cleanup(func() { fetchHTMLMetaWithContext = original })
	fetchHTMLMetaWithContext = func(context.Context, string) (*httpgetter.HTMLMeta, error) {
		t.Fatal("invalid URLs must be rejected before fetching")
		return nil, nil
	}
	ctx := context.Background()
	for _, url := range []string{"file:///tmp/article", "http://", "https://%", "http://127.0.0.1/article", "https://[::1]/"} {
		t.Run(url, func(t *testing.T) {
			_, err := service.GetLinkMetadata(ctx, &v1pb.GetLinkMetadataRequest{Url: url})
			require.Equal(t, codes.InvalidArgument, status.Code(err))
			_, err = service.BatchGetLinkMetadata(ctx, &v1pb.BatchGetLinkMetadataRequest{Urls: []string{url}})
			require.Equal(t, codes.InvalidArgument, status.Code(err))
		})
	}
	var jobs int
	require.NoError(t, service.Store.GetDriver().GetDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM link_metadata_job").Scan(&jobs))
	require.Zero(t, jobs)
}

func TestLinkMetadataPublicFailuresOnlyCreateTemporaryRequests(t *testing.T) {
	service := newIntegrationService(t)
	original := fetchHTMLMetaWithContext
	t.Cleanup(func() { fetchHTMLMetaWithContext = original })
	fetchHTMLMetaWithContext = func(context.Context, string) (*httpgetter.HTMLMeta, error) {
		return nil, errors.New("preview unavailable")
	}
	ctx := context.Background()
	_, err := service.GetLinkMetadata(ctx, &v1pb.GetLinkMetadataRequest{Url: "https://example.com/public-preview"})
	require.Equal(t, codes.Unavailable, status.Code(err))
	_, err = service.BatchGetLinkMetadata(ctx, &v1pb.BatchGetLinkMetadataRequest{Urls: []string{"https://example.com/public-batch-preview"}})
	require.Equal(t, codes.Unavailable, status.Code(err))
	var jobs int
	require.NoError(t, service.Store.GetDriver().GetDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM link_metadata_job WHERE expires_ts > 0").Scan(&jobs))
	require.Equal(t, 2, jobs)
	_, err = service.Store.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET next_attempt_ts = 0")
	require.NoError(t, err)
	urls, err := service.Store.ListDueLinkMetadata(ctx, 8)
	require.NoError(t, err)
	require.Empty(t, urls, "unreferenced public previews must not become background retry work")
	_, err = service.Store.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET expires_ts = 1")
	require.NoError(t, err)
	_, err = service.Store.ListDueLinkMetadata(ctx, 8)
	require.NoError(t, err)
	require.NoError(t, service.Store.GetDriver().GetDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM link_metadata_job").Scan(&jobs))
	require.Zero(t, jobs)
}

func TestBatchGetLinkMetadata(t *testing.T) {
	originalFetchHTMLMeta := fetchHTMLMeta
	t.Cleanup(func() {
		fetchHTMLMeta = originalFetchHTMLMeta
	})

	var fetchedURLs []string
	fetchHTMLMeta = func(url string) (*httpgetter.HTMLMeta, error) {
		fetchedURLs = append(fetchedURLs, url)
		return &httpgetter.HTMLMeta{
			Title:       fmt.Sprintf("Title for %s", url),
			Description: fmt.Sprintf("Description for %s", url),
			Image:       fmt.Sprintf("%s/cover.png", url),
		}, nil
	}

	response, err := (&APIV1Service{}).BatchGetLinkMetadata(context.Background(), &v1pb.BatchGetLinkMetadataRequest{
		Urls: []string{
			"https://example.com/one",
			"https://example.com/two",
		},
	})
	require.NoError(t, err)
	require.Equal(t, []string{"https://example.com/one", "https://example.com/two"}, fetchedURLs)
	require.Len(t, response.LinkMetadata, 2)
	require.Equal(t, "https://example.com/one", response.LinkMetadata[0].Url)
	require.Equal(t, "Title for https://example.com/one", response.LinkMetadata[0].Title)
	require.Equal(t, "https://example.com/two", response.LinkMetadata[1].Url)
	require.Equal(t, "Title for https://example.com/two", response.LinkMetadata[1].Title)
}

func TestBatchGetLinkMetadataEmptyURLs(t *testing.T) {
	_, err := (&APIV1Service{}).BatchGetLinkMetadata(context.Background(), &v1pb.BatchGetLinkMetadataRequest{})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestBatchGetLinkMetadataTooManyURLs(t *testing.T) {
	urls := make([]string, maxBatchGetLinkMetadata+1)
	for i := range urls {
		urls[i] = fmt.Sprintf("https://example.com/%d", i)
	}

	_, err := (&APIV1Service{}).BatchGetLinkMetadata(context.Background(), &v1pb.BatchGetLinkMetadataRequest{
		Urls: urls,
	})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestLinkMetadataUsesPersistentSnapshot(t *testing.T) {
	service := newIntegrationService(t)
	original := fetchHTMLMetaWithContext
	t.Cleanup(func() { fetchHTMLMetaWithContext = original })
	calls := 0
	fetchHTMLMetaWithContext = func(context.Context, string) (*httpgetter.HTMLMeta, error) {
		calls++
		return &httpgetter.HTMLMeta{Title: "历史标题", Description: "历史摘要"}, nil
	}
	request := &v1pb.GetLinkMetadataRequest{Url: "https://example.com/persistent"}
	first, err := service.GetLinkMetadata(context.Background(), request)
	require.NoError(t, err)
	// A new API service has no query cache from the first request.
	fresh := NewAPIV1Service(service.Secret, service.Profile, service.Store)
	second, err := fresh.GetLinkMetadata(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, first.Title, second.Title)
	require.Equal(t, first.Description, second.Description)
	require.Equal(t, 1, calls)
}

func TestLinkMetadataAPIAndWorkerShareFirstFetch(t *testing.T) {
	service := newIntegrationService(t)
	original := fetchHTMLMetaWithContext
	t.Cleanup(func() { fetchHTMLMetaWithContext = original })
	ctx := context.Background()
	for _, apiFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("api_first_%t", apiFirst), func(t *testing.T) {
			url := fmt.Sprintf("https://example.com/competition-%t", apiFirst)
			request := &v1pb.GetLinkMetadataRequest{Url: url}
			started, release := make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			fetchHTMLMetaWithContext = func(ctx context.Context, _ string) (*httpgetter.HTMLMeta, error) {
				if calls.Add(1) == 1 {
					close(started)
				}
				select {
				case <-release:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				return &httpgetter.HTMLMeta{Title: "shared title"}, nil
			}
			worker := func(ctx context.Context) error {
				_, err := service.Store.FetchLinkMetadata(ctx, url, func(ctx context.Context, url string) (*store.LinkMetadata, error) {
					meta, err := fetchHTMLMetaWithContext(ctx, url)
					if err != nil {
						return nil, err
					}
					return &store.LinkMetadata{Title: meta.Title}, nil
				})
				return err
			}
			api := func(ctx context.Context) error { _, err := service.GetLinkMetadata(ctx, request); return err }
			first, second := worker, api
			if apiFirst {
				first, second = api, worker
			}
			result := make(chan error, 2)
			go func() { result <- first(ctx) }()
			<-started
			waitCtx, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
			require.Error(t, second(waitCtx))
			cancel()
			go func() { result <- second(ctx) }()
			close(release)
			require.NoError(t, <-result)
			require.NoError(t, <-result)
			require.Equal(t, int32(1), calls.Load())
		})
	}
}
