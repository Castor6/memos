package test

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	core "github.com/usememos/memos/internal/wechatkf"
	storepb "github.com/usememos/memos/proto/gen/store"
	"github.com/usememos/memos/store"
)

func wechatFileFixture(t *testing.T) (*store.Store, store.WeChatJob, int64) {
	t.Helper()
	ctx := context.Background()
	s := NewTestingStore(ctx, t)
	t.Cleanup(func() { _ = s.Close() })
	now := time.Now().Unix()
	_, err := s.AcquireWeChatConsumer(ctx, "worker", 0, now)
	require.NoError(t, err)
	require.NoError(t, s.AcceptWeChatPage(ctx, "worker", 0, "cursor", []core.Message{kfInput("article", now)}, kfScope(), now))
	job, err := s.NextWeChatJob(ctx, now)
	require.NoError(t, err)
	require.NotNil(t, job)
	return s, *job, now
}

func wechatMarkdownResult() store.WeChatReply {
	return store.WeChatReply{Kind: "file", Filename: "公众号文章.md", FileContent: "# 文章\n\n正文和图片引用。\n"}
}

func wechatUsed(t *testing.T, s *store.Store) int {
	t.Helper()
	var used int
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(context.Background(), "SELECT used FROM wechat_kf_windows").Scan(&used))
	return used
}

func TestWeChatFilePreparationAndCrashRecovery(t *testing.T) {
	ctx := context.Background()
	s, job, now := wechatFileFixture(t)
	result := wechatMarkdownResult()
	// Ordinary MySQL TEXT cannot hold this result; the file column must support it.
	result.FileContent = strings.Repeat("article body\n", 8000)
	require.NoError(t, s.CompleteWeChatResult(ctx, "worker", 0, job, "memo", result, now))
	require.NoError(t, s.CompleteWeChatResult(ctx, "worker", 0, job, "memo", result, now))
	allowed := map[string]bool{"owner": true}
	reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, allowed, false)
	require.NoError(t, err)
	require.NotNil(t, reply, "article results bypass only the ordinary receipt preference")
	require.True(t, reply.Required)
	require.Equal(t, "preparing", reply.State)
	require.Equal(t, result.FileContent, reply.FileContent)
	require.Equal(t, result.Filename, reply.Filename)
	require.Zero(t, wechatUsed(t, s), "upload does not spend a user-visible send")
	require.NoError(t, s.ReleaseWeChatConsumer(ctx, "worker"))
	acquired, err := s.AcquireWeChatConsumer(ctx, "restarted", 0, now)
	require.NoError(t, err)
	require.True(t, acquired)
	reply, err = s.ReserveWeChatReply(ctx, "restarted", 0, now, allowed, false)
	require.NoError(t, err)
	require.NotNil(t, reply, "an interrupted upload is safe to retry")
	require.Equal(t, result.FileContent, reply.FileContent)
	started, err := s.StartWeChatFileReply(ctx, "restarted", 0, *reply, now)
	require.NoError(t, err)
	require.True(t, started)
	require.Equal(t, 1, wechatUsed(t, s))
	started, err = s.StartWeChatFileReply(ctx, "restarted", 0, *reply, now)
	require.NoError(t, err)
	require.False(t, started, "dispatch may only be reserved once")
	require.Equal(t, 1, wechatUsed(t, s))
	require.NoError(t, s.ReleaseWeChatConsumer(ctx, "restarted"))
	_, err = s.AcquireWeChatConsumer(ctx, "third", 0, now)
	require.NoError(t, err)
	status, err := s.WeChatStatus(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 1, status.Replies["unknown"])
	var content sql.NullString
	require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT file_content FROM wechat_kf_replies").Scan(&content))
	require.False(t, content.Valid)
	reply, err = s.ReserveWeChatReply(ctx, "third", 0, now, allowed)
	require.NoError(t, err)
	require.Nil(t, reply, "an interrupted actual send must not be replayed")
}

