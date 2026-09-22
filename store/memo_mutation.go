package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/usememos/memos/internal/base"
	storepb "github.com/usememos/memos/proto/gen/store"
)

// MemoMutation commits a memo and its attachment and reference changes together.
// Nil collections leave associations unchanged; empty collections remove them.
type MemoMutation struct {
	Update                  *UpdateMemo
	AttachmentIDs           *[]int32
	Relations               *[]*MemoRelation
	ActorID                 int32
	AllowForeignAttachments bool
}

type memoMutationFailpointKey struct{}
type memoAttachmentSnapshotHookKey struct{}

// WithMemoMutationFailpoint forces a rollback immediately before commit in tests.
func WithMemoMutationFailpoint(ctx context.Context) context.Context {
	return context.WithValue(ctx, memoMutationFailpointKey{}, true)
}

// WithMemoAttachmentSnapshotHook runs a test hook after attachment rows are locked.
func WithMemoAttachmentSnapshotHook(ctx context.Context, hook func()) context.Context {
	return context.WithValue(ctx, memoAttachmentSnapshotHookKey{}, hook)
}

func (s *Store) memoSQL(query string) string {
	if s.profile.Driver != "postgres" {
		return query
	}
	index := 0
	var result strings.Builder
	for _, r := range query {
		if r == '?' {
			index++
			result.WriteString("$" + strconv.Itoa(index))
		} else {
			result.WriteRune(r)
		}
	}
	return result.String()
}

func (s *Store) memoTimestampExpression() string {
	if s.profile.Driver == "mysql" {
		return "FROM_UNIXTIME(?)"
	}
	return "?"
}

// ApplyMemoMutation changes database state atomically and queues removed files for cleanup.
func (s *Store) ApplyMemoMutation(ctx context.Context, mutation *MemoMutation) error {
	if mutation == nil || mutation.Update == nil {
		return errors.New("memo update is required")
	}
	if mutation.Update.UID != nil && !base.UIDMatcher.MatchString(*mutation.Update.UID) {
		return errors.New("invalid uid")
	}
	var storageSetting *storepb.InstanceStorageSetting
	if mutation.AttachmentIDs != nil {
		var err error
		storageSetting, err = s.GetInstanceStorageSetting(ctx)
		if err != nil {
			return err
		}
	}
	tx, err := s.driver.GetDB().BeginTx(ctx, nil)
	if err != nil {
		return errors.Wrap(err, "failed to begin memo mutation")
	}
	defer tx.Rollback()
	// Acquire a write lock before reading associations, including on SQLite.
	if _, err := tx.ExecContext(ctx, s.memoSQL("UPDATE memo SET id=id WHERE id=?"), mutation.Update.ID); err != nil {
		return err
	}
	var space string
	if err := tx.QueryRowContext(ctx, s.memoSQL("SELECT space FROM memo WHERE id=?"), mutation.Update.ID).Scan(&space); err != nil {
		return errors.Wrap(err, "memo no longer exists")
	}
	if selected, scoped := SpaceFromContext(ctx); scoped && selected != space {
		return errors.New("memo is outside the selected space")
	}
	if mutation.AttachmentIDs != nil {
		if err := s.replaceMemoAttachmentsTx(ctx, tx, mutation, space, storageSetting); err != nil {
			return err
		}
	}
	if mutation.Relations != nil {
		if err := s.replaceMemoReferencesTx(ctx, tx, mutation.Update.ID, *mutation.Relations, space); err != nil {
			return err
		}
	}
	if err := s.updateMemoTx(ctx, tx, mutation.Update); err != nil {
		return err
	}
	if mutation.Update.Content != nil {
		if err := EnqueueMemoLinks(ctx, tx, s.profile.Driver, *mutation.Update.Content); err != nil {
			return err
		}
	}
	if fail, ok := ctx.Value(memoMutationFailpointKey{}).(bool); ok && fail {
		return errors.New("memo mutation failpoint before commit")
	}
	return tx.Commit()
}

