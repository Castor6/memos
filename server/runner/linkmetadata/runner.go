// Package linkmetadata fills durable previews independently of page views.
package linkmetadata

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/usememos/memos/internal/httpgetter"
	links "github.com/usememos/memos/internal/linkmetadata"
	"github.com/usememos/memos/store"
)

// Run backfills existing notes and discovers new links on each pass.
func Run(ctx context.Context, db *store.Store) {
	ticker := time.NewTicker(time.Minute)
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
	seen := map[string]bool{}
	limit := 100
	for offset := 0; ; offset += limit {
		memos, err := db.ListMemos(ctx, &store.FindMemo{Limit: &limit, Offset: &offset})
		if err != nil {
			if ctx.Err() == nil {
				slog.Error("list notes for link previews", "error", err)
			}
			return
		}
		for _, memo := range memos {
			for _, url := range links.URLs(memo.Content) {
				if ctx.Err() != nil {
					return
				}
				if seen[url] {
					continue
				}
				seen[url] = true
				cached, err := db.GetLinkMetadata(ctx, url)
				if err != nil {
					slog.Error("read link preview cache", "error", err)
					return
				}
				if cached != nil {
					continue
				}
				meta, err := fetch(ctx, url)
				if err != nil || strings.TrimSpace(meta.Title) == "" {
					continue
				}
				if err := db.SaveLinkMetadata(ctx, &store.LinkMetadata{URL: url, Title: meta.Title, Description: meta.Description, Image: meta.Image}); err != nil {
					slog.Error("save link preview cache", "error", err)
				}
			}
		}
		if len(memos) < limit {
			return
		}
	}
}
