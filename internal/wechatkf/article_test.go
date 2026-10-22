package wechatkf

import (
	"context"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/wechatarticle"
)

func articleMessage() Message {
	return Message{"msgid": "article", "msgtype": "link", "external_userid": "self", "open_kfid": "kf", "origin": 3,
		"link": map[string]any{"title": "卡片标题", "desc": "卡片描述", "url": "https://mp.weixin.qq.com/s/example"}}
}

func TestArticleCardReturnsFileAndKeepsCardMemo(t *testing.T) {
	const body = "正文\n\n![图片](https://mmbiz.qpic.cn/image)\n\n来源：作者在原文中的说明\n\n[原文链接](https://mp.weixin.qq.com/s/example)"
	notes := &recordingNotes{}
	p, err := NewProcessor(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"self"}}, notes, nil)
	require.NoError(t, err)
	p.SetArticleConverter(func(_ context.Context, source string) (wechatarticle.Result, error) {
		require.Equal(t, 1, notes.finished)
		require.Equal(t, "https://mp.weixin.qq.com/s/example", source)
		return wechatarticle.Result{Title: "标题/文件:*?", Markdown: body}, nil
	})
	out, err := p.Process(context.Background(), articleMessage())
	require.NoError(t, err)
	require.True(t, out.RequiredReply)
	require.NotEmpty(t, out.MemoID)
	require.Empty(t, out.Reply)
	require.NotNil(t, out.File)
	require.Equal(t, "标题_文件___.md", out.File.Filename)
	require.Equal(t, "text/markdown; charset=utf-8", out.File.Type)
	require.Equal(t, "# 标题/文件:\\*?\n\n"+body+"\n", string(out.File.Data))
	require.Contains(t, notes.content, "卡片标题")
	require.Contains(t, notes.content, "https://mp.weixin.qq.com/s/example")
	require.NotContains(t, notes.content, "![图片]")
}

func TestArticleFileMetadata(t *testing.T) {
	for _, test := range []struct {
		name     string
		result   wechatarticle.Result
		expected string
	}{
		{
			name: "all available fields",
			result: wechatarticle.Result{
				Author: "作者", AccountName: "公众号", PublishedAt: "2026年10月22日 13:54", IPLocation: "美国",
			},
			expected: "作者 · 公众号 · 2026年10月22日 13:54 · 美国",
		},
		{
			name:     "missing fields are omitted",
			result:   wechatarticle.Result{AccountName: "公众号", IPLocation: "广东"},
			expected: "公众号 · 广东",
		},
		{
			name:     "metadata stays on one plain text line",
			result:   wechatarticle.Result{Author: "作者\n\n# 注释", AccountName: "[公众号](https://example.com) <b>名</b>"},
			expected: "作者 \\# 注释 · \\[公众号\\]\\(https://example\\.com\\) &lt;b&gt;名&lt;/b&gt;",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			p, err := NewProcessor(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"self"}}, &recordingNotes{}, nil)
			require.NoError(t, err)
			p.SetArticleConverter(func(context.Context, string) (wechatarticle.Result, error) {
				result := test.result
				result.Title, result.Markdown = "文章标题", "原文正文\n"
				return result, nil
			})
			out, err := p.Process(context.Background(), articleMessage())
			require.NoError(t, err)
			require.NotNil(t, out.File)
			require.Equal(t, "# 文章标题\n\n"+test.expected+"\n\n原文正文\n", string(out.File.Data))
		})
	}
}

func TestLiveArticleCardMarkdown(t *testing.T) {
	address := os.Getenv("MEMOS_WECHAT_ARTICLE_URL")
	if address == "" {
		t.Skip("Optional live comparison downloads a public article through the production Go converter")
	}
	notes := &recordingNotes{}
	p, err := NewProcessor(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"self"}}, notes, nil)
	require.NoError(t, err)
	message := articleMessage()
	message["link"] = map[string]any{"title": "Article comparison", "url": address}
	out, err := p.Process(t.Context(), message)
	require.NoError(t, err)
	require.NotNil(t, out.File, out.Reply)
	require.Empty(t, out.Reply)
	require.Equal(t, 1, notes.finished)
	t.Logf("filename=%q markdown_bytes=%d images=%d", out.File.Filename, len(out.File.Data), strings.Count(string(out.File.Data), "!["))
	if output := os.Getenv("MEMOS_WECHAT_ARTICLE_OUTPUT"); output != "" {
		require.NoError(t, os.WriteFile(output, out.File.Data, 0600))
	}
}

