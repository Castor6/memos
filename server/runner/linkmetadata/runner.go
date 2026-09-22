// Package linkmetadata fills durable previews independently of page views.
package linkmetadata

import (
	"context"
	"log/slog"
	"time"

	"github.com/usememos/memos/internal/httpgetter"
	"github.com/usememos/memos/store"
)

// Run drains durable preview jobs and advances a one-time historical backfill.
func Run(ctx context.Context, db *store.Store) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		runOnce(ctx, db, httpgetter.GetHTMLMetaWithContext)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runOnce(ctx context.Context, db *store.Store, fetch func(context.Context, string) (*httpgetter.HTMLMeta, error)) {
	if _, err := db.BackfillLinkMetadata(ctx, 100); err != nil {
		if ctx.Err() == nil {
			slog.Error("backfill link preview jobs", "error", err)
		}
		return
	}
	urls, err := db.ListDueLinkMetadata(ctx, 8)
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("list link preview jobs", "error", err)
		}
		return
	}
	for _, url := range urls {
		if ctx.Err() != nil {
			return
		}
		_, err := db.FetchLinkMetadata(ctx, url, func(ctx context.Context, url string) (*store.LinkMetadata, error) {
			meta, err := fetch(ctx, url)
			if err != nil || meta == nil {
				return nil, err
			}
			return &store.LinkMetadata{URL: url, Title: meta.Title, Description: meta.Description, Image: meta.Image}, nil
		})
		if err != nil && ctx.Err() == nil {
			slog.Debug("link preview attempt deferred", "error", err)
		}
	}
}
