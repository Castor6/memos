package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"

	"github.com/usememos/memos/internal/wechatkf"
)

// ErrWeChatLease stops a stale consumer without disclosing database details.
var ErrWeChatLease = errors.New("WeChat consumer lease or configuration changed")

// WeChatState contains the encrypted configuration and consumer lease.
type WeChatState struct {
	Value      string
	Revision   int64
	LeaseOwner string
	LeaseUntil int64
}

// WeChatSync is the durable cursor plus a short-lived notification capability.
type WeChatSync struct {
	Cursor, Token                 string
	TokenTime, Generation, NextAt int64
	LastError                     string
}

// WeChatJob is one replayable input. Payload is erased after successful handling.
type WeChatJob struct {
	ID, Payload, Kind, User, State, Error, Memo string
	Attempts                                    int
	NextAt, CreatedAt                           int64
}

// WeChatReply is an independently persisted result receipt.
type WeChatReply struct {
	ID, User, Content, State, Error string
	Attempts                        int
	NextAt, CreatedAt               int64
}

// WeChatEvent retains only authorized, redacted diagnostic events.
type WeChatEvent struct {
	ID, Type, Payload string
	ReceivedAt        int64
}

// WeChatWindow records the latest user input and reserved replies.
type WeChatWindow struct {
	User   string
	Latest int64
	Used   int
}

// WeChatStats omits source messages and reply content from administrative status.
type WeChatStats struct {
	Jobs       map[string]int64
	Replies    map[string]int64
	Recent     []WeChatJob
	Sync       WeChatSync
	LeaseUntil int64
}

func (s *Store) wechatSQL(query string) string {
	if s.profile.Driver != "postgres" {
		return query
	}
	var b strings.Builder
	number := 1
	for _, r := range query {
		if r == '?' {
			b.WriteString("$" + strconv.Itoa(number))
			number++
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// WeChatConfiguration reads an encrypted setting without using public settings.
func (s *Store) WeChatConfiguration(ctx context.Context) (WeChatState, error) {
	var state WeChatState
	err := s.driver.GetDB().QueryRowContext(ctx, "SELECT value, revision, lease_owner, lease_until FROM wechat_kf_config WHERE id=1").Scan(&state.Value, &state.Revision, &state.LeaseOwner, &state.LeaseUntil)
	return state, err
}

// Every state mutation locks the singleton row first. This serializes cursor,
// queue and quota transactions across all processes and all three SQL drivers.
func (s *Store) wechatTx(ctx context.Context, owner string, revision int64, fn func(*sql.Tx) error) error {
	tx, err := s.driver.GetDB().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "UPDATE wechat_kf_config SET revision=revision WHERE id=1"); err != nil {
		return err
	}
	if owner != "" {
		var held string
		var expires, current int64
		if err = tx.QueryRowContext(ctx, "SELECT lease_owner, lease_until, revision FROM wechat_kf_config WHERE id=1").Scan(&held, &expires, &current); err != nil {
			return err
		}
		if held != owner || expires <= time.Now().Unix() || current != revision {
			return ErrWeChatLease
		}
	}
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// SaveWeChatConfiguration uses optimistic revision checking for concurrent editors.
func (s *Store) SaveWeChatConfiguration(ctx context.Context, value string, revision int64) error {
	return s.wechatTx(ctx, "", 0, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_config SET value=?, revision=revision+1 WHERE id=1 AND revision=?"), value, revision)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return ErrWeChatLease
		}
		return nil
	})
}

// AcquireWeChatConsumer takes an expiring lease and marks interrupted sends unknown.
func (s *Store) AcquireWeChatConsumer(ctx context.Context, owner string, revision, now int64) (bool, error) {
	acquired := false
	err := s.wechatTx(ctx, "", 0, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_config SET lease_owner=?, lease_until=? WHERE id=1 AND revision=? AND (lease_owner='' OR lease_until<=?)"), owner, now+120, revision, now)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil || count == 0 {
			return err
		}
		acquired = true
		_, err = tx.ExecContext(ctx, "UPDATE wechat_kf_replies SET state='unknown', error='进程在发送期间中断，结果不确定' WHERE state='sending'")
		return err
	})
	return acquired, err
}

// RenewWeChatConsumer also checks the configuration revision, cancelling old settings.
func (s *Store) RenewWeChatConsumer(ctx context.Context, owner string, revision, now int64) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_config SET lease_until=? WHERE id=1"), now+120)
		return err
	})
}

