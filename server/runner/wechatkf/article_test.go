package wechatkf

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/wechatarticle"
	core "github.com/usememos/memos/internal/wechatkf"
	"github.com/usememos/memos/store"
)

func TestArticleResultIsSentWithReceiptsDisabled(t *testing.T) {
	for _, conversionFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "file", true: "reason"}[conversionFails], func(t *testing.T) {
			ts, runner, config := configured(t)
			config.Receipts = false
			ctx := context.Background()
			_, err := ts.Store.AcquireWeChatConsumer(ctx, "article-worker", 0, time.Now().Unix())
			require.NoError(t, err)
			remote := &fakeRemote{message: core.Message{"msgid": "article", "msgtype": "link", "external_userid": "self", "open_kfid": "kf", "origin": 3, "send_time": time.Now().Unix(), "link": map[string]any{"title": "卡片", "url": "https://mp.weixin.qq.com/s/example"}}}
			processor, err := core.NewProcessor(config.Binding, runner.notes(config), remote.Download)
			require.NoError(t, err)
			conversions := 0
			processor.SetArticleConverter(func(context.Context, string) (wechatarticle.Result, error) {
				conversions++
				if conversionFails {
					return wechatarticle.Result{}, &wechatarticle.Error{Reason: "微信要求完成验证"}
				}
				return wechatarticle.Result{Title: "文章", Markdown: "完整正文"}, nil
			})
			for range 2 {
				require.NoError(t, runner.tick(ctx, "article-worker", 0, config, remote, processor))
			}
			require.Equal(t, 1, conversions)
			require.Equal(t, 1, remote.sends)
			if conversionFails {
				require.Zero(t, remote.uploads)
				require.Equal(t, []string{"文章转换失败：微信要求完成验证。原链接已保存。"}, remote.texts)
			} else {
				require.Equal(t, 1, remote.files)
				require.Equal(t, 1, remote.uploads)
				require.Empty(t, remote.texts)
				require.Equal(t, "文章.md", remote.lastFile.Filename)
				require.Contains(t, string(remote.lastFile.Data), "完整正文")
			}
			memos, err := ts.Store.ListMemos(ctx, &store.FindMemo{})
			require.NoError(t, err)
			require.Len(t, memos, 1)
			require.Equal(t, store.Private, memos[0].Visibility)
			status, err := ts.Store.WeChatStatus(ctx)
			require.NoError(t, err)
			require.EqualValues(t, 1, status.Jobs["done"])
			require.EqualValues(t, 1, status.Replies["sent"])
		})
	}
}

func TestArticleUploadRetriesWithoutConversionOrQuota(t *testing.T) {
	ts, runner, config := configured(t)
	ctx := context.Background()
	_, err := ts.Store.AcquireWeChatConsumer(ctx, "article-worker", 0, time.Now().Unix())
	require.NoError(t, err)
	remote := &fakeRemote{uploadError: &core.RemoteError{Category: "network"}, message: core.Message{"msgid": "article", "msgtype": "link", "external_userid": "self", "open_kfid": "kf", "origin": 3, "send_time": time.Now().Unix(), "link": map[string]any{"url": "https://mp.weixin.qq.com/s/example"}}}
	processor, err := core.NewProcessor(config.Binding, runner.notes(config), remote.Download)
	require.NoError(t, err)
	conversions := 0
	processor.SetArticleConverter(func(context.Context, string) (wechatarticle.Result, error) {
		conversions++
		return wechatarticle.Result{Title: "文章", Markdown: "生成的正文"}, nil
	})
	for range 4 {
		require.NoError(t, runner.tick(ctx, "article-worker", 0, config, remote, processor))
		_, err = ts.Store.GetDriver().GetDB().ExecContext(ctx, "UPDATE wechat_kf_replies SET next_at=0")
		require.NoError(t, err)
	}
	require.Equal(t, 1, conversions)
	require.Equal(t, 4, remote.uploads)
	require.Zero(t, remote.files)
	var used int
	require.NoError(t, ts.Store.GetDriver().GetDB().QueryRowContext(ctx, "SELECT used FROM wechat_kf_windows").Scan(&used))
	require.Zero(t, used)
	require.NoError(t, runner.tick(ctx, "article-worker", 0, config, remote, processor))
	require.Len(t, remote.texts, 1)
	require.Contains(t, remote.texts[0], "上传失败")
	require.Contains(t, remote.texts[0], "微信网络请求失败或超时")
}

func TestArticleAmbiguousSendDoesNotRepeat(t *testing.T) {
	ts, runner, config := configured(t)
	ctx := context.Background()
	_, err := ts.Store.AcquireWeChatConsumer(ctx, "article-worker", 0, time.Now().Unix())
	require.NoError(t, err)
	remote := &fakeRemote{sendError: &core.RemoteError{Category: "network", Unknown: true}, message: core.Message{"msgid": "article", "msgtype": "link", "external_userid": "self", "open_kfid": "kf", "origin": 3, "send_time": time.Now().Unix(), "link": map[string]any{"url": "https://mp.weixin.qq.com/s/example"}}}
	processor, err := core.NewProcessor(config.Binding, runner.notes(config), remote.Download)
	require.NoError(t, err)
	processor.SetArticleConverter(func(context.Context, string) (wechatarticle.Result, error) {
		return wechatarticle.Result{Title: "文章", Markdown: "生成的正文"}, nil
	})
	for range 2 {
		require.NoError(t, runner.tick(ctx, "article-worker", 0, config, remote, processor))
	}
	require.Equal(t, 1, remote.files)
	require.Equal(t, 1, remote.uploads)
	require.Empty(t, remote.texts)
	status, err := ts.Store.WeChatStatus(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 1, status.Replies["unknown"])
}

func TestArticleRejectedFileFallsBackToReason(t *testing.T) {
	ts, runner, config := configured(t)
	config.Receipts = false
	ctx := context.Background()
	_, err := ts.Store.AcquireWeChatConsumer(ctx, "article-worker", 0, time.Now().Unix())
	require.NoError(t, err)
	remote := &fakeRemote{sendError: &core.RemoteError{Category: "api", Code: 40007}, message: core.Message{"msgid": "article", "msgtype": "link", "external_userid": "self", "open_kfid": "kf", "origin": 3, "send_time": time.Now().Unix(), "link": map[string]any{"url": "https://mp.weixin.qq.com/s/example"}}}
	processor, err := core.NewProcessor(config.Binding, runner.notes(config), remote.Download)
	require.NoError(t, err)
	conversions := 0
	processor.SetArticleConverter(func(context.Context, string) (wechatarticle.Result, error) {
		conversions++
		return wechatarticle.Result{Title: "文章", Markdown: "生成的正文"}, nil
	})
	for range 4 {
		require.NoError(t, runner.tick(ctx, "article-worker", 0, config, remote, processor))
		_, err = ts.Store.GetDriver().GetDB().ExecContext(ctx, "UPDATE wechat_kf_replies SET next_at=0")
		require.NoError(t, err)
	}
	require.Equal(t, 1, conversions)
	require.Equal(t, 4, remote.files)
	require.Empty(t, remote.texts)
	remote.sendError = nil
	require.NoError(t, runner.tick(ctx, "article-worker", 0, config, remote, processor))
	require.Len(t, remote.texts, 1)
	require.Contains(t, remote.texts[0], "Markdown 文件发送失败")
	require.Equal(t, 4, remote.files)
	status, err := ts.Store.WeChatStatus(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 1, status.Replies["sent"])
}