func TestWeChatFileValidationRollsBackCompletion(t *testing.T) {
	ctx := context.Background()
	s, job, now := wechatFileFixture(t)
	for _, bad := range []store.WeChatReply{
		{Kind: "file", Filename: "../private.md", FileContent: "private article"},
		{Kind: "file", Filename: "article.md", FileContent: "short"},
		{Kind: "file", Filename: "article.md", FileContent: strings.Repeat("x", 1<<20+1)},
		{Kind: "file", Filename: "article.md", FileContent: "invalid\xff"},
		{Kind: "file", Filename: "article\n.md", FileContent: "private article"},
		{Kind: "html", Content: "private article"},
	} {
		require.Error(t, s.CompleteWeChatResult(ctx, "worker", 0, job, "memo", bad, now))
		pending, err := s.NextWeChatJob(ctx, now)
		require.NoError(t, err)
		require.NotNil(t, pending)
		require.NotEmpty(t, pending.Payload, "failed result persistence must retain the original job")
		status, err := s.WeChatStatus(ctx)
		require.NoError(t, err)
		require.Empty(t, status.Replies)
	}
}

func TestWeChatFileUploadFailureBecomesRequiredText(t *testing.T) {
	ctx := context.Background()
	s, job, now := wechatFileFixture(t)
	require.NoError(t, s.CompleteWeChatResult(ctx, "worker", 0, job, "memo", wechatMarkdownResult(), now))
	allowed := map[string]bool{"owner": true}
	for attempt := 1; attempt <= 4; attempt++ {
		reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, allowed, false)
		require.NoError(t, err)
		require.NotNil(t, reply)
		require.Equal(t, attempt, reply.Attempts)
		require.Equal(t, "preparing", reply.State)
		require.NoError(t, s.FinishWeChatFileUpload(ctx, "worker", 0, *reply, "微信网络请求失败或超时", now))
		require.Zero(t, wechatUsed(t, s))
		now += 3600
	}
	reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, allowed, false)
	require.NoError(t, err)
	require.NotNil(t, reply)
	require.Equal(t, "text", reply.Kind)
	require.True(t, reply.Required)
	require.Empty(t, reply.FileContent)
	require.Contains(t, reply.Content, "Markdown 文件上传失败：微信网络请求失败或超时")
	require.Equal(t, 1, reply.Attempts)
	require.Equal(t, 1, wechatUsed(t, s))
	// A late upload completion cannot undo the text fallback or spend another slot.
	started, err := s.StartWeChatFileReply(ctx, "worker", 0, *reply, now)
	require.NoError(t, err)
	require.False(t, started)
}

func TestWeChatFileWindowRecheckedAfterUpload(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "quota", true: "expired"}[expired], func(t *testing.T) {
			ctx := context.Background()
			s, job, now := wechatFileFixture(t)
			require.NoError(t, s.CompleteWeChatResult(ctx, "worker", 0, job, "memo", wechatMarkdownResult(), now))
			reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, map[string]bool{"owner": true})
			require.NoError(t, err)
			require.NotNil(t, reply)
			if expired {
				now += 48 * 3600
			} else {
				_, err = s.GetDriver().GetDB().ExecContext(ctx, "UPDATE wechat_kf_windows SET used=5")
				require.NoError(t, err)
			}
			started, err := s.StartWeChatFileReply(ctx, "worker", 0, *reply, now)
			require.NoError(t, err)
			require.False(t, started)
			var state string
			var content sql.NullString
			require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT state,file_content FROM wechat_kf_replies").Scan(&state, &content))
			if expired {
				require.Equal(t, "expired", state)
				require.False(t, content.Valid)
				require.Zero(t, wechatUsed(t, s))
			} else {
				require.Equal(t, "pending", state)
				require.True(t, content.Valid)
				require.Equal(t, 5, wechatUsed(t, s))
			}
		})
	}
}

