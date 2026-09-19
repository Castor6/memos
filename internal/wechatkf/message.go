package wechatkf

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"html"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/pkg/errors"
)

// Message preserves unknown WeChat fields without defining a lossy closed schema.
type Message map[string]any

// Clip contains a memo's final content and explicit tags, with honest completeness information.
type Clip struct {
	Content     string
	Tags        []string
	Issues      []string
	Unsupported bool
}

// MediaReference resolves an official media ID to a Memos attachment reference.
// Implementations must not download arbitrary URLs contained in messages.
type MediaReference func(id, kind string) (string, error)

// StableID keeps the existing Python bridge's memo/attachment IDs across migration.
func StableID(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return "wkf-" + hex.EncodeToString(sum[:16])
}

// ReplyID keeps WeChat result identifiers within the API's 32-byte limit.
func ReplyID(messageID string) string {
	sum := sha256.Sum256([]byte("result:" + messageID))
	return hex.EncodeToString(sum[:16])
}

var labels = map[string]string{"text": "文字", "image": "图片", "voice": "语音", "video": "视频", "file": "文件", "link": "链接", "location": "位置", "miniprogram": "小程序", "channels": "视频号", "channels_shop_product": "视频号商品", "channels_shop_order": "视频号订单", "merged_msg": "聊天记录", "note": "微信笔记"}

func Label(kind string) string {
	if v, ok := labels[kind]; ok {
		return v
	}
	return "未知类型消息"
}

// Render builds an explicit-tag memo. A top-level WeChat note has no content to save.
func Render(message Message, defaults []string, chatTag string, media MediaReference) (Clip, error) {
	kind := stringValue(message["msgtype"])
	result := Clip{Tags: unique(defaults)}
	if kind == "note" {
		result.Unsupported = true
		result.Issues = []string{"微信接口未提供微信笔记内容"}
		return result, nil
	}
	copyMessage := Message{}
	for key, value := range message {
		copyMessage[key] = value
	}
	if kind == "text" {
		if data, ok := object(message[kind]); ok {
			clean, tags := extractTags(stringValue(data["content"]))
			result.Tags = unique(append(result.Tags, tags...))
			copyData := map[string]any{}
			for key, value := range data {
				copyData[key] = value
			}
			copyData["content"] = clean
			copyMessage[kind] = copyData
		}
	}
	if kind == "merged_msg" && chatTag != "" {
		result.Tags = unique(append(result.Tags, chatTag))
	}
	content, issues, err := renderContent(copyMessage, media, 0)
	result.Content = content
	result.Issues = unique(issues)
	return result, err
}

func renderContent(message Message, media MediaReference, depth int) (string, []string, error) {
	kind := stringValue(message["msgtype"])
	data, ok := object(message[kind])
	if !ok && message[kind] != nil {
		return raw(message), []string{"消息结构异常"}, nil
	}
	if data == nil {
		data = map[string]any{}
	}
	switch kind {
	case "text":
		return literal(stringValue(data["content"])), nil, nil
	case "note":
		return "[微信笔记：官方接口不提供笔记正文]", []string{"微信接口未提供微信笔记内容"}, nil
	case "image", "voice", "video", "file":
		id := stringValue(data["media_id"])
		if id == "" {
			return "[" + Label(kind) + "：接口未返回附件 ID]", []string{"微信接口未提供附件 ID"}, nil
		}
		if media == nil {
			return "", nil, errors.New("media resolver is required")
		}
		value, err := media(id, kind)
		return value, nil, err
	case "link":
		return literal(stringValue(data["title"])) + "\n\n" + literal(stringValue(data["desc"])) + "\n\n" + urlReference(stringValue(data["url"])), nil, nil
	case "location":
		return literal("位置：" + stringValue(data["name"]) + " " + stringValue(data["address"]) + " (" + stringValue(data["latitude"]) + ", " + stringValue(data["longitude"]) + ")"), nil, nil
	case "merged_msg":
		if depth >= 8 {
			return raw(message), []string{"聊天记录嵌套超过 8 层，深层内容仅保留原始数据"}, nil
		}
		items, valid := data["item"].([]any)
		if data["item"] != nil && !valid {
			return raw(message), []string{"聊天记录结构异常"}, nil
		}
		title := stringValue(data["title"])
		if title == "" {
			title = "聊天记录"
		}
		parts := []string{"**" + literal(title) + "**"}
		var issues []string
		for _, entry := range items {
			item, valid := object(entry)
			if !valid {
				parts = append(parts, raw(entry))
				issues = append(issues, "聊天记录条目无法解析")
				continue
			}
			sender := stringValue(item["sender_name"])
			if sender == "" {
				sender = "未知发送者"
			}
			parts = append(parts, "**"+literal(sender)+" · "+stamp(item["send_time"])+"**")
			nested, valid := object(item["msg_content"])
			if text, yes := item["msg_content"].(string); yes {
				valid = json.Unmarshal([]byte(text), &nested) == nil && nested != nil
			}
			if !valid {
				parts = append(parts, raw(item["msg_content"]))
				issues = append(issues, "聊天记录条目无法解析")
				continue
			}
			child := Message{}
			for key, value := range nested {
				child[key] = value
			}
			if child["msgtype"] == nil {
				child["msgtype"] = item["msgtype"]
			}
			text, missing, err := renderContent(child, media, depth+1)
			if err != nil {
				return "", nil, err
			}
			parts = append(parts, text)
			issues = append(issues, missing...)
		}
		return strings.Join(parts, "\n\n"), issues, nil
	default:
		fields, known := cardFields[kind]
		if !known {
			return raw(message), []string{"消息类型尚无专用解析器"}, nil
		}
		parts := []string{"**" + Label(kind) + "**"}
		for _, field := range fields {
			if value, found := data[field[0]]; found {
				parts = append(parts, field[1]+"："+literal(stringValue(value)))
			}
		}
		if id := stringValue(data["thumb_media_id"]); id != "" {
			if media == nil {
				return "", nil, errors.New("media resolver is required")
			}
			value, err := media(id, "image")
			if err != nil {
				return "", nil, err
			}
			parts = append(parts, value)
		}
		return strings.Join(parts, "\n\n"), nil, nil
	}
}