// ReleaseWeChatConsumer never releases another process's lease.
func (s *Store) ReleaseWeChatConsumer(ctx context.Context, owner string) error {
	_, err := s.driver.GetDB().ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_config SET lease_owner='', lease_until=0 WHERE id=1 AND lease_owner=?"), owner)
	return err
}

// SignalWeChat persists a verified notification before its HTTP acknowledgement.
func (s *Store) SignalWeChat(ctx context.Context, revision int64, token string, now int64) error {
	return s.wechatTx(ctx, "", 0, func(tx *sql.Tx) error {
		var current int64
		if err := tx.QueryRowContext(ctx, "SELECT revision FROM wechat_kf_config WHERE id=1").Scan(&current); err != nil {
			return err
		}
		if current != revision {
			return ErrWeChatLease
		}
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_sync SET token=?, token_time=?, generation=generation+1, next_at=0 WHERE id=1"), token, now)
		return err
	})
}

// ReadWeChatSync reads the current cursor for the active consumer.
func (s *Store) ReadWeChatSync(ctx context.Context) (WeChatSync, error) {
	var sync WeChatSync
	err := s.driver.GetDB().QueryRowContext(ctx, "SELECT cursor,token,token_time,generation,next_at,last_error FROM wechat_kf_sync WHERE id=1").Scan(&sync.Cursor, &sync.Token, &sync.TokenTime, &sync.Generation, &sync.NextAt, &sync.LastError)
	return sync, err
}

func (s *Store) wechatExists(ctx context.Context, tx *sql.Tx, query string, id string) (bool, error) {
	var one int
	err := tx.QueryRowContext(ctx, s.wechatSQL(query), id).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
func wechatString(v any) string {
	if value, ok := v.(string); ok {
		return value
	}
	return ""
}
func wechatNumber(v any) int64 {
	data, _ := json.Marshal(v)
	number, _ := strconv.ParseInt(string(data), 10, 64)
	return number
}
func wechatObject(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	if m, ok := v.(wechatkf.Message); ok {
		return m
	}
	return nil
}
func wechatID(value string) bool {
	return len(value) > 0 && len(value) <= 191 && !strings.ContainsAny(value, "\x00\r\n")
}

// AcceptWeChatPage inserts authorized jobs/events and advances the cursor atomically.
func (s *Store) AcceptWeChatPage(ctx context.Context, owner string, revision int64, cursor string, messages []wechatkf.Message, binding wechatkf.Binding, now int64) error {
	allowed := map[string]bool{}
	for _, user := range binding.AllowedUsers {
		allowed[user] = true
	}
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.wechatSQL("DELETE FROM wechat_kf_events WHERE received_at<?"), now-30*86400); err != nil {
			return err
		}
		for _, message := range messages {
			if wechatString(message["msgtype"]) == "event" {
				if err := s.wechatEvent(ctx, tx, message, binding.KFID, allowed, now); err != nil {
					return err
				}
				continue
			}
			user := wechatString(message["external_userid"])
			if !allowed[user] || wechatString(message["open_kfid"]) != binding.KFID || wechatNumber(message["origin"]) != 3 {
				continue
			}
			id, kind := wechatString(message["msgid"]), wechatString(message["msgtype"])
			if !wechatID(id) || kind == "" || len(kind) > 64 {
				return errors.New("invalid WeChat message identity")
			}
			exists, err := s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_jobs WHERE id=?", id)
			if err != nil {
				return err
			}
			if exists {
				continue
			}
			payload, err := json.Marshal(message)
			if err != nil {
				return errors.New("invalid WeChat message payload")
			}
			_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_jobs(id,payload,kind,user_id,error,memo,created_at) VALUES(?,?,?,?,?,?,?)"), id, string(payload), kind, user, "", "", now)
			if err != nil {
				return err
			}
			latest := wechatNumber(message["send_time"])
			// Do not let invalid future timestamps manufacture a longer reply window.
			if latest > now {
				latest = now
			}
			exists, err = s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_windows WHERE user_id=?", user)
			if err != nil {
				return err
			}
			if !exists {
				_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_windows(user_id,latest,used) VALUES(?,?,0)"), user, latest)
			} else {
				_, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_windows SET used=CASE WHEN latest<=? THEN 0 ELSE used END, latest=CASE WHEN latest<? THEN ? ELSE latest END WHERE user_id=?"), latest, latest, latest, user)
			}
			if err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_sync SET cursor=? WHERE id=1"), cursor)
		return err
	})
}
func (s *Store) wechatEvent(ctx context.Context, tx *sql.Tx, message wechatkf.Message, kfid string, allowed map[string]bool, now int64) error {
	event := wechatObject(message["event"])
	if event == nil {
		return errors.New("invalid WeChat event")
	}
	user := wechatString(event["external_userid"])
	if !allowed[user] || wechatString(event["open_kfid"]) != kfid {
		return nil
	}
	clean := map[string]any{}
	for key, value := range event {
		if key != "welcome_code" {
			clean[key] = value
		}
	}
	payload, err := json.Marshal(clean)
	if err != nil {
		return errors.New("invalid WeChat event")
	}
	id := wechatString(message["msgid"])
	if id == "" {
		id = wechatkf.StableID(string(payload))
	}
	kind := wechatString(event["event_type"])
	if !wechatID(id) || len(kind) > 64 {
		return errors.New("invalid WeChat event identity")
	}
	exists, err := s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_events WHERE id=?", id)
	if err != nil {
		return err
	}
	if !exists {
		_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_events(id,event_type,payload,received_at) VALUES(?,?,?,?)"), id, kind, string(payload), now)
		if err != nil {
			return err
		}
	}
	if kind == "msg_send_fail" {
		_, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='delivery_failed', error=? WHERE id=? AND user_id=?"), "微信发送失败类型 "+strconv.FormatInt(wechatNumber(event["fail_type"]), 10), wechatString(event["fail_msgid"]), user)
	}
	return err
}

