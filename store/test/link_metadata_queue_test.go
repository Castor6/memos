package test

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"

	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
	"github.com/usememos/memos/store/db"
)

func TestLinkMetadataRejectsInvalidURLsBeforeQueueing(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	for _, url := range []string{"file:///tmp/article", "http://", "https://%", "http://127.0.0.1/article", "https://[::1]/"} {
		t.Run(url, func(t *testing.T) {
			_, err := s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
				t.Fatal("invalid URLs must not be fetched")
				return nil, nil
			})
			require.Error(t, err)
		})
	}
	var jobs int
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM link_metadata_job").Scan(&jobs))
	require.Zero(t, jobs, "invalid URLs must not persist as retry jobs")
}

func TestLinkMetadataSkipsInvalidMemoLinksWithoutBlockingWrites(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	user, err := createTestingHostUser(ctx, s)
	require.NoError(t, err)
	content := "http://127.0.0.1/article\n\nhttps://[::1]/\n\nhttps://missing.invalid/article"
	memo, err := s.CreateMemo(ctx, &store.Memo{UID: "invalid-preview-links", CreatorID: user.ID, Content: content, Visibility: store.Private})
	require.NoError(t, err)
	require.Equal(t, content, memo.Content)
	urls, err := s.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.Equal(t, []string{"https://missing.invalid/article"}, urls)
	// Historical discovery follows the same validation while preserving memo contents.
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "DELETE FROM link_metadata_job")
	require.NoError(t, err)
	done, err := s.BackfillLinkMetadata(ctx, 100)
	require.NoError(t, err)
	require.True(t, done)
	urls, err = s.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.Equal(t, []string{"https://missing.invalid/article"}, urls)
}

func TestLinkMetadataMemoWritesAreAtomic(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	user, err := createTestingHostUser(ctx, s)
	require.NoError(t, err)
	url := "https://example.com/first"
	memo, err := s.CreateMemo(ctx, &store.Memo{UID: "queued-memo", CreatorID: user.ID, Content: url + "\n\n" + url, Visibility: store.Private})
	require.NoError(t, err)
	urls, err := s.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.Equal(t, []string{url}, urls)
	updated := "https://example.com/updated"
	require.NoError(t, s.UpdateMemo(ctx, &store.UpdateMemo{ID: memo.ID, Content: &updated}))
	urls, err = s.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{url, updated}, urls)
	require.NoError(t, s.SaveLinkMetadata(ctx, &store.LinkMetadata{URL: url, Title: "permanent"}))
	_, err = s.CreateMemo(ctx, &store.Memo{UID: "shared-success", CreatorID: user.ID, Content: url, Visibility: store.Private})
	require.NoError(t, err)
	urls, err = s.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.Equal(t, []string{updated}, urls, "new references must not revive successful jobs")

	// Simulate a queue write failure after the memo SQL has already executed.
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "ALTER TABLE link_metadata_job RENAME TO unavailable_link_metadata_job")
	require.NoError(t, err)
	failedURL := "https://example.com/uncommitted"
	_, err = s.CreateMemo(ctx, &store.Memo{UID: "failed-queue", CreatorID: user.ID, Content: failedURL, Visibility: store.Private})
	require.Error(t, err)
	require.Error(t, s.UpdateMemo(ctx, &store.UpdateMemo{ID: memo.ID, Content: &failedURL}))
	failedUID := "failed-queue"
	missing, err := s.GetMemo(ctx, &store.FindMemo{UID: &failedUID})
	require.NoError(t, err)
	require.Nil(t, missing)
	saved, err := s.GetMemo(ctx, &store.FindMemo{ID: &memo.ID})
	require.NoError(t, err)
	require.Equal(t, updated, saved.Content)
}

