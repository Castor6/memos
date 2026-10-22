package wechatarticle

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/httpgetter"
)

const sampleURL = "https://mp.weixin.qq.com/s/example_123"

func TestArticleURLBoundary(t *testing.T) {
	for _, value := range []string{sampleURL, "https://mp.weixin.qq.com/s?__biz=x&mid=1", "http://mp.weixin.qq.com/s/a", "https://MP.WEIXIN.QQ.COM:443/s/a", "http://mp.weixin.qq.com:80/s/a"} {
		require.True(t, IsArticleURL(value), value)
	}
	for _, value := range []string{"", "https://mp.weixin.qq.com.evil.test/s/a", "https://evil@mp.weixin.qq.com/s/a", "https://mp.weixin.qq.com:8443/s/a", "http://mp.weixin.qq.com:443/s/a", "https://mp.weixin.qq.com./s/a", "https://mp.weixin.qq.com/mp/profile", "https://mp.weixin.qq.com/s/", "https://mp.weixin.qq.com/s/a/b", "https://mp.weixin.qq.com/%73/a", "file://mp.weixin.qq.com/s/a", "https://127.0.0.1/s/a"} {
		require.False(t, IsArticleURL(value), value)
	}
}

func TestExtractFormattingAndSafeContent(t *testing.T) {
	raw := `<html><head><title>Fallback</title><meta property="og:title" content="Metadata title"></head><body>
<h1 id="activity-name">Example title</h1><div id="js_content" class="rich_media_content">
<h2>Section</h2><p>Hello <strong>world</strong>, <em>emphasis</em> and <del>old</del>.</p>
<blockquote><p>A quotation</p></blockquote><ol start="3"><li>One</li><li>Two</li></ol>
<p><a href="/s/another">Related article</a><a href="javascript:alert(1)">Safe label</a></p>
<p><img src="data:image/gif;base64,ignored" data-src="https://mmbiz.qpic.cn/a.jpg" alt="A picture" onerror="alert(1)"></p>
<img><img data-src="javascript:alert(2)"><script>secretScript()</script><style>secretStyle{}</style>
<iframe src="https://evil.test"></iframe><svg onload="alert(3)"><text>activeSVG</text></svg>
<pre><code class="language-go">first&nbsp;line<br>second line</code><code>third line</code></pre>
<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>row</td><td><code>a|b</code></td></tr></tbody></table>
</div><footer>微信扫一扫 轻点两下取消赞</footer></body></html>`
	result, err := Extract(sampleURL, raw)
	require.NoError(t, err)
	require.Equal(t, "Example title", result.Title)
	for _, expected := range []string{"## Section", "**world**", "*emphasis*", "~~old~~", "> A quotation", "3. One", "[Related article](https://mp.weixin.qq.com/s/another)", "![A picture](https://mmbiz.qpic.cn/a.jpg)", "```go\nfirst line\nsecond line\nthird line", "Name", `a\|b`} {
		require.Contains(t, result.Markdown, expected)
	}
	for _, excluded := range []string{"javascript:", "onerror", "secretScript", "secretStyle", "activeSVG", "<iframe", "微信扫一扫", "轻点两下取消赞", "![]()"} {
		require.NotContains(t, result.Markdown, excluded)
	}
}

func TestExtractCodeExcludesLineNumbers(t *testing.T) {
	for name, code := range map[string]string{
		"sibling rows": `<code>console.log(1);</code><span class="line-numbers-rows"><span>1</span></span>`,
		"nested index": `<code><span class="code-snippet__line-index">1</span>console.log(1);</code>`,
	} {
		t.Run(name, func(t *testing.T) {
			result, err := Extract(sampleURL, `<div id="js_content"><pre class="language-javascript">`+code+`</pre></div>`)
			require.NoError(t, err)
			require.Equal(t, "```javascript\nconsole.log(1);\n```\n", result.Markdown)
		})
	}
}

