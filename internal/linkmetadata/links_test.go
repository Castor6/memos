package linkmetadata

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestURLs(t *testing.T) {
	require.Equal(t, []string{"https://example.com/a", "https://example.com/b"}, URLs("https://example.com/a\n\n[https://example.com/b](https://example.com/b)\n\nhttps://example.com/a\n\n![图片](https://example.com/image)\n\n`https://example.com/code`\n\n[本地](/file/a)\n\n[标题](https://example.com/no-preview)\n\n> https://example.com/quote\n\n前文 https://example.com/inline"))
}