func TestLinkMetadataLeaseCoordinatesIndependentStores(t *testing.T) {
	ctx := context.Background()
	p := getTestingProfileForDriver(t, getDriverFromEnv())
	newStore := func() *store.Store {
		driver, err := db.NewDBDriver(p)
		require.NoError(t, err)
		s := store.New(driver, p)
		t.Cleanup(func() { s.Close() })
		return s
	}
	first, second := newStore(), newStore()
	require.NoError(t, first.Migrate(ctx))
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	fetch := func(ctx context.Context, url string) (*store.LinkMetadata, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return &store.LinkMetadata{URL: url, Title: "permanent snapshot"}, nil
	}
	url := "https://example.com/shared"
	var workers sync.WaitGroup
	results := make(chan error, 9)
	workers.Go(func() { _, err := first.FetchLinkMetadata(ctx, url, fetch); results <- err })
	<-started
	for range 8 {
		workers.Go(func() { _, err := second.FetchLinkMetadata(ctx, url, fetch); results <- err })
	}
	waitCtx, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	_, err := second.FetchLinkMetadata(waitCtx, url, fetch)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	close(release)
	workers.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	require.Equal(t, int32(1), calls.Load())
	// A separately constructed store reuses the committed snapshot.
	_, err = newStore().FetchLinkMetadata(ctx, url, fetch)
	require.NoError(t, err)
	require.Equal(t, int32(1), calls.Load())
	urls, err := second.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.Empty(t, urls)
}

func TestLinkMetadataFailureBackoffSurvivesRestartAndCanSucceed(t *testing.T) {
	ctx := context.Background()
	p := getTestingProfileForDriver(t, getDriverFromEnv())
	driver, err := db.NewDBDriver(p)
	require.NoError(t, err)
	s := store.New(driver, p)
	require.NoError(t, s.Migrate(ctx))
	url := "https://example.com/retry"
	user, err := createTestingHostUser(ctx, s)
	require.NoError(t, err)
	_, err = s.CreateMemo(ctx, &store.Memo{UID: "durable-retry", CreatorID: user.ID, Content: url, Visibility: store.Private})
	require.NoError(t, err)
	_, err = s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) { return nil, errors.New("HTTP 404") })
	require.Error(t, err)
	require.NoError(t, s.Close())
	driver, err = db.NewDBDriver(p)
	require.NoError(t, err)
	s = store.New(driver, p)
	t.Cleanup(func() { s.Close() })
	calls := 0
	fetch := func(_ context.Context, url string) (*store.LinkMetadata, error) {
		calls++
		return &store.LinkMetadata{URL: url, Title: "recovered"}, nil
	}
	_, err = s.FetchLinkMetadata(ctx, url, fetch)
	require.ErrorIs(t, err, store.ErrLinkMetadataDeferred)
	require.Zero(t, calls)
	urls, err := s.ListDueLinkMetadata(ctx, 8)
	require.NoError(t, err)
	require.Empty(t, urls)
	// Many past failures still permit another attempt after the capped delay.
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET next_attempt_ts = 0, attempts = 30")
	require.NoError(t, err)
	_, err = s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
		return &store.LinkMetadata{Title: " "}, nil
	})
	require.Error(t, err)
	var next int64
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT next_attempt_ts FROM link_metadata_job").Scan(&next))
	require.InDelta(t, float64(time.Now().Add(24*time.Hour).Unix()), float64(next), 5)
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET next_attempt_ts = 0")
	require.NoError(t, err)
	value, err := s.FetchLinkMetadata(ctx, url, fetch)
	require.NoError(t, err)
	require.Equal(t, "recovered", value.Title)
	require.Equal(t, 1, calls)
}

