package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"

	"github.com/usememos/memos/internal/httpgetter"
	"github.com/usememos/memos/internal/linkmetadata"
)

const (
	linkMetadataLease        = 90 * time.Second
	linkMetadataFetchTimeout = 45 * time.Second
)

// ErrLinkMetadataDeferred means a failed preview is waiting for its next retry.
var ErrLinkMetadataDeferred = errors.New("link preview is waiting for retry")

type linkMetadataJob struct {
	URL                     string
	Attempts                int
	NextAttempt, LeaseUntil int64
	LeaseToken              string
}

type linkMetadataExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func linkMetadataSQL(dialect, query string) string {
	if dialect != "postgres" {
		return query
	}
	var result strings.Builder
	n := 0
	for _, char := range query {
		if char == '?' {
			n++
			result.WriteString("$" + strconv.Itoa(n))
		} else {
			result.WriteRune(char)
		}
	}
	return result.String()
}

// EnqueueMemoLinks registers content links in the same transaction as the memo write.
func EnqueueMemoLinks(ctx context.Context, tx *sql.Tx, dialect, content string) error {
	for _, url := range linkmetadata.URLs(content) {
		// Unpreviewable links must not prevent saving the memo or enter the retry queue.
		if err := httpgetter.ValidateURL(url); err != nil {
			continue
		}
		if err := enqueueLinkMetadata(ctx, tx, dialect, url); err != nil {
			return err
		}
	}
	return nil
}

func enqueueLinkMetadata(ctx context.Context, db linkMetadataExecutor, dialect, url string) error {
	query := "INSERT INTO link_metadata_job (url_hash, url) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM link_metadata WHERE url_hash = ?)"
	if dialect == "mysql" {
		query += " ON DUPLICATE KEY UPDATE url_hash = url_hash"
	} else {
		query += " ON CONFLICT(url_hash) DO NOTHING"
	}
	_, err := db.ExecContext(ctx, linkMetadataSQL(dialect, query), linkKey(url), url, linkKey(url))
	return errors.Wrap(err, "enqueue link preview")
}

// ListDueLinkMetadata returns a bounded batch without scanning memo contents.
func (s *Store) ListDueLinkMetadata(ctx context.Context, limit int) ([]string, error) {
	query := "SELECT url FROM link_metadata_job WHERE next_attempt_ts <= ? ORDER BY next_attempt_ts, url_hash LIMIT ?"
	rows, err := s.driver.GetDB().QueryContext(ctx, linkMetadataSQL(s.profile.Driver, query), time.Now().Unix(), limit)
	if err != nil {
		return nil, errors.Wrap(err, "list due link previews")
	}
	defer rows.Close()
	var urls []string
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			return nil, err
		}
		urls = append(urls, url)
	}
	return urls, rows.Err()
}

// FetchLinkMetadata shares a durable lease between API requests and background work.
// Successful snapshots are permanent; failed attempts keep their retry schedule.
func (s *Store) FetchLinkMetadata(ctx context.Context, url string, fetch func(context.Context, string) (*LinkMetadata, error)) (*LinkMetadata, error) {
	url = strings.TrimSpace(url)
	if url == "" {
		return nil, errors.New("url is required")
	}
	if err := httpgetter.ValidateURL(url); err != nil {
		return nil, err
	}
	cached, err := s.GetLinkMetadata(ctx, url)
	if err != nil || cached != nil {
		return cached, err
	}
	if err := enqueueLinkMetadata(ctx, s.driver.GetDB(), s.profile.Driver, url); err != nil {
		return nil, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		cached, err := s.GetLinkMetadata(ctx, url)
		if err != nil || cached != nil {
			return cached, err
		}
		job := &linkMetadataJob{URL: url}
		query := "SELECT attempts, next_attempt_ts, lease_until, lease_token FROM link_metadata_job WHERE url_hash = ?"
		err = s.driver.GetDB().QueryRowContext(ctx, linkMetadataSQL(s.profile.Driver, query), linkKey(url)).Scan(&job.Attempts, &job.NextAttempt, &job.LeaseUntil, &job.LeaseToken)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, errors.Wrap(err, "read link preview job")
		}
		now := time.Now().Unix()
		if job.LeaseUntil > now {
			timer := time.NewTimer(50 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
			continue
		}
		if job.NextAttempt > now {
			return nil, ErrLinkMetadataDeferred
		}
		job.LeaseToken = rand.Text()
		query = "UPDATE link_metadata_job SET attempts = CASE WHEN attempts < 31 THEN attempts + 1 ELSE 31 END, lease_token = ?, lease_until = ?, next_attempt_ts = ? WHERE url_hash = ? AND next_attempt_ts <= ? AND lease_until <= ?"
		result, err := s.driver.GetDB().ExecContext(ctx, linkMetadataSQL(s.profile.Driver, query), job.LeaseToken, now+int64(linkMetadataLease/time.Second), now+int64(linkMetadataLease/time.Second), linkKey(url), now, now)
		if err != nil {
			return nil, errors.Wrap(err, "claim link preview")
		}
		claimed, err := result.RowsAffected()
		if err != nil {
			return nil, err
		}
		if claimed == 0 {
			continue
		}
		job.Attempts++
		// A snapshot may have been committed between the first read and the claim.
		cached, err = s.GetLinkMetadata(ctx, url)
		if err != nil {
			return nil, err
		}
		if cached != nil {
			return cached, s.SaveLinkMetadata(ctx, cached)
		}
		fetchCtx, cancel := context.WithTimeout(ctx, linkMetadataFetchTimeout)
		value, fetchErr := fetch(fetchCtx, url)
		cancel()
		if fetchErr == nil && (value == nil || strings.TrimSpace(value.Title) == "") {
			fetchErr = errors.New("link preview has no title")
		}
		// A shutdown or client disconnect must not lose the durable retry result.
		finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		err = s.finishLinkMetadata(finishCtx, job, value, fetchErr)
		finishCancel()
		if err != nil {
			return nil, err
		}
		if fetchErr != nil {
			return nil, fetchErr
		}
		return s.GetLinkMetadata(ctx, url)
	}
}

