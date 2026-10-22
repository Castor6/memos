// Package wechatarticle converts public WeChat article HTML without a browser.
package wechatarticle

import (
	"context"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/base"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/commonmark"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/strikethrough"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/table"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/usememos/memos/internal/httpgetter"
)

// MaxMarkdownBytes bounds the generated body before file metadata is added.
const MaxMarkdownBytes = 1 << 20

// Result contains extracted metadata and the original article body as Markdown.
type Result struct {
	Title       string
	Markdown    string
	Author      string
	AccountName string
	PublishedAt string
	IPLocation  string
}

// Error contains only a safe user-facing reason, never a URL or upstream body.
type Error struct{ Reason string }

func (e *Error) Error() string { return e.Reason }

func fail(reason string) (Result, error) { return Result{}, &Error{Reason: reason} }

var articlePath = regexp.MustCompile(`^/s/[A-Za-z0-9_-]+$`)
var codeLanguageName = regexp.MustCompile(`^[A-Za-z0-9_+-]{1,32}$`)

func articleURL(address string) (*url.URL, bool) {
	u, err := url.Parse(address)
	if err != nil || u.User != nil || !strings.EqualFold(u.Hostname(), "mp.weixin.qq.com") ||
		(u.Scheme != "http" && u.Scheme != "https") ||
		(u.Port() == "" && strings.Contains(u.Host, ":")) ||
		(u.Port() != "" && (u.Scheme != "https" || u.Port() != "443") && (u.Scheme != "http" || u.Port() != "80")) ||
		u.RawPath != "" || (u.Path != "/s" && !articlePath.MatchString(u.Path)) {
		return nil, false
	}
	u.Scheme, u.Host, u.Fragment = "https", "mp.weixin.qq.com", ""
	return u, true
}

// IsArticleURL accepts only standard WeChat article paths on the exact host.
func IsArticleURL(address string) bool { _, ok := articleURL(address); return ok }

// Convert downloads a bounded public article and converts it without executing scripts.
func Convert(ctx context.Context, address string) (Result, error) {
	u, ok := articleURL(address)
	if !ok {
		return fail("公众号文章链接无效或不受支持")
	}
	raw, err := httpgetter.GetWeChatArticleHTML(ctx, u.String())
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		// The dedicated fetcher deliberately returns only sanitized reasons.
		return fail(err.Error())
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	result, err := Extract(u.String(), raw)
	if ctx.Err() != nil {
		return Result{}, ctx.Err()
	}
	return result, err
}