func (s *Store) updateMemoTx(ctx context.Context, tx *sql.Tx, update *UpdateMemo) error {
	set, args := []string{}, []any{}
	add := func(column, expression string, value any) {
		set = append(set, column+"="+expression)
		args = append(args, value)
	}
	if update.UID != nil {
		add("uid", "?", *update.UID)
	}
	if update.CreatedTs != nil {
		add("created_ts", s.memoTimestampExpression(), *update.CreatedTs)
	}
	if update.UpdatedTs != nil {
		add("updated_ts", s.memoTimestampExpression(), *update.UpdatedTs)
	}
	if update.RowStatus != nil {
		add("row_status", "?", *update.RowStatus)
	}
	if update.Content != nil {
		add("content", "?", *update.Content)
	}
	if update.Visibility != nil {
		add("visibility", "?", *update.Visibility)
	}
	if update.Pinned != nil {
		add("pinned", "?", *update.Pinned)
	}
	if update.Payload != nil {
		payload, err := protojson.Marshal(update.Payload)
		if err != nil {
			return err
		}
		add("payload", "?", string(payload))
	}
	if len(set) == 0 {
		return nil
	}
	args = append(args, update.ID)
	_, err := tx.ExecContext(ctx, s.memoSQL("UPDATE memo SET "+strings.Join(set, ", ")+" WHERE id=?"), args...)
	return err
}

func (s *Store) memoRowLockSuffix() string {
	if s.profile.Driver == "sqlite" {
		return ""
	}
	return " FOR UPDATE"
}