func TestWeChatFileFinalStateAndFailureRace(t *testing.T) {
	for _, final := range []string{"sent", "unknown", "failed", "pending", "delivery_failed", "fallback"} {
		t.Run(final, func(t *testing.T) {
			ctx := context.Background()
			s, job, now := wechatFileFixture(t)
			require.NoError(t, s.CompleteWeChatResult(ctx, "worker", 0, job, "memo", wechatMarkdownResult(), now))
			reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, map[string]bool{"owner": true})
			require.NoError(t, err)
			require.NotNil(t, reply)
			started, err := s.StartWeChatFileReply(ctx, "worker", 0, *reply, now)
			require.NoError(t, err)
			require.True(t, started)
			if final == "delivery_failed" {
				event := core.Message{"msgtype": "event", "event": map[string]any{"open_kfid": "kf", "external_userid": "owner", "event_type": "msg_send_fail", "fail_msgid": reply.ID, "fail_type": 2}}
				require.NoError(t, s.AcceptWeChatPage(ctx, "worker", 0, "event", []core.Message{event}, kfScope(), now))
				require.NoError(t, s.FinishWeChatReply(ctx, "worker", 0, *reply, "sent", "", now))
				require.NoError(t, s.FallbackWeChatFileReply(ctx, "worker", 0, *reply, "late refusal", now))
			} else if final == "fallback" {
				require.NoError(t, s.FallbackWeChatFileReply(ctx, "worker", 0, *reply, "微信错误码 40007", now))
			} else {
				require.NoError(t, s.FinishWeChatReply(ctx, "worker", 0, *reply, final, "", now))
			}
			var state, kind, text string
			var content sql.NullString
			require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT state,kind,content,file_content FROM wechat_kf_replies WHERE filename<>''").Scan(&state, &kind, &text, &content))
			if final == "fallback" {
				require.Equal(t, "pending", state)
				require.Equal(t, "text", kind)
				require.Contains(t, text, "Markdown 文件发送失败：微信错误码 40007")
			} else {
				require.Equal(t, final, state)
			}
			require.Equal(t, final == "pending", content.Valid)
		})
	}
}

func TestWeChatDeliveryFailureNoticeIsRequiredAndIdempotent(t *testing.T) {
	for _, file := range []bool{false, true} {
		t.Run(map[bool]string{false: "text", true: "file"}[file], func(t *testing.T) {
			ctx := context.Background()
			s, job, now := wechatFileFixture(t)
			result := store.WeChatReply{Content: "链接保存成功"}
			if file {
				result = wechatMarkdownResult()
			}
			require.NoError(t, s.CompleteWeChatResult(ctx, "worker", 0, job, "memo", result, now))
			allowed := map[string]bool{"owner": true}
			reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, allowed)
			require.NoError(t, err)
			require.NotNil(t, reply)
			if file {
				started, err := s.StartWeChatFileReply(ctx, "worker", 0, *reply, now)
				require.NoError(t, err)
				require.True(t, started)
			}
			event := func(id, user, failed string) core.Message {
				return core.Message{"msgid": id, "msgtype": "event", "event": map[string]any{
					"open_kfid": "kf", "external_userid": user, "event_type": "msg_send_fail", "fail_msgid": failed, "fail_type": 2,
				}}
			}
			binding := kfScope()
			binding.AllowedUsers = append(binding.AllowedUsers, "other")
			require.NoError(t, s.AcceptWeChatPage(ctx, "worker", 0, "wrong-user", []core.Message{event("wrong-user", "other", reply.ID)}, binding, now))
			status, err := s.WeChatStatus(ctx)
			require.NoError(t, err)
			require.EqualValues(t, 1, status.Replies["sending"], "even authorized users cannot report another user's result")
			for _, id := range []string{"failure", "failure", "failure-again"} {
				require.NoError(t, s.AcceptWeChatPage(ctx, "worker", 0, id, []core.Message{event(id, "owner", reply.ID)}, binding, now))
			}
			// A successful API response or fallback racing with the event must not
			// overwrite the definitive asynchronous delivery failure.
			require.NoError(t, s.FinishWeChatReply(ctx, "worker", 0, *reply, "sent", "", now))
			require.NoError(t, s.FallbackWeChatFileReply(ctx, "worker", 0, *reply, "late refusal", now))
			status, err = s.WeChatStatus(ctx)
			require.NoError(t, err)
			require.EqualValues(t, 1, status.Replies["delivery_failed"])
			notice, err := s.ReserveWeChatReply(ctx, "worker", 0, now, allowed, false)
			require.NoError(t, err)
			if !file {
				require.Nil(t, notice, "ordinary text failures keep their existing behavior")
				require.Len(t, status.Replies, 1)
				return
			}
			require.EqualValues(t, 1, status.Replies["pending"], "duplicate events produce exactly one notice")
			require.NotNil(t, notice)
			require.Equal(t, core.ReplyID("delivery:"+reply.ID), notice.ID)
			require.Equal(t, "text", notice.Kind)
			require.True(t, notice.Required)
			require.Empty(t, notice.FileContent)
			require.Equal(t, "微信未能投递 Markdown 文件（失败类型 2）。", notice.Content)
			var content sql.NullString
			require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT file_content FROM wechat_kf_replies WHERE kind='file'").Scan(&content))
			require.False(t, content.Valid)
			// A failed notice must not recursively create another notice.
			require.NoError(t, s.AcceptWeChatPage(ctx, "worker", 0, "notice-failure", []core.Message{event("notice-failure", "owner", notice.ID), event("file-repeat", "owner", reply.ID)}, binding, now))
			next, err := s.ReserveWeChatReply(ctx, "worker", 0, now, allowed, false)
			require.NoError(t, err)
			require.Nil(t, next)
			status, err = s.WeChatStatus(ctx)
			require.NoError(t, err)
			require.EqualValues(t, 2, status.Replies["delivery_failed"])
			require.Len(t, status.Replies, 1)
		})
	}
}

