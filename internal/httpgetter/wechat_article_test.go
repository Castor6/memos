package httpgetter

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWeChatArticleNetworkBoundary(t *testing.T) {
	client := newWeChatArticleClient()
	defer client.CloseIdleConnections()
	transport, ok := client.Transport.(*http.Transport)
	require.True(t, ok)
	require.Nil(t, transport.Proxy)
	require.NotNil(t, transport.DialContext)
	start, err := http.NewRequest(http.MethodGet, "https://mp.weixin.qq.com/s/article", nil)
	require.NoError(t, err)
	for _, target := range []string{"https://example.com/s/a", "https://mp.weixin.qq.com.evil.test/s/a", "http://mp.weixin.qq.com/s/a", "https://mp.weixin.qq.com:8443/s/a", "https://user@mp.weixin.qq.com/s/a"} {
		next, err := http.NewRequest(http.MethodGet, target, nil)
		require.NoError(t, err)
		require.Error(t, client.CheckRedirect(next, []*http.Request{start}))
	}
	next, err := http.NewRequest(http.MethodGet, "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha", nil)
	require.NoError(t, err)
	require.NoError(t, client.CheckRedirect(next, []*http.Request{start}))
	require.Error(t, client.CheckRedirect(next, []*http.Request{start, start, start, start, start}))
}

func TestWeChatArticleRead(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		require.Equal(t, "https://mp.weixin.qq.com/s/example", req.URL.String())
		require.NotEmpty(t, req.Header.Get("User-Agent"))
		require.Equal(t, "https://mp.weixin.qq.com/", req.Header.Get("Referer"))
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/html; charset=utf-8"}}, Body: io.NopCloser(strings.NewReader("<p>正文</p>"))}, nil
	})}
	text, err := fetchWeChatArticleHTML(context.Background(), "http://mp.weixin.qq.com/s/example", client)
	require.NoError(t, err)
	require.Equal(t, "<p>正文</p>", text)
	_, err = fetchWeChatArticleHTML(context.Background(), "https://evil.test/s/example", client)
	require.Error(t, err)
}

func TestWeChatArticleResponseLimits(t *testing.T) {
	for _, test := range []struct {
		name, contentType, body, expected string
		status                            int
	}{
		{"gone", "text/html", "private response", "已删除", 404},
		{"forbidden", "text/html", "private response", "HTTP 403", 403},
		{"wrong type", "application/json", `{"secret":"hidden"}`, "不是文章", 200},
		{"too large", "text/html", strings.Repeat("a", MaxWeChatArticleBytes+1), "8 MB", 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: test.status, Header: http.Header{"Content-Type": {test.contentType}}, Body: io.NopCloser(strings.NewReader(test.body))}, nil
			})}
			_, err := fetchWeChatArticleHTML(context.Background(), "https://mp.weixin.qq.com/s/example", client)
			require.ErrorContains(t, err, test.expected)
			require.NotContains(t, err.Error(), "private response")
			require.NotContains(t, err.Error(), "secret")
		})
	}
}