func TestLinkMetadataTemporaryFailuresExpireWithoutBackgroundRetries(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	url := "https://example.com/api-only"
	calls := 0
	fetch := func(context.Context, string) (*store.LinkMetadata, error) {
		calls++
		return nil, errors.New("temporary failure")
	}
	_, err := s.FetchLinkMetadata(ctx, url, fetch)
	require.Error(t, err)
	var expires int64
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT expires_ts FROM link_metadata_job").Scan(&expires))
	require.InDelta(t, float64(time.Now().Add(15*time.Minute).Unix()), float64(expires), 5)
	_, err = s.FetchLinkMetadata(ctx, url, fetch)
	require.ErrorIs(t, err, store.ErrLinkMetadataDeferred)
	require.Equal(t, 1, calls)
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET next_attempt_ts = 0")
	require.NoError(t, err)
	urls, err := s.ListDueLinkMetadata(ctx, 8)
	require.NoError(t, err)
	require.Empty(t, urls, "API-only previews must never become automatic retry work")
	_, err = s.FetchLinkMetadata(ctx, url, fetch)
	require.Error(t, err)
	require.Equal(t, 2, calls, "an explicit request can retry after backoff")
	var unchangedExpiry int64
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT expires_ts FROM link_metadata_job").Scan(&unchangedExpiry))
	require.Equal(t, expires, unchangedExpiry, "repeated requests must not extend temporary retention")
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET expires_ts = 1")
	require.NoError(t, err)
	urls, err = s.ListDueLinkMetadata(ctx, 8)
	require.NoError(t, err)
	require.Empty(t, urls)
	var count int
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM link_metadata_job").Scan(&count))
	require.Zero(t, count)
	value, err := s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
		return &store.LinkMetadata{Title: "now available"}, nil
	})
	require.NoError(t, err)
	require.Equal(t, "now available", value.Title)
	value, err = s.FetchLinkMetadata(ctx, url, fetch)
	require.NoError(t, err)
	require.Equal(t, "now available", value.Title)
	require.Equal(t, 2, calls, "successful API previews remain permanent")
}

func TestLinkMetadataMemoRegistrationPromotesAnActiveTemporaryJob(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	user, err := createTestingHostUser(ctx, s)
	require.NoError(t, err)
	url := "https://example.com/promoted"
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	result := make(chan error, 1)
	go func() {
		_, err := s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
			close(started)
			<-release
			return nil, errors.New("network unavailable")
		})
		result <- err
	}()
	<-started
	var originalLease string
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT lease_token FROM link_metadata_job").Scan(&originalLease))
	_, err = s.CreateMemo(ctx, &store.Memo{UID: "promoted-preview", CreatorID: user.ID, Content: url, Visibility: store.Private})
	require.NoError(t, err)
	var expires int64
	var lease string
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT expires_ts, lease_token FROM link_metadata_job").Scan(&expires, &lease))
	require.Zero(t, expires)
	require.Equal(t, originalLease, lease, "registration must preserve the current owner")
	unblock()
	require.Error(t, <-result)
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET next_attempt_ts = 0")
	require.NoError(t, err)
	urls, err := s.ListDueLinkMetadata(ctx, 8)
	require.NoError(t, err)
	require.Equal(t, []string{url}, urls)
	_, err = s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
		return nil, errors.New("still unavailable")
	})
	require.Error(t, err)
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT expires_ts FROM link_metadata_job").Scan(&expires))
	require.Zero(t, expires, "later API requests must not downgrade a memo job")
}

func TestLinkMetadataRequestRenewsAnExpiredTemporaryJob(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	url := "https://example.com/expired-preview"
	_, err := s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
		return nil, errors.New("temporarily unavailable")
	})
	require.Error(t, err)
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET expires_ts = 1")
	require.NoError(t, err)
	// A new request must recover even if no background cleanup has run yet.
	value, err := s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
		return &store.LinkMetadata{Title: "available again"}, nil
	})
	require.NoError(t, err)
	require.Equal(t, "available again", value.Title)
}