func TestExtractFailureReasons(t *testing.T) {
	for name, fixture := range map[string]struct{ html, reason string }{
		"verify script": {`<script src="/secitptpage/template/verify.js"></script>`, "安全验证"},
		"verify page":   {`<html><body><h2>环境异常</h2><p>完成验证后即可继续访问</p></body></html>`, "安全验证"},
		"deleted":       {`<html><body>该内容已被发布者删除</body></html>`, "已删除"},
		"missing":       {`<html><body>普通页面，不含公众号正文</body></html>`, "未取得"},
		"empty":         {`<div id="js_content"><script>placeholder()</script></div>`, "没有可转换"},
		"video only":    {`<div id="js_content"><video src="https://example.com/movie.mp4"></video></div>`, "纯音视频"},
		"paid preview":  {`<div class="rich_media_content">Introduction<mp-pay-preview-filter>Preview</mp-pay-preview-filter></div>`, "付费"},
		"paid flag":     {`<script>var is_pay_subscribe = "1" * 1;</script><div id="js_content">Introduction</div>`, "付费"},
		"paid cgi":      {`<script>window.cgiDataNew = {is_pay_subscribe: true};</script><div id="js_content">Introduction</div>`, "付费"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Extract(sampleURL, fixture.html)
			var safe *Error
			require.ErrorAs(t, err, &safe)
			require.Contains(t, safe.Reason, fixture.reason)
			require.NotContains(t, safe.Reason, sampleURL)
		})
	}
}

func TestArticleTextDoesNotTriggerPageFailure(t *testing.T) {
	for _, script := range []string{
		`var unrelated = "var is_pay_subscribe = 1;";`,
		`// var is_pay_subscribe = 1;`,
		`window.cgiDataNew = {recommend: {is_pay_subscribe: 1}, is_pay_subscribe: 0};`,
		`var example = {is_pay_subscribe: 1};`,
		"const example = `is_pay_subscribe = 1;`;",
	} {
		result, err := Extract(sampleURL, `<script>`+script+`</script><div id="js_content"><p>文章讲解环境异常、完成验证和该内容已被删除等提示。</p></div>`)
		require.NoError(t, err, script)
		require.Contains(t, result.Markdown, "文章讲解")
	}
}

func TestExtractBoundsAndTemplates(t *testing.T) {
	_, err := Extract(sampleURL, strings.Repeat("x", httpgetter.MaxWeChatArticleBytes+1))
	require.ErrorContains(t, err, "8 MB")
	_, err = Extract(sampleURL, `<div id="js_content">`+strings.Repeat("x", MaxMarkdownBytes+1)+`</div>`)
	require.ErrorContains(t, err, "1 MB")
	_, err = Extract(sampleURL, `<div id="js_content">`+strings.Repeat("<div>", 130)+"text"+strings.Repeat("</div>", 130)+`</div>`)
	require.ErrorContains(t, err, "复杂")
	_, err = Extract(sampleURL, `<div id="js_content"><table><tr><td rowspan="2147483647">cell</td></tr></table></div>`)
	require.ErrorContains(t, err, "表格过于复杂")
	_, err = Extract(sampleURL, `<div id="js_content">`+strings.Repeat("<br>", 100001)+`</div>`)
	require.ErrorContains(t, err, "复杂")
	for _, body := range []string{`<div class="original_page">Visible repost text</div>`, `<p id="js_text_desc">Visible plain text</p>`, `<div class="rich_media_content"><img data-src="https://mmbiz.qpic.cn/photo.jpg"></div>`} {
		result, err := Extract(sampleURL, body)
		require.NoError(t, err)
		require.NotEmpty(t, result.Markdown)
	}
}

func TestConvertCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Convert(ctx, sampleURL)
	require.ErrorIs(t, err, context.Canceled)
}

func TestLocalArticleComparison(t *testing.T) {
	path := os.Getenv("MEMOS_WECHAT_ARTICLE_FIXTURE")
	if path == "" {
		t.Skip("Optional local comparison uses an untracked user-provided fixture")
	}
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	result, err := Extract(sampleURL, string(raw))
	require.NoError(t, err)
	t.Logf("title=%q markdown_bytes=%d images=%d", result.Title, len(result.Markdown), strings.Count(result.Markdown, "!["))
	if output := os.Getenv("MEMOS_WECHAT_ARTICLE_OUTPUT"); output != "" {
		require.NoError(t, os.WriteFile(output, []byte(result.Markdown), 0600))
	}
}