// Extract converts supplied HTML using WeChat-specific content and image rules.
// Template selection and preparation are informed by wechat-article-parser;
// see THIRD_PARTY_NOTICES.md for the upstream version and MIT attribution.
func Extract(address, raw string) (Result, error) {
	u, ok := articleURL(address)
	if !ok {
		return fail("公众号文章链接无效或不受支持")
	}
	if len(raw) > httpgetter.MaxWeChatArticleBytes {
		return fail("文章网页超过 8 MB 大小限制")
	}
	if !utf8.ValidString(raw) {
		return fail("文章编码无法识别")
	}
	if !boundedHTML(raw) {
		return fail("文章排版过于复杂，暂时无法转换")
	}
	doc, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		return fail("文章网页无法解析")
	}
	nodes, ok := boundedNodes(doc)
	if !ok {
		return fail("文章排版过于复杂，暂时无法转换")
	}
	var content *html.Node
	var title, fallbackTitle string
	paid := false
	for _, node := range nodes {
		if node.Type != html.ElementNode {
			continue
		}
		id := attribute(node, "id")
		if id == "activity-name" {
			title = plainText(node)
		}
		if node.Data == "meta" && attribute(node, "property") == "og:title" {
			fallbackTitle = attribute(node, "content")
		}
		if node.Data == "script" {
			if strings.Contains(attribute(node, "src"), "secitptpage/template/verify.js") {
				return fail("微信要求安全验证，服务器暂时无法读取正文，请稍后重试")
			}
			paid = paid || paidScript(textContent(node))
		}
		if id == "js_content" {
			content = node
		}
	}
	if content == nil {
		for _, node := range nodes {
			if hasClass(node, "rich_media_content") || hasClass(node, "original_page") || attribute(node, "id") == "js_text_desc" {
				content = node
				break
			}
		}
	}
	if content == nil {
		text := plainText(doc)
		for _, marker := range []string{"环境异常", "完成验证", "访问过于频繁", "操作频繁"} {
			if strings.Contains(text, marker) {
				return fail("微信要求安全验证或限制访问，服务器暂时无法读取正文，请稍后重试")
			}
		}
		for _, marker := range []string{"该内容已被", "此内容因违规", "内容已删除", "内容已被删除", "内容不存在", "链接已过期", "暂时无法查看"} {
			if strings.Contains(text, marker) {
				return fail("文章已删除、过期或不可访问")
			}
		}
		if paid {
			return fail("文章需要付费，服务器无法取得完整正文")
		}
		return fail("未取得可转换的文章正文，可能是文章类型暂不支持或访问受限")
	}
	contentNodes, _ := boundedNodes(content)
	hasImage := false
	tableCells := 0
	for _, node := range contentNodes {
		if node.Data == "mp-pay-preview-filter" {
			paid = true
		}
		if node.Data == "img" && (safeLink(attribute(node, "data-src"), u) != "" || safeLink(attribute(node, "src"), u) != "") {
			hasImage = true
		}
		if node.Data == "td" || node.Data == "th" {
			cells := 1
			for _, key := range []string{"rowspan", "colspan"} {
				if value := attribute(node, key); value != "" {
					span, err := strconv.Atoi(value)
					if err != nil || span < 1 || span > 64 {
						return fail("文章表格过于复杂，暂时无法转换")
					}
					cells *= span
				}
			}
			tableCells += cells
			if tableCells > 20000 {
				return fail("文章表格过于复杂，暂时无法转换")
			}
		}
	}
	if paid {
		return fail("文章需要付费，服务器无法确认已取得完整正文")
	}
	if plainText(content) == "" && !hasImage {
		return fail("文章没有可转换的正文，纯音视频或互动内容暂不支持")
	}
	metadata := articleMetadata(nodes, content)
	prepare(content, u)
	if title == "" {
		title = fallbackTitle
	}
	if title == "" {
		for _, node := range nodes {
			if node.Data == "title" {
				title = plainText(node)
				break
			}
		}
	}
	if title == "" {
		title = "公众号文章"
	}
	title = strings.Join(strings.Fields(title), " ")
	if len([]rune(title)) > 200 {
		title = string([]rune(title)[:200])
	}
	conv := converter.NewConverter(converter.WithPlugins(
		base.NewBasePlugin(), commonmark.NewCommonmarkPlugin(),
		strikethrough.NewStrikethroughPlugin(), table.NewTablePlugin(table.WithNewlineBehavior(table.NewlineBehaviorPreserve)),
	))
	markdown, err := conv.ConvertNode(content, converter.WithDomain(u.String()))
	if err != nil {
		return fail("文章排版转换失败")
	}
	body := strings.TrimSpace(string(markdown))
	if body == "" {
		return fail("文章没有可转换的正文")
	}
	if len(body)+1 > MaxMarkdownBytes {
		return fail("转换后的 Markdown 超过 1 MB 大小限制")
	}
	body = string(readableReferenceNumbers([]byte(body)))
	metadata.Title, metadata.Markdown = title, body+"\n"
	return metadata, nil
}

func attribute(node *html.Node, name string) string {
	for _, attr := range node.Attr {
		if attr.Key == name {
			return attr.Val
		}
	}
	return ""
}

func hasClass(node *html.Node, value string) bool {
	for _, class := range strings.Fields(attribute(node, "class")) {
		if class == value {
			return true
		}
	}
	return false
}

func boundedHTML(raw string) bool {
	tokenizer := html.NewTokenizer(strings.NewReader(raw))
	count, depth := 0, 0
	for {
		kind := tokenizer.Next()
		switch kind {
		case html.ErrorToken:
			return true
		case html.StartTagToken, html.SelfClosingTagToken:
			count++
			if count > 100000 {
				return false
			}
			if kind == html.SelfClosingTagToken {
				continue
			}
			token := tokenizer.Token()
			switch token.Data {
			case "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr":
			default:
				depth++
				if depth > 512 {
					return false
				}
			}
		case html.EndTagToken:
			depth = max(0, depth-1)
		default:
			// Text and comments do not affect structural limits.
		}
	}
}

func boundedNodes(root *html.Node) ([]*html.Node, bool) {
	type entry struct {
		node  *html.Node
		depth int
	}
	stack := []entry{{root, 0}}
	var result []*html.Node
	for len(stack) > 0 {
		item := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if item.depth > 128 || len(result) >= 100000 {
			return nil, false
		}
		result = append(result, item.node)
		for child := item.node.LastChild; child != nil; child = child.PrevSibling {
			stack = append(stack, entry{child, item.depth + 1})
		}
	}
	return result, true
}

func textContent(root *html.Node) string {
	var text strings.Builder
	nodes, _ := boundedNodes(root)
	for _, node := range nodes {
		if node.Type == html.TextNode {
			text.WriteString(node.Data)
		}
	}
	return text.String()
}

func plainText(root *html.Node) string {
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if node.Data == "script" || node.Data == "style" {
			return
		}
		if node.Type == html.TextNode {
			text.WriteString(node.Data)
			text.WriteByte(' ')
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(root)
	return strings.Join(strings.Fields(text.String()), " ")
}

func safeLink(value string, origin *url.URL) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || value == "" || u.User != nil {
		return ""
	}
	u = origin.ResolveReference(u)
	if (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" {
		return ""
	}
	return u.String()
}