// FinishWeChatSync cannot overwrite a newer notification's immediate wake-up.
func (s *Store) FinishWeChatSync(ctx context.Context, owner string, revision, generation, next int64, detail string) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_sync SET next_at=?, last_error=? WHERE id=1 AND generation=?"), next, detail, generation)
		return err
	})
}

func scanWeChatJob(row interface{ Scan(...any) error }) (WeChatJob, error) {
	var job WeChatJob
	var payload sql.NullString
	err := row.Scan(&job.ID, &payload, &job.Kind, &job.User, &job.State, &job.Attempts, &job.NextAt, &job.Error, &job.Memo, &job.CreatedAt)
	job.Payload = payload.String
	return job, err
}

const wechatJobColumns = "id,payload,kind,user_id,state,attempts,next_at,error,memo,created_at"

// NextWeChatJob selects one due item; a leased consumer is responsible for replay.
func (s *Store) NextWeChatJob(ctx context.Context, now int64) (*WeChatJob, error) {
	job, err := scanWeChatJob(s.driver.GetDB().QueryRowContext(ctx, s.wechatSQL("SELECT "+wechatJobColumns+" FROM wechat_kf_jobs WHERE state='pending' AND next_at<=? ORDER BY next_at,created_at,id LIMIT 1"), now))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}
func (s *Store) wechatReply(ctx context.Context, tx *sql.Tx, jobID, user, content string, now int64) error {
	if content == "" {
		return nil
	}
	id := wechatkf.ReplyID(jobID)
	exists, err := s.wechatExists(ctx, tx, "SELECT 1 FROM wechat_kf_replies WHERE id=?", id)
	if err != nil || exists {
		return err
	}
	_, err = tx.ExecContext(ctx, s.wechatSQL("INSERT INTO wechat_kf_replies(id,user_id,content,created_at,error) VALUES(?,?,?,?,?)"), id, user, content, now, "")
	return err
}

// CompleteWeChatJob atomically clears raw content and queues at most one receipt.
func (s *Store) CompleteWeChatJob(ctx context.Context, owner string, revision int64, job WeChatJob, memo, reply string, now int64) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_jobs SET state='done',payload=NULL,error='',memo=? WHERE id=?"), memo, job.ID)
		if err != nil {
			return err
		}
		return s.wechatReply(ctx, tx, job.ID, job.User, reply, now)
	})
}

// FailWeChatJob retains a resumable draft and queues a final error after 12 attempts.
func (s *Store) FailWeChatJob(ctx context.Context, owner string, revision int64, job WeChatJob, memo, detail, reply string, now int64) error {
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
			return s.wechatReply(ctx, tx, job.ID, job.User, reply, now)
		}
		return nil
	})
}

