// Package legacy reads the retired Python service's private SQLite state offline.
package legacy

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"github.com/pkg/errors"

	// The source snapshot is SQLite even when the destination uses another driver.
	_ "modernc.org/sqlite"

	core "github.com/usememos/memos/internal/wechatkf"
	"github.com/usememos/memos/store"
)

// Configuration reads only the legacy WeChat settings, never the obsolete Memos PAT.
func Configuration(path string) (core.Config, error) {
	values, err := godotenv.Read(path)
	if err != nil {
		return core.Config{}, errors.New("无法读取旧服务配置文件")
	}
	config := core.DefaultConfig()
	config.CorpID = values["WECHAT_CORP_ID"]
	config.KFID = values["WECHAT_KF_ID"]
	config.Secret = values["WECHAT_SECRET"]
	config.CallbackToken = values["WECHAT_CALLBACK_TOKEN"]
	config.EncodingKey = values["WECHAT_ENCODING_AES_KEY"]
	config.AllowedUsers = split(values["WECHAT_ALLOWED_USERS"])
	if value, ok := values["DEFAULT_TAGS"]; ok {
		config.DefaultTags = split(value)
	}
	if value := values["CHAT_RECORD_TAG"]; value != "" {
		config.ChatTag = value
	}
	if value, ok := values["RECEIPTS_ENABLED"]; ok {
		config.Receipts = strings.EqualFold(value, "true") || value == "1"
	}
	if value := values["MAX_MEDIA_BYTES"]; value != "" {
		size, err := strconv.Atoi(value)
		if err != nil {
			return core.Config{}, errors.New("旧服务附件限制无效")
		}
		config.MaxMediaMB = max(1, size>>20)
	}
	return config, nil
}
func split(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

// Read requires a stopped source service or a consistent SQLite backup. It opens
// the source read-only and never writes data or checkpoints a production source.
func Read(ctx context.Context, path, kfid string) (store.WeChatImport, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 100<<20 {
		return store.WeChatImport{}, errors.New("旧状态文件不存在或大小异常")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return store.WeChatImport{}, errors.New("旧状态路径无效")
	}
	sourceURL := url.URL{Scheme: "file", Path: absolute, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", sourceURL.String())
	if err != nil {
		return store.WeChatImport{}, errors.New("无法打开旧状态数据库")
	}
	defer db.Close()
	snapshot, err := readSnapshot(ctx, db, kfid)
	if err != nil {
		return store.WeChatImport{}, errors.New("旧状态数据库结构或内容无效")
	}
	return snapshot, nil
}
func readSnapshot(ctx context.Context, db *sql.DB, kfid string) (store.WeChatImport, error) {
	result := store.WeChatImport{}
	// A read transaction also guarantees a consistent snapshot for a backup reader.
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var accounts int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM sync WHERE kf<>?", kfid).Scan(&accounts); err != nil {
		return result, err
	}
	if accounts > 0 {
		return result, errors.New("legacy account mismatch")
	}
	err = tx.QueryRowContext(ctx, "SELECT cursor FROM sync WHERE kf=?", kfid).Scan(&result.Cursor)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,COALESCE(payload,''),state,attempts,next_at,COALESCE(error,''),COALESCE(memo,'') FROM jobs")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var job store.WeChatJob
		var next float64
		if err = rows.Scan(&job.ID, &job.Payload, &job.State, &job.Attempts, &next, &job.Error, &job.Memo); err != nil {
			return result, err
		}
		job.NextAt = int64(next)
		job.Kind = "legacy"
		job.CreatedAt = time.Now().Unix()
		if job.Error != "" {
			job.Error = "旧服务处理失败，详情保留在迁移备份"
		}
		if strings.HasPrefix(job.Memo, "memos/") {
			job.Memo = strings.TrimPrefix(job.Memo, "memos/")
		} else {
			job.Memo = ""
		}
		if job.Payload != "" {
			var message core.Message
			if err = json.Unmarshal([]byte(job.Payload), &message); err != nil {
				return result, err
			}
			job.User = textValue(message["external_userid"])
			job.Kind = textValue(message["msgtype"])
			if textValue(message["msgid"]) != job.ID || message["open_kfid"] != kfid {
				return result, errors.New("legacy payload mismatch")
			}
			if sent, ok := message["send_time"].(float64); ok {
				job.CreatedAt = int64(sent)
			}
		} else if job.State != "done" {
			return result, errors.New("legacy job missing payload")
		}
		result.Jobs = append(result.Jobs, job)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,user,content,state,attempts,next_at,created,COALESCE(error,'') FROM replies")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var reply store.WeChatReply
		var next, created float64
		if err = rows.Scan(&reply.ID, &reply.User, &reply.Content, &reply.State, &reply.Attempts, &next, &created, &reply.Error); err != nil {
			return result, err
		}
		reply.NextAt = int64(next)
		reply.CreatedAt = int64(created)
		if reply.Error != "" {
			reply.Error = "旧服务回执异常，详情保留在迁移备份"
		}
		result.Replies = append(result.Replies, reply)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT user,latest,used FROM reply_windows")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var window store.WeChatWindow
		var latest float64
		if err = rows.Scan(&window.User, &latest, &window.Used); err != nil {
			return result, err
		}
		window.Latest = int64(latest)
		result.Windows = append(result.Windows, window)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,event_type,payload,received_at FROM events")
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var event store.WeChatEvent
		var received float64
		if err = rows.Scan(&event.ID, &event.Type, &event.Payload, &received); err != nil {
			return result, err
		}
		event.ReceivedAt = int64(received)
		var message map[string]any
		if err = json.Unmarshal([]byte(event.Payload), &message); err != nil {
			return result, err
		}
		if nested, ok := message["event"].(map[string]any); ok {
			delete(nested, "welcome_code")
		}
		delete(message, "welcome_code")
		clean, err := json.Marshal(message)
		if err != nil {
			return result, err
		}
		event.Payload = string(clean)
		result.Events = append(result.Events, event)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func textValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