func TestLinkMetadataTemporaryCleanupIsBoundedAndPreservesLeases(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	for i := range 101 {
		_, err := s.GetDriver().GetDB().ExecContext(ctx, fmt.Sprintf("INSERT INTO link_metadata_job (url_hash,url,expires_ts) VALUES ('%064d','https://example.com/expired-%d',1)", i, i))
		require.NoError(t, err)
	}
	_, err := s.GetDriver().GetDB().ExecContext(ctx, fmt.Sprintf("INSERT INTO link_metadata_job (url_hash,url,expires_ts,lease_until) VALUES ('active','https://example.com/active',1,%d)", time.Now().Add(time.Minute).Unix()))
	require.NoError(t, err)
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "INSERT INTO link_metadata_job (url_hash,url,expires_ts) VALUES ('memo','https://example.com/memo',0)")
	require.NoError(t, err)
	urls, err := s.ListDueLinkMetadata(ctx, 8)
	require.NoError(t, err)
	require.Equal(t, []string{"https://example.com/memo"}, urls)
	var count int
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM link_metadata_job").Scan(&count))
	require.Equal(t, 3, count, "one pass must prune at most 100 expired jobs")
	_, err = s.ListDueLinkMetadata(ctx, 8)
	require.NoError(t, err)
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT COUNT(*) FROM link_metadata_job").Scan(&count))
	require.Equal(t, 2, count, "live leases and memo tasks must survive expiry cleanup")
}

func TestLinkMetadataTemporaryCleanupRaceReregistersRequest(t *testing.T) {
	if getDriverFromEnv() != "sqlite" {
		t.Skip("SQLite triggers deterministically inject cleanup before lookup or claim")
	}
	for _, moment := range []string{"AFTER INSERT", "BEFORE UPDATE"} {
		t.Run(moment, func(t *testing.T) {
			ctx := context.Background()
			s := NewTestingStore(ctx, t)
			t.Cleanup(func() { s.Close() })
			// Inject exactly one deletion where expiry cleanup could remove a
			// temporary job between registration, state lookup, and claiming.
			_, err := s.GetDriver().GetDB().ExecContext(ctx, fmt.Sprintf(`CREATE TABLE link_metadata_cleanup_test (id INTEGER PRIMARY KEY);
CREATE TRIGGER expire_first_preview %s ON link_metadata_job
WHEN NOT EXISTS (SELECT 1 FROM link_metadata_cleanup_test)
BEGIN
  INSERT INTO link_metadata_cleanup_test (id) VALUES (1);
  DELETE FROM link_metadata_job WHERE url_hash = NEW.url_hash;
END;`, moment))
			require.NoError(t, err)
			requestCtx, cancel := context.WithTimeout(ctx, time.Second)
			defer cancel()
			calls := 0
			value, err := s.FetchLinkMetadata(requestCtx, "https://example.com/cleanup-race", func(context.Context, string) (*store.LinkMetadata, error) {
				calls++
				return &store.LinkMetadata{Title: "registered again"}, nil
			})
			require.NoError(t, err)
			require.Equal(t, "registered again", value.Title)
			require.Equal(t, 1, calls)
		})
	}
}

func TestLinkMetadataExpiredLeaseFencesOldWorker(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	started, release := make(chan struct{}), make(chan struct{})
	result := make(chan error, 1)
	url := "https://example.com/lease"
	go func() {
		_, err := s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
			close(started)
			<-release
			return &store.LinkMetadata{Title: "stale worker"}, nil
		})
		result <- err
	}()
	<-started
	// Simulate an abandoned process whose durable lease has now expired.
	_, err := s.GetDriver().GetDB().ExecContext(ctx, "UPDATE link_metadata_job SET next_attempt_ts = 0, lease_until = 0")
	require.NoError(t, err)
	current, err := s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
		return &store.LinkMetadata{Title: "recovered worker"}, nil
	})
	require.NoError(t, err)
	require.Equal(t, "recovered worker", current.Title)
	close(release)
	require.ErrorIs(t, <-result, store.ErrLinkMetadataDeferred)
	snapshot, err := s.GetLinkMetadata(ctx, url)
	require.NoError(t, err)
	require.Equal(t, "recovered worker", snapshot.Title)
}