// ReserveWeChatReply spends quota before dispatch; crashes remain unknown on restart.
func (s *Store) ReserveWeChatReply(ctx context.Context, owner string, revision, now int64, allowed map[string]bool) (*WeChatReply, error) {
	var reply *WeChatReply
	err := s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='expired',error='回复窗口已过期' WHERE state='pending' AND (created_at<=? OR user_id IN (SELECT user_id FROM wechat_kf_windows WHERE latest<=?))"), now-48*3600, now-48*3600)
		if err != nil {
			return err
		}
		var row WeChatReply
		err = tx.QueryRowContext(ctx, s.wechatSQL("SELECT r.id,r.user_id,r.content,r.state,r.attempts,r.next_at,r.created_at,r.error FROM wechat_kf_replies r JOIN wechat_kf_windows w ON r.user_id=w.user_id WHERE r.state='pending' AND r.next_at<=? AND w.used<5 AND w.latest>? ORDER BY r.created_at,r.id LIMIT 1"), now, now-48*3600).Scan(&row.ID, &row.User, &row.Content, &row.State, &row.Attempts, &row.NextAt, &row.CreatedAt, &row.Error)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if !allowed[row.User] {
			_, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='cancelled',error='发送者已移出白名单' WHERE id=?"), row.ID)
			return err
		}
		if _, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_windows SET used=used+1 WHERE user_id=?"), row.User); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state='sending',attempts=attempts+1 WHERE id=?"), row.ID); err != nil {
			return err
		}
		row.Attempts++
		row.State = "sending"
		reply = &row
		return nil
	})
	return reply, err
}

// FinishWeChatReply preserves a delivery-failure event that raced with the API result.
func (s *Store) FinishWeChatReply(ctx context.Context, owner string, revision int64, reply WeChatReply, state, detail string, now int64) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_replies SET state=?,error=?,next_at=? WHERE id=? AND state='sending'"), state, detail, now+int64(min(3600, 60*(1<<min(reply.Attempts, 6)))), reply.ID)
		return err
	})
}

func (s *Store) wechatCounts(ctx context.Context, table string) (map[string]int64, error) {
	counts := map[string]int64{}
	rows, err := s.driver.GetDB().QueryContext(ctx, "SELECT state,COUNT(*) FROM "+table+" GROUP BY state")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		var count int64
		if err = rows.Scan(&state, &count); err != nil {
			return nil, err
		}
		counts[state] = count
	}
	return counts, rows.Err()
}

// WeChatStatus returns counters and redacted recent outcomes, never raw messages.
func (s *Store) WeChatStatus(ctx context.Context) (WeChatStats, error) {
	result := WeChatStats{Jobs: map[string]int64{}, Replies: map[string]int64{}}
	state, err := s.WeChatConfiguration(ctx)
	if err != nil {
		return result, err
	}
	result.LeaseUntil = state.LeaseUntil
	for _, table := range []string{"wechat_kf_jobs", "wechat_kf_replies"} {
		counts, err := s.wechatCounts(ctx, table)
		if err != nil {
			return result, err
		}
		if table == "wechat_kf_jobs" {
			result.Jobs = counts
		} else {
			result.Replies = counts
		}
	}
	rows, err := s.driver.GetDB().QueryContext(ctx, "SELECT id,kind,state,attempts,error,memo,created_at FROM wechat_kf_jobs ORDER BY created_at DESC,id DESC LIMIT 20")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var job WeChatJob
		if err = rows.Scan(&job.ID, &job.Kind, &job.State, &job.Attempts, &job.Error, &job.Memo, &job.CreatedAt); err != nil {
			return result, err
		}
		result.Recent = append(result.Recent, job)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	result.Sync, err = s.ReadWeChatSync(ctx)
	result.Sync.Token = ""
	result.Sync.Cursor = ""
	return result, err
}

// MarkWeChatDraft records the stable memo ID before media operations start.
func (s *Store) MarkWeChatDraft(ctx context.Context, owner string, revision int64, id, memo string) error {
	return s.wechatTx(ctx, owner, revision, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, s.wechatSQL("UPDATE wechat_kf_jobs SET memo=? WHERE id=?"), memo, id)
		return err
	})
}