func replaceText(node *html.Node, value string) {
	for node.FirstChild != nil {
		node.RemoveChild(node.FirstChild)
	}
	node.Data, node.DataAtom, node.Attr = "p", atom.P, nil
	node.AppendChild(&html.Node{Type: html.TextNode, Data: value})
}

func codeLanguage(node *html.Node) string {
	candidates := []string{attribute(node, "data-lang"), attribute(node, "data-language")}
	for _, class := range strings.Fields(attribute(node, "class")) {
		for _, prefix := range []string{"language-", "lang-", "code-snippet__"} {
			if strings.HasPrefix(class, prefix) {
				candidates = append(candidates, strings.TrimPrefix(class, prefix))
			}
		}
	}
	for _, candidate := range candidates {
		if candidate != "fix" && codeLanguageName.MatchString(candidate) {
			return candidate
		}
	}
	return ""
}

func prepare(root *html.Node, origin *url.URL) {
	nodes, _ := boundedNodes(root)
	for _, node := range nodes {
		if node.Type != html.ElementNode || (node != root && node.Parent == nil) {
			continue
		}
		if hasClass(node, "line-numbers-rows") || hasClass(node, "code-snippet__line-index") {
			node.Parent.RemoveChild(node)
			continue
		}
		language := codeLanguage(node)
		switch node.Data {
		case "script", "style", "iframe", "object", "embed", "form", "input", "button", "svg", "canvas", "noscript":
			if node.Parent != nil {
				node.Parent.RemoveChild(node)
			}
			continue
		case "video", "audio", "mp-common-videosnap":
			replaceText(node, "[音视频内容请在微信中查看]")
		case "mp-common-profile":
			replaceText(node, strings.TrimSpace(attribute(node, "data-nickname")+" "+attribute(node, "data-signature")))
		case "mp-common-miniprogram":
			replaceText(node, strings.TrimSpace(attribute(node, "data-miniprogram-title")+" [小程序内容请在微信中查看]"))
		case "mp-common-redpacket":
			replaceText(node, "[红包封面请在微信中查看]")
		case "pre":
			if language == "" {
				for child := node.FirstChild; child != nil; child = child.NextSibling {
					if language = codeLanguage(child); language != "" {
						break
					}
				}
			}
			code := codeText(node)
			for node.FirstChild != nil {
				node.RemoveChild(node.FirstChild)
			}
			child := &html.Node{Type: html.ElementNode, Data: "code", DataAtom: atom.Code}
			child.AppendChild(&html.Node{Type: html.TextNode, Data: code})
			node.AppendChild(child)
		default:
			// Standard content elements are handled by the Markdown converter.
		}
		var attrs []html.Attribute
		switch node.Data {
		case "img":
			source := attribute(node, "data-src")
			if source == "" {
				source = attribute(node, "src")
			}
			source = safeLink(source, origin)
			if source == "" {
				node.Parent.RemoveChild(node)
				continue
			}
			attrs = []html.Attribute{{Key: "src", Val: source}, {Key: "alt", Val: attribute(node, "alt")}}
		case "a":
			if href := safeLink(attribute(node, "href"), origin); href != "" {
				attrs = []html.Attribute{{Key: "href", Val: href}}
			} else {
				node.Data, node.DataAtom = "span", atom.Span
			}
		case "code":
			if language != "" {
				attrs = []html.Attribute{{Key: "class", Val: "language-" + language}}
			}
			// GFM requires pipes to be escaped even inside a table's code span.
			for parent := node.Parent; parent != nil; parent = parent.Parent {
				if parent.Data == "td" || parent.Data == "th" {
					children, _ := boundedNodes(node)
					for _, child := range children {
						if child.Type == html.TextNode {
							child.Data = strings.ReplaceAll(child.Data, "|", `\|`)
						}
					}
					break
				}
			}
		case "pre":
			if language != "" {
				attrs = []html.Attribute{{Key: "class", Val: "language-" + language}}
			}
		case "td", "th":
			for _, key := range []string{"rowspan", "colspan", "align"} {
				if value := attribute(node, key); value != "" {
					attrs = append(attrs, html.Attribute{Key: key, Val: value})
				}
			}
		case "ol":
			attrs = []html.Attribute{{Key: "start", Val: attribute(node, "start")}}
		default:
			// All other elements lose their attributes.
		}
		node.Attr = attrs
	}
}

func codeText(root *html.Node) string {
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(node *html.Node) {
		if hasClass(node, "line-numbers-rows") || hasClass(node, "code-snippet__line-index") {
			return
		}
		if node.Type == html.TextNode {
			text.WriteString(strings.ReplaceAll(node.Data, "\u00a0", " "))
		}
		if node.Data == "br" {
			text.WriteByte('\n')
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
			if child.Data == "code" && child.NextSibling != nil && child.NextSibling.Data == "code" {
				text.WriteByte('\n')
			}
		}
	}
	walk(root)
	return text.String()
}