func (s *Store) replaceMemoAttachmentsTx(ctx context.Context, tx *sql.Tx, mutation *MemoMutation, space string, storageSetting *storepb.InstanceStorageSetting) error {
	requested := make(map[int32]bool, len(*mutation.AttachmentIDs))
	for _, id := range *mutation.AttachmentIDs {
		requested[id] = false
	}
	// Lock the union in ID order so moving an attachment cannot race with cleanup.
	attachments, err := s.memoAttachmentsTx(ctx, tx, mutation.Update.ID, *mutation.AttachmentIDs)
	if err != nil {
		return err
	}
	for _, attachment := range attachments {
		if _, exists := requested[attachment.ID]; exists {
			if attachment.Space != space || (!mutation.AllowForeignAttachments && attachment.CreatorID != mutation.ActorID) {
				return errors.New("attachment is not accessible")
			}
			requested[attachment.ID] = true
		}
	}
	for _, found := range requested {
		if !found {
			return errors.New("attachment no longer exists")
		}
	}
	for _, attachment := range attachments {
		if requested[attachment.ID] {
			continue
		}
		if !mutation.AllowForeignAttachments && attachment.CreatorID != mutation.ActorID {
			return errors.New("cannot remove another user's attachment")
		}
		if err := s.queueAttachmentCleanupTx(ctx, tx, attachment, storageSetting); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.memoSQL("DELETE FROM attachment WHERE id=?"), attachment.ID); err != nil {
			return err
		}
	}
	for index, id := range *mutation.AttachmentIDs {
		updatedTs := time.Now().Unix() + int64(len(*mutation.AttachmentIDs)-index-1)
		if _, err := tx.ExecContext(ctx, s.memoSQL("UPDATE attachment SET memo_id=?, updated_ts="+s.memoTimestampExpression()+" WHERE id=?"), mutation.Update.ID, updatedTs, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) memoAttachmentsTx(ctx context.Context, tx *sql.Tx, memoID int32, requestedIDs []int32) ([]*Attachment, error) {
	query := "SELECT id, uid, creator_id, storage_type, reference, payload, space FROM attachment WHERE memo_id=?"
	args := []any{memoID}
	if len(requestedIDs) > 0 {
		placeholders := make([]string, len(requestedIDs))
		for i, id := range requestedIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		query += " OR id IN (" + strings.Join(placeholders, ",") + ")"
	}
	// Locking reads use current values on MySQL even after the memo read created a snapshot.
	query += " ORDER BY id" + s.memoRowLockSuffix()
	rows, err := tx.QueryContext(ctx, s.memoSQL(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	attachments := []*Attachment{}
	for rows.Next() {
		attachment := &Attachment{}
		var storageType string
		var payload []byte
		if err := rows.Scan(&attachment.ID, &attachment.UID, &attachment.CreatorID, &storageType, &attachment.Reference, &payload, &attachment.Space); err != nil {
			return nil, err
		}
		attachment.StorageType = storepb.AttachmentStorageType(storepb.AttachmentStorageType_value[storageType])
		attachment.Payload = &storepb.AttachmentPayload{}
		if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(payload, attachment.Payload); err != nil {
			return nil, err
		}
		attachments = append(attachments, attachment)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if hook, ok := ctx.Value(memoAttachmentSnapshotHookKey{}).(func()); ok && hook != nil {
		hook()
	}
	return attachments, nil
}
func (s *Store) replaceMemoReferencesTx(ctx context.Context, tx *sql.Tx, memoID int32, relations []*MemoRelation, space string) error {
	for _, relation := range relations {
		if relation == nil || relation.MemoID != memoID || relation.Type != MemoRelationReference {
			return errors.New("invalid reference")
		}
		var targetSpace string
		var isTodo bool
		if err := tx.QueryRowContext(ctx, s.memoSQL("SELECT space, is_todo FROM memo WHERE id=?"+s.memoRowLockSuffix()), relation.RelatedMemoID).Scan(&targetSpace, &isTodo); err != nil {
			return errors.Wrap(err, "referenced memo no longer exists")
		}
		if targetSpace != space || isTodo {
			return errors.New("references must link notes in the same space")
		}
	}
	if _, err := tx.ExecContext(ctx, s.memoSQL("DELETE FROM memo_relation WHERE memo_id=? AND type=?"), memoID, MemoRelationReference); err != nil {
		return err
	}
	seen := map[int32]bool{}
	for _, relation := range relations {
		if relation.RelatedMemoID == memoID || seen[relation.RelatedMemoID] {
			continue
		}
		seen[relation.RelatedMemoID] = true
		if _, err := tx.ExecContext(ctx, s.memoSQL("INSERT INTO memo_relation (memo_id, related_memo_id, type) VALUES (?, ?, ?)"), memoID, relation.RelatedMemoID, MemoRelationReference); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) queueAttachmentCleanupTx(ctx context.Context, tx *sql.Tx, attachment *Attachment, storageSetting *storepb.InstanceStorageSetting) error {
	// Blob content is deleted by the transaction and must not be copied to the queue.
	if AttachmentNeedsInstanceStorageSetting(attachment) {
		if storageSetting == nil || storageSetting.S3Config == nil {
			return errors.New("S3 cleanup configuration is missing")
		}
		attachment.Payload.GetS3Object().S3Config = storageSetting.S3Config
	}
	payload, err := protojson.Marshal(attachment.Payload)
	if err != nil {
		return err
	}
	data, err := json.Marshal(attachmentCleanupData{UID: attachment.UID, StorageType: attachment.StorageType, Reference: attachment.Reference, Payload: payload})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.memoSQL("INSERT INTO attachment_cleanup (attachment_id, payload, attempts, next_at) VALUES (?, ?, 0, 0)"), attachment.ID, string(data))
	return err
}

func (s *Store) deleteMemoWithCleanup(ctx context.Context, memoID int32) error {
	storageSetting, err := s.GetInstanceStorageSetting(ctx)
	if err != nil {
		return err
	}
	tx, err := s.driver.GetDB().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, s.memoSQL("UPDATE memo SET id=id WHERE id=?"), memoID); err != nil {
		return err
	}
	var space string
	if err := tx.QueryRowContext(ctx, s.memoSQL("SELECT space FROM memo WHERE id=?"), memoID).Scan(&space); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	if selected, scoped := SpaceFromContext(ctx); scoped && selected != space {
		return errors.New("memo is outside the selected space")
	}
	attachments, err := s.memoAttachmentsTx(ctx, tx, memoID, nil)
	if err != nil {
		return err
	}
	for _, attachment := range attachments {
		if err := s.queueAttachmentCleanupTx(ctx, tx, attachment, storageSetting); err != nil {
			return err
		}
	}
	for _, query := range []string{
		"DELETE FROM attachment WHERE memo_id=?",
		"DELETE FROM memo_relation WHERE memo_id=?",
		"DELETE FROM memo_relation WHERE related_memo_id=?",
		"DELETE FROM memo WHERE id=?",
	} {
		if _, err := tx.ExecContext(ctx, s.memoSQL(query), memoID); err != nil {
			return err
		}
	}
	if fail, ok := ctx.Value(memoMutationFailpointKey{}).(bool); ok && fail {
		return errors.New("memo mutation failpoint before commit")
	}
	return tx.Commit()
}