func TestWeChatRequiredTextAndOrdinaryReceiptPreference(t *testing.T) {
	ctx := context.Background()
	s, job, now := wechatFileFixture(t)
	require.NoError(t, s.CompleteWeChatJob(ctx, "worker", 0, job, "memo", "链接保存成功", now))
	reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, map[string]bool{"owner": true}, false)
	require.NoError(t, err)
	require.Nil(t, reply)
	require.Zero(t, wechatUsed(t, s))
	require.NoError(t, s.AcceptWeChatPage(ctx, "worker", 0, "cursor2", []core.Message{kfInput("failure", now)}, kfScope(), now))
	next, err := s.NextWeChatJob(ctx, now)
	require.NoError(t, err)
	require.NotNil(t, next)
	next.Attempts = 11
	require.NoError(t, s.FailWeChatJob(ctx, "worker", 0, *next, "", "失败环节", "文章处理失败：具体原因", now, true))
	reply, err = s.ReserveWeChatReply(ctx, "worker", 0, now, map[string]bool{"owner": true}, false)
	require.NoError(t, err)
	require.NotNil(t, reply)
	require.True(t, reply.Required)
	require.Equal(t, "文章处理失败：具体原因", reply.Content)
	require.Empty(t, reply.FileContent)
}

func TestWeChatFileCancelledAndExpiredClearContent(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancelled", true: "expired"}[expired], func(t *testing.T) {
			ctx := context.Background()
			s, job, now := wechatFileFixture(t)
			require.NoError(t, s.CompleteWeChatResult(ctx, "worker", 0, job, "memo", wechatMarkdownResult(), now))
			if expired {
				now += 48 * 3600
			}
			reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, map[string]bool{})
			require.NoError(t, err)
			require.Nil(t, reply)
			var state, name string
			var content sql.NullString
			require.NoError(t, s.GetDriver().GetDB().QueryRowContext(ctx, "SELECT state,filename,file_content FROM wechat_kf_replies").Scan(&state, &name, &content))
			require.Equal(t, map[bool]string{false: "cancelled", true: "expired"}[expired], state)
			require.Equal(t, wechatMarkdownResult().Filename, name)
			require.False(t, content.Valid)
			require.Zero(t, wechatUsed(t, s))
		})
	}
}

func TestMigrationWeChatArticleReplies(t *testing.T) {
	ctx := context.Background()
	s, job, now := wechatFileFixture(t)
	require.NoError(t, s.CompleteWeChatJob(ctx, "worker", 0, job, "memo", "legacy text", now))
	// Reconstruct the immediately preceding schema while preserving an existing reply.
	for _, column := range []string{"kind", "filename", "file_content", "required"} {
		_, err := s.GetDriver().GetDB().ExecContext(ctx, "ALTER TABLE wechat_kf_replies DROP COLUMN "+column)
		require.NoError(t, err)
	}
	_, err := s.UpsertInstanceSetting(ctx, &storepb.InstanceSetting{
		Key:   storepb.InstanceSettingKey_BASIC,
		Value: &storepb.InstanceSetting_BasicSetting{BasicSetting: &storepb.InstanceBasicSetting{SchemaVersion: "0.30.7"}},
	})
	require.NoError(t, err)
	require.NoError(t, s.Migrate(ctx))
	require.NoError(t, s.Migrate(ctx))
	reply, err := s.ReserveWeChatReply(ctx, "worker", 0, now, map[string]bool{"owner": true})
	require.NoError(t, err)
	require.NotNil(t, reply)
	require.Equal(t, "text", reply.Kind)
	require.Equal(t, "legacy text", reply.Content)
	require.Empty(t, reply.Filename)
	require.Empty(t, reply.FileContent)
	require.False(t, reply.Required)
}
