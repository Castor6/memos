package test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	core "github.com/usememos/memos/internal/wechatkf"
	"github.com/usememos/memos/store"
)

func kfInput(id string, nowSec int64) core.Message {
	return core.Message{"msgid": id, "origin": 3, "msgtype": "text", "external_userid": "owner", "open_kfid": "kf", "send_time": nowSec, "text": map[string]any{"content": "private #tag"}}
}
func kfScope() core.Binding {
	return core.Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"owner"}}
}
func TestWeChatQueueAtomicityAndLease(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	defer s.Close()
	nowSec := time.Now().Unix()
	acquired, err := s.AcquireWeChatConsumer(ctx, "first", 0, nowSec)
	require.NoError(t, err)
	require.True(t, acquired)
	acquired, err = s.AcquireWeChatConsumer(ctx, "second", 0, nowSec)
	require.NoError(t, err)
	require.False(t, acquired)
	require.ErrorIs(t, s.AcceptWeChatPage(ctx, "second", 0, "bad", []core.Message{kfInput("no", nowSec)}, kfScope(), nowSec), store.ErrWeChatLease)
	require.NoError(t, s.SignalWeChat(ctx, 0, "callback-capability", nowSec))
	before, err := s.ReadWeChatSync(ctx)
	require.NoError(t, err)
	bad := kfInput("", nowSec)
	require.Error(t, s.AcceptWeChatPage(ctx, "first", 0, "not-committed", []core.Message{kfInput("a", nowSec), bad}, kfScope(), nowSec))
	job, err := s.NextWeChatJob(ctx, nowSec)
	require.NoError(t, err)
	require.Nil(t, job)
	sync, err := s.ReadWeChatSync(ctx)
	require.NoError(t, err)
	require.Equal(t, "", sync.Cursor)
	stranger := kfInput("stranger", nowSec)
	stranger["external_userid"] = "stranger"
	require.NoError(t, s.AcceptWeChatPage(ctx, "first", 0, "cursor", []core.Message{kfInput("a", nowSec), stranger, kfInput("a", nowSec)}, kfScope(), nowSec))
	job, err = s.NextWeChatJob(ctx, nowSec)
	require.NoError(t, err)
	require.Equal(t, "a", job.ID)
	require.NoError(t, s.SignalWeChat(ctx, 0, "new-capability", nowSec))
	require.NoError(t, s.FinishWeChatSync(ctx, "first", 0, before.Generation, nowSec+300, ""))
	sync, err = s.ReadWeChatSync(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(0), sync.NextAt)
	require.NoError(t, s.CompleteWeChatJob(ctx, "first", 0, *job, "memo", "文字保存成功", nowSec))
	require.NoError(t, s.CompleteWeChatJob(ctx, "first", 0, *job, "memo", "文字保存成功", nowSec))
	var payload *string
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT payload FROM wechat_kf_jobs WHERE id='a'").Scan(&payload))
	require.Nil(t, payload)
	stats, err := s.WeChatStatus(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), stats.Jobs["done"])
	require.Equal(t, int64(1), stats.Replies["pending"])
	require.Empty(t, stats.Sync.Token)
	require.Empty(t, stats.Sync.Cursor)
	require.Empty(t, stats.Recent[0].Payload)
	require.Empty(t, stats.Recent[0].User)
	require.NoError(t, s.SaveWeChatConfiguration(ctx, "encrypted", 0))
	require.ErrorIs(t, s.RenewWeChatConsumer(ctx, "first", 0, nowSec), store.ErrWeChatLease)
	require.ErrorIs(t, s.SaveWeChatConfiguration(ctx, "stale", 0), store.ErrWeChatLease)
}
func TestWeChatReplyQuotaRecoveryAndEvents(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	defer s.Close()
	nowSec := time.Now().Unix()
	_, err := s.AcquireWeChatConsumer(ctx, "first", 0, nowSec)
	require.NoError(t, err)
	inputs := []core.Message{}
	for _, id := range []string{"a", "b", "c", "d", "e", "f"} {
		inputs = append(inputs, kfInput(id, nowSec))
	}
	require.NoError(t, s.AcceptWeChatPage(ctx, "first", 0, "cursor", inputs, kfScope(), nowSec))
	for range 6 {
		job, err := s.NextWeChatJob(ctx, nowSec)
		require.NoError(t, err)
		require.NotNil(t, job)
		require.NoError(t, s.CompleteWeChatJob(ctx, "first", 0, *job, "memo", "文字保存成功", nowSec))
	}
	allowed := map[string]bool{"owner": true}
	var interrupted *store.WeChatReply
	for range 5 {
		reply, err := s.ReserveWeChatReply(ctx, "first", 0, nowSec, allowed)
		require.NoError(t, err)
		require.NotNil(t, reply)
		interrupted = reply
	}
	reply, err := s.ReserveWeChatReply(ctx, "first", 0, nowSec, allowed)
	require.NoError(t, err)
	require.Nil(t, reply)
	// Duplicate input must not replenish the reply window.
	require.NoError(t, s.AcceptWeChatPage(ctx, "first", 0, "cursor", inputs, kfScope(), nowSec))
	reply, err = s.ReserveWeChatReply(ctx, "first", 0, nowSec, allowed)
	require.NoError(t, err)
	require.Nil(t, reply)
	require.NoError(t, s.ReleaseWeChatConsumer(ctx, "first"))
	acquired, err := s.AcquireWeChatConsumer(ctx, "second", 0, nowSec)
	require.NoError(t, err)
	require.True(t, acquired)
	stats, err := s.WeChatStatus(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(5), stats.Replies["unknown"])
	require.NoError(t, s.AcceptWeChatPage(ctx, "second", 0, "next", []core.Message{kfInput("new", nowSec+1)}, kfScope(), nowSec+1))
	reply, err = s.ReserveWeChatReply(ctx, "second", 0, nowSec+1, allowed)
	require.NoError(t, err)
	require.NotNil(t, reply)
	event := core.Message{"msgtype": "event", "event": map[string]any{"open_kfid": "kf", "external_userid": "owner", "event_type": "msg_send_fail", "fail_msgid": reply.ID, "fail_type": 2, "welcome_code": "sensitive-capability"}}
	require.NoError(t, s.AcceptWeChatPage(ctx, "second", 0, "event", []core.Message{event}, kfScope(), nowSec+1))
	require.NoError(t, s.FinishWeChatReply(ctx, "second", 0, *reply, "sent", "", nowSec+1))
	stats, err = s.WeChatStatus(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), stats.Replies["delivery_failed"])
	var payload string
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT payload FROM wechat_kf_events").Scan(&payload))
	require.NotContains(t, payload, "welcome_code")
	require.NotContains(t, payload, "sensitive-capability")
	require.NotNil(t, interrupted)
}
func TestWeChatRetriesAndExpiry(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	defer s.Close()
	nowSec := time.Now().Unix()
	_, err := s.AcquireWeChatConsumer(ctx, "worker", 0, nowSec)
	require.NoError(t, err)
	require.NoError(t, s.AcceptWeChatPage(ctx, "worker", 0, "cursor", []core.Message{kfInput("a", nowSec)}, kfScope(), nowSec))
	due := nowSec
	for attempt := 1; attempt <= 12; attempt++ {
		job, err := s.NextWeChatJob(ctx, due)
		require.NoError(t, err)
		require.NotNil(t, job)
		require.NoError(t, s.FailWeChatJob(ctx, "worker", 0, *job, "memo", "具体失败原因", "文件部分保存", due))
		stats, err := s.WeChatStatus(ctx)
		require.NoError(t, err)
		if attempt < 12 {
			require.Empty(t, stats.Replies)
			due += 3600
		} else {
			require.Equal(t, int64(1), stats.Jobs["failed"])
			require.Equal(t, int64(1), stats.Replies["pending"])
		}
	}
	reply, err := s.ReserveWeChatReply(ctx, "worker", 0, nowSec+49*3600, map[string]bool{"owner": true})
	require.NoError(t, err)
	require.Nil(t, reply)
	stats, err := s.WeChatStatus(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), stats.Replies["expired"])
	var raw string
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT payload FROM wechat_kf_jobs").Scan(&raw))
	require.True(t, json.Valid([]byte(raw)))
}