var cardFields = map[string][][2]string{
	"miniprogram":           {{"title", "标题"}, {"appid", "AppID"}, {"pagepath", "页面路径"}},
	"channels":              {{"sub_type", "类型（1 动态 / 2 直播 / 3 名片）"}, {"nickname", "视频号"}, {"title", "标题"}},
	"channels_shop_product": {{"product_id", "商品 ID"}, {"title", "商品"}, {"sales_price", "售价（分）"}, {"shop_nickname", "店铺"}, {"head_image", "商品图片地址"}, {"shop_head_image", "店铺头像地址"}},
	"channels_shop_order":   {{"order_id", "订单 ID"}, {"product_titles", "商品"}, {"price_wording", "价格"}, {"state", "状态"}, {"shop_nickname", "店铺"}, {"image_url", "商品图片地址"}},
}

func object(value any) (map[string]any, bool) {
	switch x := value.(type) {
	case map[string]any:
		return x, x != nil
	case Message:
		return x, x != nil
	}
	return nil, false
}
func stringValue(value any) string {
	if value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	data, _ := json.Marshal(value)
	return string(data)
}
func literal(text string) string {
	text = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(text)
	var b strings.Builder
	for _, r := range text {
		if strings.ContainsRune("\\`*_{}[]()#+-.!|~", r) {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}
func raw(value any) string {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		data = []byte("null")
	}
	longest, current := 0, 0
	for _, b := range data {
		if b == '`' {
			current++
			if current > longest {
				longest = current
			}
		} else {
			current = 0
		}
	}
	fence := strings.Repeat("`", max(3, longest+1))
	return fence + "json\n" + string(data) + "\n" + fence
}
func urlReference(text string) string {
	u, err := url.Parse(text)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil {
		return literal(text)
	}
	return "<" + strings.NewReplacer("<", "%3C", ">", "%3E", "\n", "%0A", "\r", "%0D").Replace(text) + ">"
}
func stamp(value any) string {
	seconds, err := strconv.ParseInt(stringValue(value), 10, 64)
	if err != nil {
		return "时间未知"
	}
	t := time.Unix(seconds, 0).In(time.FixedZone("Asia/Shanghai", 8*3600))
	if t.Year() < 1 || t.Year() > 9999 {
		return "时间未知"
	}
	return t.Format("2006-01-02 15:04:05")
}
func unique(values []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		if value != "" && !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}

var urlPattern = regexp.MustCompile(`https?://[^\s<>]+`)

func tagRune(r rune) bool {
	return r != '<' && r != '>' && (unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.IsSymbol(r) || unicode.IsMark(r) || strings.ContainsRune("_-/&\u200d", r))
}

// extractTags preserves byte offsets while masking URLs, inline code and fenced code.
func extractTags(text string) (string, []string) {
	mask := []byte(text)
	for _, span := range urlPattern.FindAllStringIndex(text, -1) {
		for i := span[0]; i < span[1]; i++ {
			mask[i] = ' '
		}
	}
	for i := 0; i < len(text); {
		marker := text[i]
		if marker != '`' && marker != '~' {
			i++
			continue
		}
		end := i
		for end < len(text) && text[end] == marker {
			end++
		}
		if marker == '~' && end-i < 3 {
			i = end
			continue
		}
		closing := strings.Index(text[end:], text[i:end])
		if closing < 0 {
			i = end
			continue
		}
		stop := end + closing + end - i
		for j := i; j < stop; j++ {
			mask[j] = ' '
		}
		i = stop
	}
	type span struct{ start, end int }
	spans := []span{}
	var tags []string
	for i := 0; i < len(mask); i++ {
		if mask[i] != '#' {
			continue
		}
		if i > 0 {
			prev, _ := utf8.DecodeLastRune(mask[:i])
			if unicode.IsLetter(prev) || unicode.IsNumber(prev) || prev == '_' || strings.ContainsRune("/#\\", prev) {
				continue
			}
		}
		end := i + 1
		for end < len(mask) {
			r, n := utf8.DecodeRune(mask[end:])
			if !tagRune(r) {
				break
			}
			end += n
		}
		tag := string(mask[i+1 : end])
		if size := utf8.RuneCountInString(tag); size < 1 || size > 100 {
			continue
		}
		tags = append(tags, tag)
		start := i
		for start > 0 && (text[start-1] == ' ' || text[start-1] == '\t') {
			start--
		}
		spans = append(spans, span{start, end})
		i = end - 1
	}
	for i := len(spans) - 1; i >= 0; i-- {
		span := spans[i]
		text = text[:span.start] + text[span.end:]
	}
	return strings.TrimSpace(text), unique(tags)
}

// AttachmentReference escapes all untrusted filename syntax in a same-origin link.
func AttachmentReference(name, filename, kind string) string {
	prefix := ""
	if kind == "image" {
		prefix = "!"
	}
	path := "/file/" + name + "/" + url.PathEscape(filename)
	path = strings.ReplaceAll(strings.ReplaceAll(path, "(", "%28"), ")", "%29")
	return prefix + "[" + html.EscapeString(Label(kind)) + "](" + path + ")"
}
