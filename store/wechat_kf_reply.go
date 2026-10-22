package store

import (
	"context"
	"database/sql"
	"strings"
	"unicode/utf8"

	"github.com/pkg/errors"

	"github.com/usememos/memos/internal/wechatkf"
)

func (s *Store) wechatReply(ctx context.Context, tx *sql.Tx, jobID, user string, reply WeChatReply, now int64) error {
	if reply.Kind == "" {
		reply.Kind = "text"
	}
	if reply.Kind == "text" && reply.Content == "" {
		return nil
	}
	var data any
	switch reply.Kind {
	case "text":
		if len(reply.Content) > 2048 || !utf8.ValidString(reply.Content) || reply.FileContent != "" {
			return errors.New("invalid WeChat text result")
		}
	case "file":
		if len(reply.FileContent) <= 5 || len(reply.FileContent) > 1<<20 || !utf8.ValidString(reply.FileContent) ||
			reply.Filename == "" || wechatkf.SafeFilename(reply.Filename) != reply.Filename ||
			!utf8.ValidString(reply.Filename) || !strings.HasSuffix(reply.Filename, ".md") {
			return errors.New("invalid WeChat Markdown result")
		}
		data = reply.FileContent
		reply.Required = true
	default:
		return errors.New("invalid WeChat result type")
	}
	id := wechatkf.ReplyID(jobID)
	exists, err := s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_replies WHERE id=?", id)
	if err != nil || exists {
		return err
	}
	required := 0
	if reply.Required {
		required = 1
	}
	_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_replies(id,user_id,content,kind,filename,file_content,required,created_at,error) VALUES(?,?,?,?,?,?,?,?,?)"), id, user, reply.Content, reply.Kind, reply.Filename, data, required, now, "")
	return err
}

// CompleteWeChatJob atomically clears raw content and queues at most one text receipt.
func (s *Store) CompleteWeChatJob(ctx context.Context, owner string, revision int64, job WeChatJob, memo, reply string, now int64) error {
	return s.CompleteWeChatResult(ctx, owner, revision, job, memo, WeChatReply{Content: reply}, now)
}

// CompleteWeChatResult persists a generated result in the same transaction as job completion.
func (s *Store) CompleteWeChatResult(ctx context.Context, owner string, revision int64, job WeChatJob, memo string, reply WeChatReply, now int64) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_jobs SET state='done',payload=NULL,error='',memo=? WHERE id=?"), memo, job.ID)
		if err != nil {
			return err
		}
		return s.wechatReply(ctx, tx, job.ID, job.User, reply, now)
	})
}

// FailWeChatJob retains a resumable draft and queues a final error after 12 attempts.
func (s *Store) FailWeChatJob(ctx context.Context, owner string, revision int64, job WeChatJob, memo, detail, reply string, now int64, required ...bool) error {
	attempts := job.Attempts + 1
	state := "pending"
	if attempts >= 12 {
		state = "failed"
	}
	if memo == "" {
		memo = job.Memo
	}
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_jobs SET state=?,attempts=?,next_at=?,error=?,memo=? WHERE id=?"), state, attempts, now+int64(min(3600, 10*(1<<min(attempts, 9)))), detail, memo, job.ID)
		if err != nil {
			return err
		}
		if state == "failed" {
			return s.wechatReply(ctx, tx, job.ID, job.User, WeChatReply{Content: reply, Required: len(required) > 0 && required[0]}, now)
		}
		return nil
	})
}