func TestWeChatImportIdempotency(t *testing.T) {
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	defer s.Close()
	nowSec := time.Now().Unix()
	snapshot := store.WeChatImport{Cursor: "legacy-cursor", Jobs: []store.WeChatJob{{ID: "already-saved", Kind: "legacy", State: "done", Memo: "wkf-existing", CreatedAt: nowSec}}, Replies: []store.WeChatReply{{ID: "already-sent", User: "owner", Content: "文字保存成功", State: "sent", Attempts: 1, CreatedAt: nowSec}, {ID: "interrupted", User: "owner", Content: "图片保存成功", State: "sending", Attempts: 1, CreatedAt: nowSec}}, Windows: []store.WeChatWindow{{User: "owner", Latest: nowSec, Used: 2}}}
	counts, err := s.ImportWeChatState(ctx, snapshot, "sealed-config", 0)
	require.NoError(t, err)
	require.Equal(t, 1, counts.Jobs)
	require.Equal(t, 2, counts.Replies)
	counts, err = s.ImportWeChatState(ctx, snapshot, "sealed-config", 1)
	require.NoError(t, err)
	require.Equal(t, store.WeChatImportCounts{}, counts)
	stats, err := s.WeChatStatus(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(1), stats.Replies["sent"])
	require.Equal(t, int64(1), stats.Replies["unknown"])
	sync, err := s.ReadWeChatSync(ctx)
	require.NoError(t, err)
	require.Equal(t, "legacy-cursor", sync.Cursor)
	require.Empty(t, sync.Token)
	acquired, err := s.AcquireWeChatConsumer(ctx, "worker", 2, nowSec)
	require.NoError(t, err)
	require.True(t, acquired)
	_, err = s.ImportWeChatState(ctx, snapshot, "sealed-config", 2)
	require.ErrorIs(t, err, store.ErrWeChatLease)
	require.NoError(t, s.AcceptWeChatPage(ctx, "worker", 2, "new-cursor", []core.Message{kfInput("already-saved", nowSec)}, kfScope(), nowSec))
	job, err := s.NextWeChatJob(ctx, nowSec)
	require.NoError(t, err)
	require.Nil(t, job)
	reply, err := s.ReserveWeChatReply(ctx, "worker", 2, nowSec, map[string]bool{"owner": true})
	require.NoError(t, err)
	require.Nil(t, reply)
	require.NoError(t, s.ReleaseWeChatConsumer(ctx, "worker"))
	_, err = s.ImportWeChatState(ctx, snapshot, "sealed-config", 2)
	require.NoError(t, err)
	sync, err = s.ReadWeChatSync(ctx)
	require.NoError(t, err)
	require.Equal(t, "new-cursor", sync.Cursor)
	// Bad input must roll back every inserted row and the configuration revision.
	snapshot.Jobs = []store.WeChatJob{{ID: "valid-first", State: "done", Kind: "legacy"}, {ID: "", State: "broken"}}
	_, err = s.ImportWeChatState(ctx, snapshot, "sealed-config", 3)
	require.Error(t, err)
	var count int
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT count(*) FROM wechat_kf_jobs WHERE id='valid-first'").Scan(&count))
	require.Zero(t, count)
}
