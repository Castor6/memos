package store

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	storepb "github.com/usememos/memos/proto/gen/store"
)

type attachmentCleanupData struct {
	UID         string
	StorageType storepb.AttachmentStorageType
	Reference   string
	Payload     json.RawMessage
}

type attachmentCleanupJob struct {
	id          int32
	payload     string
	attempts    int
	attachment  *Attachment
	identity    attachmentStorageIdentity
	decodeError error
}

// ProcessAttachmentCleanup retries a bounded batch of committed file deletions.
// Failed jobs remain durable across restarts, with exponential retry delay.
func (s *Store) ProcessAttachmentCleanup(ctx context.Context, now int64, limit int) error {
	limit = min(max(limit, 1), 100)
	jobs, err := s.listAttachmentCleanupJobs(ctx, now, limit)
	if err != nil {
		return err
	}
	for i := range jobs {
		var data attachmentCleanupData
		jobs[i].decodeError = json.Unmarshal([]byte(jobs[i].payload), &data)
		jobs[i].attachment = &Attachment{UID: data.UID, StorageType: data.StorageType, Reference: data.Reference, Payload: &storepb.AttachmentPayload{}}
		if jobs[i].decodeError == nil {
			jobs[i].decodeError = (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(data.Payload, jobs[i].attachment.Payload)
		}
		if jobs[i].decodeError == nil {
			jobs[i].identity, jobs[i].decodeError = s.attachmentStorageIdentity(jobs[i].attachment, nil)
		}
	}
	references, activeUIDs, err := s.liveCleanupReferences(ctx, jobs)
	if err != nil {
		return err
	}
	for _, item := range jobs {
		if err := ctx.Err(); err != nil {
			return err
		}
		cleanupErr := item.decodeError
		if cleanupErr == nil && !references[item.identity] {
			jobContext, cancel := context.WithTimeout(ctx, 30*time.Second)
			cleanupErr = s.deleteAttachmentStorageObject(jobContext, item.attachment, nil)
			cancel()
		}
		if cleanupErr != nil {
			delay := min(int64(30)*(1<<min(item.attempts, 10)), int64(3600))
			if _, err := s.driver.GetDB().ExecContext(ctx, s.memoSQL("UPDATE attachment_cleanup SET attempts=attempts+1, next_at=? WHERE attachment_id=?"), now+delay, item.id); err != nil {
				return err
			}
			slog.Warn("Attachment cleanup will be retried", slog.Int64("attachment_id", int64(item.id)), slog.Any("err", cleanupErr))
			continue
		}
		// A reused UID belongs to a different attachment and may already have new caches.
		if !activeUIDs[item.attachment.UID] {
			s.deleteAttachmentDerivedCaches(item.attachment)
		}
		if _, err := s.driver.GetDB().ExecContext(ctx, s.memoSQL("DELETE FROM attachment_cleanup WHERE attachment_id=?"), item.id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) listAttachmentCleanupJobs(ctx context.Context, now int64, limit int) ([]attachmentCleanupJob, error) {
	rows, err := s.driver.GetDB().QueryContext(ctx, s.memoSQL("SELECT attachment_id, payload, attempts FROM attachment_cleanup WHERE next_at<=? ORDER BY next_at, attachment_id LIMIT ?"), now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []attachmentCleanupJob{}
	for rows.Next() {
		var item attachmentCleanupJob
		if err := rows.Scan(&item.id, &item.payload, &item.attempts); err != nil {
			return nil, err
		}
		jobs = append(jobs, item)
	}
	return jobs, rows.Err()
}

// RunAttachmentCleanup resumes persisted file cleanup at startup and every minute.
func (s *Store) RunAttachmentCleanup(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		if err := s.ProcessAttachmentCleanup(ctx, time.Now().Unix(), 100); err != nil && ctx.Err() == nil {
			slog.Warn("Failed to process attachment cleanup", slog.Any("err", err))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