// ReserveWeChatReply prepares files without quota; text reserves quota before dispatch.
// With receipts disabled, explicitly requested article results remain eligible.
func (s *Store) ReserveWeChatReply(ctx context.Context, owner string, revision, now int64, allowed map[string]bool, receipts ...bool) (*WeChatReply, error) {
	var reply *WeChatReply
	err := s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='expired',file_content=NULL,error='回复窗口已过期' WHERE state='pending' AND (created_at<=? OR user_id IN (SELECT user_id FROM wechat_kf_windows WHERE latest<=?))"), now-48*3600, now-48*3600)
		if err != nil {
			return err
		}
		filter := ""
		if len(receipts) > 0 && !receipts[0] {
			filter = " AND r.required=1"
		}
		var row WeChatReply
		var data sql.NullString
		err = tx.QueryRowContext(ctx, s.wechatSQL("SELECT r.id,r.user_id,r.content,r.state,r.attempts,r.next_at,r.created_at,r.error,r.kind,r.filename,r.file_content,r.required FROM wechat_kf_replies r JOIN wechat_kf_windows w ON r.user_id=w.user_id WHERE r.state='pending' AND r.next_at<=? AND w.used<5 AND w.latest>?"+filter+" ORDER BY r.created_at,r.id LIMIT 1"), now, now-48*3600).Scan(&row.ID, &row.User, &row.Content, &row.State, &row.Attempts, &row.NextAt, &row.CreatedAt, &row.Error, &row.Kind, &row.Filename, &data, &row.Required)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		row.FileContent = data.String
		if !allowed[row.User] {
			_, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='cancelled',file_content=NULL,error='发送者已移出白名单' WHERE id=?"), row.ID)
			return err
		}
		row.State = "preparing"
		if row.Kind != "file" {
			row.State = "sending"
			if _, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_windows SET used=used+1 WHERE user_id=?"), row.User); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state=?,attempts=attempts+1 WHERE id=?"), row.State, row.ID); err != nil {
			return err
		}
		row.Attempts++
		reply = &row
		return nil
	})
	return reply, err
}

// StartWeChatFileReply checks the window again after upload and durably reserves dispatch.
func (s *Store) StartWeChatFileReply(ctx context.Context, owner string, revision int64, reply WeChatReply, now int64) (bool, error) {
	started := false
	err := s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		var user, state, kind string
		var created int64
		var latest, used sql.NullInt64
		err := tx.QueryRowContext(ctx, s.wechatSQL("SELECT r.user_id,r.state,r.kind,r.created_at,w.latest,w.used FROM wechat_kf_replies r LEFT JOIN wechat_kf_windows w ON r.user_id=w.user_id WHERE r.id=?"), reply.ID).Scan(&user, &state, &kind, &created, &latest, &used)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if state != "preparing" || kind != "file" {
			return nil
		}
		if !latest.Valid || created <= now-48*3600 || latest.Int64 <= now-48*3600 {
			_, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='expired',file_content=NULL,error='回复窗口已过期' WHERE id=?"), reply.ID)
			return err
		}
		if used.Int64 >= 5 {
			_, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='pending' WHERE id=?"), reply.ID)
			return err
		}
		if _, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_windows SET used=used+1 WHERE user_id=?"), user); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='sending' WHERE id=?"), reply.ID); err != nil {
			return err
		}
		started = true
		return nil
	})
	return started, err
}

// FinishWeChatFileUpload retries upload failures without spending user-visible message quota.
func (s *Store) FinishWeChatFileUpload(ctx context.Context, owner string, revision int64, reply WeChatReply, detail string, now int64) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		if reply.Attempts >= 4 {
			return s.wechatFileFallback(ctx, tx, reply.ID, "preparing", "Markdown 文件上传失败："+detail, detail, now)
		}
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='pending',error=?,next_at=? WHERE id=? AND state='preparing' AND kind='file'"), detail, now+int64(min(3600, 60*(1<<min(reply.Attempts, 6)))), reply.ID)
		return err
	})
}

// FallbackWeChatFileReply is only for a definitive rejection after file dispatch.
// It must never be used for an ambiguous response, cancellation, or interrupted send.
func (s *Store) FallbackWeChatFileReply(ctx context.Context, owner string, revision int64, reply WeChatReply, detail string, now int64) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		return s.wechatFileFallback(ctx, tx, reply.ID, "sending", "Markdown 文件发送失败："+detail, detail, now)
	})
}

func (s *Store) wechatFileFallback(ctx context.Context, tx *sql.Tx, id, from, content, detail string, now int64) error {
	_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET kind='text',content=?,required=1,file_content=NULL,state='pending',attempts=0,next_at=?,error=? WHERE id=? AND state=? AND kind='file'"), content, now, detail, id, from)
	return err
}

// FinishWeChatReply preserves a delivery-failure event that raced with the API result.
func (s *Store) FinishWeChatReply(ctx context.Context, owner string, revision int64, reply WeChatReply, state, detail string, now int64) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		clear := ",file_content=NULL"
		if state == "pending" {
			clear = ""
		}
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state=?,error=?,next_at=?"+clear+" WHERE id=? AND state='sending'"), state, detail, now+int64(min(3600, 60*(1<<min(reply.Attempts, 6)))), reply.ID)
		return err
	})
}