func TestArticleConversionRequiresAuthorizedTopLevelCard(t *testing.T) {
	for _, kind := range []string{"stranger", "other-kf", "other-origin", "text", "merged_msg", "external-link"} {
		t.Run(kind, func(t *testing.T) {
			message := articleMessage()
			switch kind {
			case "stranger":
				message["external_userid"] = "stranger"
			case "other-kf":
				message["open_kfid"] = "other"
			case "other-origin":
				message["origin"] = 4
			case "text":
				message["msgtype"] = "text"
				message["text"] = map[string]any{"content": "https://mp.weixin.qq.com/s/example"}
			case "merged_msg":
				message["msgtype"] = "merged_msg"
				message["merged_msg"] = map[string]any{"item": []any{map[string]any{"msgtype": "link", "msg_content": map[string]any{"link": message["link"]}}}}
			case "external-link":
				message["link"] = map[string]any{"url": "https://example.com/article"}
			default:
				t.Fatalf("unknown test case %q", kind)
			}
			p, err := NewProcessor(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"self"}}, &recordingNotes{}, nil)
			require.NoError(t, err)
			p.SetArticleConverter(func(context.Context, string) (wechatarticle.Result, error) {
				t.Fatal("non-article input reached converter")
				return wechatarticle.Result{}, nil
			})
			out, err := p.Process(context.Background(), message)
			require.NoError(t, err)
			require.False(t, out.RequiredReply)
			require.Nil(t, out.File)
		})
	}
}

func TestArticleFailureIsImmediateAndSafe(t *testing.T) {
	for _, test := range []struct {
		name     string
		err      error
		markdown string
		reason   string
	}{
		{name: "verify", err: &wechatarticle.Error{Reason: "微信要求完成验证"}, reason: "微信要求完成验证"},
		{name: "unknown", err: errors.New("secret https://example.com/private-token"), reason: "内部转换失败"},
		{name: "empty", reason: "未取得可转换的文章正文"},
		{name: "large", markdown: strings.Repeat("x", 1<<20), reason: "超过 1 MB"},
	} {
		t.Run(test.name, func(t *testing.T) {
			p, err := NewProcessor(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"self"}}, &recordingNotes{}, nil)
			require.NoError(t, err)
			p.SetArticleConverter(func(context.Context, string) (wechatarticle.Result, error) {
				return wechatarticle.Result{Markdown: test.markdown}, test.err
			})
			out, err := p.Process(context.Background(), articleMessage())
			require.NoError(t, err)
			require.True(t, out.RequiredReply)
			require.Nil(t, out.File)
			require.Contains(t, out.Reply, test.reason)
			require.Contains(t, out.Reply, "原链接已保存")
			require.NotContains(t, out.Reply, "private-token")
		})
	}
}

func TestArticleCancellationDoesNotQueueFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	p, err := NewProcessor(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"self"}}, &recordingNotes{}, nil)
	require.NoError(t, err)
	p.SetArticleConverter(func(context.Context, string) (wechatarticle.Result, error) {
		cancel()
		return wechatarticle.Result{}, ctx.Err()
	})
	out, err := p.Process(ctx, articleMessage())
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, out.Reply)
	require.Nil(t, out.File)
}

func TestArticleFilenameHasBoundedValidUTF8(t *testing.T) {
	name := articleFilename(strings.Repeat("文章", 100))
	require.True(t, utf8.ValidString(name))
	require.LessOrEqual(t, len(name), 240)
	require.True(t, strings.HasSuffix(name, ".md"))
	require.Equal(t, "公众号文章.md", articleFilename(" .. "))
}
