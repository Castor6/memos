package wechatarticle

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestExtractReadableReferenceNumbers(t *testing.T) {
	result, err := Extract(sampleURL, `<div id="js_content">
<p>Table for Six<sup><span>[1]</span></sup> and BAI<sup>[2]</sup>.</p>
<p>Again<sup>[1]</sup>.</p><p>参考资料</p>
<p><span><span>[1]</span></span><span>Table for Six：https://example.com/app</span></p>
<p><span>[2]</span><span>BAI：https://example.com/team</span></p>
<p><code>literal \[1]</code></p><pre><code>code \[2]</code></pre>
<p><a href="https://example.com">linked [1]</a><img src="https://example.com/image" alt="image [2]"></p>
<p>[3]: https://example.com/definition</p><p>literal [4](destination)</p>
</div>`)
	require.NoError(t, err)
	for _, expected := range []string{"Table for Six[1] and BAI[2].", "Again[1].", "参考资料\n\n[1]Table for Six：", "\n\n[2]BAI：", "`literal \\[1]`", "code \\[2]", `[linked \[1\]](https://example.com)`, `![image \[2\]](https://example.com/image)`, `\[3]: https://example.com/definition`, `literal \[4](destination)`} {
		require.Contains(t, result.Markdown, expected)
	}
}

func TestReferenceNumbersPreserveMarkdownMeaning(t *testing.T) {
	for _, source := range []string{
		`literal \\\[1]`,
		`image !\[1](https://example.com)`,
		`link \[1][target]`,
		`next \[1]\[2]`,
		"definition \\[1]\n(url)",
		"[1]: https://example.com\n\n\\[1]",
		"[label][1]\n\n[1]: https://example.com",
	} {
		require.Equal(t, source, string(readableReferenceNumbers([]byte(source))))
	}
}
