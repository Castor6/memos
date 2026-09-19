package store

import (
	"context"
	"database/sql"
	"time"

	"github.com/pkg/errors"
)

// WeChatImport is a private offline snapshot, never accepted through a public API.
type WeChatImport struct {
	Cursor  string
	Jobs    []WeChatJob
	Replies []WeChatReply
	Windows []WeChatWindow
	Events  []WeChatEvent
}

// WeChatImportCounts reports counts only, avoiding source payloads and identifiers.
type WeChatImportCounts struct{ Jobs, Replies, Windows, Events int }

// ImportWeChatState is idempotent and refuses an active consumer. The caller must
// additionally verify the encrypted config is disabled and the source account matches.
func (s *Store) ImportWeChatState(ctx context.Context, snapshot WeChatImport, sealed string, revision int64) (WeChatImportCounts, error) {
	counts := WeChatImportCounts{}
	err := s.wechatTx(ctx, "", 0, func(tx *sql.Tx) error {
		var current, lease int64
		if err := tx.QueryRowContext(ctx, "SELECT revision,lease_until FROM wechat_kf_config WHERE id=1").Scan(&current, &lease); err != nil {
			return err
		}
		if current != revision || lease > time.Now().Unix() {
			return ErrWeChatLease
		}
		for _, job := range snapshot.Jobs {
			if !wechatID(job.ID) || (job.State != "pending" && job.State != "done" && job.State != "failed") {
				return errors.New("invalid legacy job")
			}
			exists, err := s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_jobs WHERE id=?", job.ID)
			if err != nil {
				return err
			}
			if exists {
				continue
			}
			var payload any
			if job.State != "done" {
				payload = job.Payload
			}
			_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_jobs("+wechatJobColumns+") VALUES(?,?,?,?,?,?,?,?,?,?)"), job.ID, payload, job.Kind, job.User, job.State, job.Attempts, job.NextAt, job.Error, job.Memo, job.CreatedAt)
			if err != nil {
				return err
			}
			counts.Jobs++
		}
		for _, reply := range snapshot.Replies {
			if !wechatID(reply.ID) || len(reply.ID) > 64 || !wechatID(reply.User) {
				return errors.New("invalid legacy reply")
			}
			switch reply.State {
			case "pending", "sent", "unknown", "expired", "cancelled", "delivery_failed", "failed":
			case "sending":
				reply.State = "unknown"
				reply.Error = "迁移时发送结果不确定"
			default:
				return errors.New("invalid legacy reply state")
			}
			exists, err := s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_replies WHERE id=?", reply.ID)
			if err != nil {
				return err
			}
			if exists {
				continue
			}
			_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_replies(id,user_id,content,state,attempts,next_at,created_at,error) VALUES(?,?,?,?,?,?,?,?)"), reply.ID, reply.User, reply.Content, reply.State, reply.Attempts, reply.NextAt, reply.CreatedAt, reply.Error)
			if err != nil {
				return err
			}
			counts.Replies++
		}
		for _, window := range snapshot.Windows {
			if !wechatID(window.User) || window.Used < 0 {
				return errors.New("invalid legacy reply window")
			}
			exists, err := s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_windows WHERE user_id=?", window.User)
			if err != nil {
				return err
			}
			if exists {
				continue
			}
			_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_windows(user_id,latest,used) VALUES(?,?,?)"), window.User, window.Latest, window.Used)
			if err != nil {
				return err
			}
			counts.Windows++
		}
		for _, event := range snapshot.Events {
			if !wechatID(event.ID) || len(event.Type) > 64 {
				return errors.New("invalid legacy event")
			}
			exists, err := s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_events WHERE id=?", event.ID)
			if err != nil {
				return err
			}
			if exists {
				continue
			}
			_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_events(id,event_type,payload,received_at) VALUES(?,?,?,?)"), event.ID, event.Type, event.Payload, event.ReceivedAt)
			if err != nil {
				return err
			}
			counts.Events++
		}
		// Never rewind an already imported or active cursor on a repeated import.
		if _, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_sync SET cursor=?,token='',token_time=0,generation=generation+1,next_at=0 WHERE id=1 AND cursor='' AND generation=0"), snapshot.Cursor); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_config SET value=?,revision=revision+1 WHERE id=1"), sealed)
		return err
	})
	return counts, err
}