func TestLinkMetadataBackfillResumesAndNeverRescansAfterCompletion(t *testing.T) {
	ctx := context.Background()
	p := getTestingProfileForDriver(t, getDriverFromEnv())
	driver, err := db.NewDBDriver(p)
	require.NoError(t, err)
	s := store.New(driver, p)
	require.NoError(t, s.Migrate(ctx))
	user, err := createTestingHostUser(ctx, s)
	require.NoError(t, err)
	for i := range 3 {
		_, err := s.CreateMemo(ctx, &store.Memo{UID: fmt.Sprintf("backfill-%d", i), CreatorID: user.ID, Content: fmt.Sprintf("https://example.com/old-%d", i), Visibility: store.Private})
		require.NoError(t, err)
	}
	// Old memo content predates queue registration.
	_, err = driver.GetDB().ExecContext(ctx, "DELETE FROM link_metadata_job")
	require.NoError(t, err)
	done, err := s.BackfillLinkMetadata(ctx, 1)
	require.NoError(t, err)
	require.False(t, done)
	require.NoError(t, s.Close())
	driver, err = db.NewDBDriver(p)
	require.NoError(t, err)
	s = store.New(driver, p)
	t.Cleanup(func() { s.Close() })
	for range 2 {
		done, err = s.BackfillLinkMetadata(ctx, 1)
		require.NoError(t, err)
	}
	require.True(t, done)
	urls, err := s.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.Len(t, urls, 3)
	firstUID := "backfill-0"
	firstMemo, err := s.GetMemo(ctx, &store.FindMemo{UID: &firstUID})
	require.NoError(t, err)
	newURL := "https://example.com/edited-after-backfill"
	require.NoError(t, s.UpdateMemo(ctx, &store.UpdateMemo{ID: firstMemo.ID, Content: &newURL}))
	_, err = s.CreateMemo(ctx, &store.Memo{UID: "after-backfill", CreatorID: user.ID, Content: "https://example.com/new-after-backfill", Visibility: store.Private})
	require.NoError(t, err)
	urls, err = s.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.Len(t, urls, 5, "writes must register links after historical discovery is complete")
	// This proves completed passes have no dependency on reading the memo table.
	_, err = driver.GetDB().ExecContext(ctx, "ALTER TABLE memo RENAME TO unavailable_memo")
	require.NoError(t, err)
	done, err = s.BackfillLinkMetadata(ctx, 1)
	require.NoError(t, err)
	require.True(t, done)
}

func TestLinkMetadataQueueMigrationPreservesPermanentSnapshots(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { s.Close() })
	url := "https://example.com/history"
	require.NoError(t, s.SaveLinkMetadata(ctx, &store.LinkMetadata{URL: url, Title: "original title"}))
	_, err := s.GetDriver().GetDB().ExecContext(ctx, "DROP TABLE link_metadata_job")
	require.NoError(t, err)
	_, err = s.GetDriver().GetDB().ExecContext(ctx, "DROP TABLE link_metadata_backfill")
	require.NoError(t, err)
	_, err = s.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{Key: storepb.InstanceSettingKey_BASIC, Value: &storepb.InstanceSetting_BasicSetting{BasicSetting: &storepb.InstanceBasicSetting{SchemaVersion: "0.30.5"}}})
	require.NoError(t, err)
	require.NoError(t, s.Migrate(ctx))
	require.NoError(t, s.Migrate(ctx))
	value, err := s.FetchLinkMetadata(ctx, url, func(context.Context, string) (*store.LinkMetadata, error) {
		t.Fatal("successful history must not be fetched again")
		return nil, nil
	})
	require.NoError(t, err)
	require.Equal(t, "original title", value.Title)
	urls, err := s.ListDueLinkMetadata(ctx, 10)
	require.NoError(t, err)
	require.Empty(t, urls)
}