func linkMetadataRetryDelay(attempts int) time.Duration {
	delay := time.Minute << min(max(attempts-1, 0), 11)
	return min(delay, 24*time.Hour)
}

func (s *Store) finishLinkMetadata(ctx context.Context, job *linkMetadataJob, value *LinkMetadata, fetchErr error) error {
	if fetchErr != nil {
		query := "UPDATE link_metadata_job SET next_attempt_ts = ?, lease_until = 0, lease_token = '' WHERE url_hash = ? AND lease_token = ?"
		_, err := s.driver.GetDB().ExecContext(ctx, linkMetadataSQL(s.profile.Driver, query), time.Now().Add(linkMetadataRetryDelay(job.Attempts)).Unix(), linkKey(job.URL), job.LeaseToken)
		return errors.Wrap(err, "schedule link preview retry")
	}
	tx, err := s.driver.GetDB().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Fence expired workers before they can publish a result.
	query := "DELETE FROM link_metadata_job WHERE url_hash = ? AND lease_token = ?"
	result, err := tx.ExecContext(ctx, linkMetadataSQL(s.profile.Driver, query), linkKey(job.URL), job.LeaseToken)
	if err != nil {
		return err
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if deleted == 0 {
		return ErrLinkMetadataDeferred
	}
	value.URL = job.URL
	if err := saveLinkMetadata(ctx, tx, s.profile.Driver, value); err != nil {
		return err
	}
	return tx.Commit()
}

// BackfillLinkMetadata registers one keyset page of old memos and persists its cursor.
// After completion, subsequent calls only read the completion marker.
func (s *Store) BackfillLinkMetadata(ctx context.Context, limit int) (bool, error) {
	if limit <= 0 {
		return false, errors.New("backfill limit must be positive")
	}
	tx, err := s.driver.GetDB().BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var cursor, upper int64
	var initialized, completed int
	err = tx.QueryRowContext(ctx, "SELECT cursor_id, upper_id, initialized, completed FROM link_metadata_backfill WHERE id = 1").Scan(&cursor, &upper, &initialized, &completed)
	if err != nil {
		return false, errors.Wrap(err, "read link preview backfill")
	}
	if completed != 0 {
		return true, nil
	}
	if initialized == 0 {
		if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(id), 0) FROM memo").Scan(&upper); err != nil {
			return false, err
		}
	}
	query := "SELECT id, content FROM memo WHERE id > ? AND id <= ? ORDER BY id LIMIT ?"
	rows, err := tx.QueryContext(ctx, linkMetadataSQL(s.profile.Driver, query), cursor, upper, limit)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	type contentRow struct {
		id      int64
		content string
	}
	var memos []contentRow
	for rows.Next() {
		var memo contentRow
		if err := rows.Scan(&memo.id, &memo.content); err != nil {
			return false, err
		}
		memos = append(memos, memo)
	}
	err = rows.Err()
	if err != nil {
		return false, err
	}
	next := cursor
	for _, memo := range memos {
		if err := EnqueueMemoLinks(ctx, tx, s.profile.Driver, memo.content); err != nil {
			return false, err
		}
		next = memo.id
	}
	if len(memos) < limit || next >= upper {
		completed = 1
	}
	query = "UPDATE link_metadata_backfill SET cursor_id = ?, upper_id = ?, initialized = 1, completed = ? WHERE id = 1 AND cursor_id = ? AND completed = 0"
	result, err := tx.ExecContext(ctx, linkMetadataSQL(s.profile.Driver, query), next, upper, completed, cursor)
	if err != nil {
		return false, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if updated == 0 {
		return false, nil
	}
	return completed != 0, tx.Commit()
}
