package store

import (
	"context"
	"database/sql"

	"github.com/pkg/errors"
	"google.golang.org/protobuf/encoding/protojson"

	storepb "github.com/usememos/memos/proto/gen/store"
)

// DeleteAttachmentWithCleanup atomically removes one attachment and queues its stored object for cleanup.
// Missing attachments are already deleted; callers must enforce ownership before invoking this method.
func (s *Store) DeleteAttachmentWithCleanup(ctx context.Context, delete *DeleteAttachment) error {
	if delete == nil {
		return errors.New("attachment delete is required")
	}
	setting, err := s.GetInstanceStorageSetting(ctx)
	if err != nil {
		return err
	}
	tx, err := s.driver.GetDB().BeginTx(ctx, nil)
	if err != nil {
		return errors.Wrap(err, "failed to begin attachment deletion")
	}
	defer tx.Rollback()
	// Acquire the write lock before reading the cleanup snapshot, including on SQLite.
	if _, err := tx.ExecContext(ctx, s.memoSQL("UPDATE attachment SET id=id WHERE id=?"), delete.ID); err != nil {
		return err
	}
	attachment := &Attachment{}
	var storageType string
	var payload []byte
	query := "SELECT id, uid, storage_type, reference, payload, space FROM attachment WHERE id=?" + s.memoRowLockSuffix()
	if err := tx.QueryRowContext(ctx, s.memoSQL(query), delete.ID).Scan(
		&attachment.ID, &attachment.UID, &storageType, &attachment.Reference, &payload, &attachment.Space,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return errors.Wrap(err, "failed to read attachment cleanup snapshot")
	}
	if selected, scoped := SpaceFromContext(ctx); scoped && selected != attachment.Space {
		return errors.New("attachment is outside the selected space")
	}
	attachment.StorageType = storepb.AttachmentStorageType(storepb.AttachmentStorageType_value[storageType])
	attachment.Payload = &storepb.AttachmentPayload{}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(payload, attachment.Payload); err != nil {
		return errors.Wrap(err, "failed to decode attachment cleanup payload")
	}
	if err := s.queueAttachmentCleanupTx(ctx, tx, attachment, setting); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, s.memoSQL("DELETE FROM attachment WHERE id=?"), attachment.ID); err != nil {
		return err
	}
	if fail, ok := ctx.Value(memoMutationFailpointKey{}).(bool); ok && fail {
		return errors.New("attachment deletion failpoint before commit")
	}
	return tx.Commit()
}
