package wechatkf

import (
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTagsAndLiteralContent(t *testing.T) {
	input := "想法 #工作 #工作 #研究/微信\nhttps://example.com/#fragment `#code` <script>alert(1)</script>"
	message := Message{"msgtype": "text", "text": map[string]any{"content": input}, "mentioned_list": []any{}}
	clip, err := Render(message, []string{"微信剪藏"}, "微信聊天记录", nil)
	require.NoError(t, err)
	require.Equal(t, []string{"微信剪藏", "工作", "研究/微信"}, clip.Tags)
	require.NotContains(t, clip.Content, "#工作")
	require.Contains(t, clip.Content, `\#fragment`)
	require.Contains(t, clip.Content, `\#code`)
	require.Contains(t, clip.Content, "&lt;script&gt;")
	require.NotContains(t, clip.Content, "mentioned_list")
	require.Equal(t, input, message["text"].(map[string]any)["content"])
}

func TestRenderSupportedTypes(t *testing.T) {
	for _, kind := range []string{"text", "image", "voice", "video", "file", "link", "location", "miniprogram", "channels", "channels_shop_product", "channels_shop_order"} {
		t.Run(kind, func(t *testing.T) {
			calls := 0
			data := map[string]any{"content": "hello", "media_id": "media", "title": "title", "url": "https://example.com/article", "name": "地点", "appid": "test-app", "product_id": "p1", "order_id": "o1"}
			clip, err := Render(Message{"msgtype": kind, kind: data}, nil, "chat", func(id, received string) (string, error) {
				calls++
				require.Equal(t, "media", id)
				require.Equal(t, kind, received)
				return "attachment", nil
			})
			require.NoError(t, err)
			require.NotEmpty(t, clip.Content)
			require.Empty(t, clip.Issues)
			require.NotEqual(t, "未知类型消息", Label(kind))
			if kind == "image" || kind == "voice" || kind == "video" || kind == "file" {
				require.Equal(t, 1, calls)
			}
		})
	}
}
func TestChatKeepsHistoricalTagsAndReportsPartial(t *testing.T) {
	message := Message{"msgtype": "merged_msg", "merged_msg": map[string]any{"title": "讨论", "item": []any{
		map[string]any{"sender_name": "Alice", "send_time": 1700000000, "msgtype": "text", "msg_content": `{"text":{"content":"历史 #标签"}}`},
		map[string]any{"sender_name": "Bob", "send_time": 1700000001, "msgtype": "note", "msg_content": map[string]any{"note": map[string]any{}}},
		map[string]any{"msg_content": "not json"},
	}}}
	clip, err := Render(message, []string{"微信剪藏"}, "微信聊天记录", nil)
	require.NoError(t, err)
	require.Equal(t, []string{"微信剪藏", "微信聊天记录"}, clip.Tags)
	require.Contains(t, clip.Content, `历史 \#标签`)
	require.Contains(t, clip.Content, "Alice · 2023-11-15 06:13:20")
	require.Len(t, clip.Issues, 2)
	note, err := Render(Message{"msgtype": "note"}, nil, "", nil)
	require.NoError(t, err)
	require.True(t, note.Unsupported)
	require.Empty(t, note.Content)
}
func TestRenderMalformedAndUnsafeInput(t *testing.T) {
	for _, message := range []Message{
		{"msgtype": "future", "future": map[string]any{"raw": "```\n<script>"}},
		{"msgtype": "image", "image": map[string]any{}},
		{"msgtype": "merged_msg", "merged_msg": map[string]any{"item": "invalid"}},
		{"msgtype": "text", "text": false},
	} {
		clip, err := Render(message, nil, "", nil)
		require.NoError(t, err)
		require.NotEmpty(t, clip.Issues)
	}
	clip, err := Render(Message{"msgtype": "link", "link": map[string]any{"url": "javascript:alert(1)"}}, nil, "", nil)
	require.NoError(t, err)
	require.NotContains(t, clip.Content, "<javascript:")
	_, err = Render(Message{"msgtype": "file", "file": map[string]any{"media_id": "m"}}, nil, "", func(string, string) (string, error) { return "", errors.New("download") })
	require.EqualError(t, err, "download")
	require.Equal(t, "![图片](/file/attachments/id/a%29%5D%28bad.png)", AttachmentReference("attachments/id", "a)](bad.png", "image"))
	deep := map[string]any{"msgtype": "text", "text": map[string]any{"content": "deep"}}
	for range 10 {
		deep = map[string]any{"msgtype": "merged_msg", "merged_msg": map[string]any{"item": []any{map[string]any{"msg_content": deep}}}}
	}
	clip, err = Render(Message(deep), nil, "", nil)
	require.NoError(t, err)
	require.Contains(t, strings.Join(clip.Issues, ""), "超过 8 层")
}
func TestStableIDsMatchLegacy(t *testing.T) {
	require.Equal(t, "wkf-"+"3ce7497261e49307e961617bee08142d", StableID("corp", "kf", "message"))
	require.Len(t, ReplyID("message"), 32)
}
