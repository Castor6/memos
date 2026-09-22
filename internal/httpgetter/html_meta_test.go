package httpgetter

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestValidateURLWithoutNetwork(t *testing.T) {
	originalLookup := lookupIPAddr
	t.Cleanup(func() { lookupIPAddr = originalLookup })
	lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		t.Fatal("URL validation must not resolve DNS")
		return nil, nil
	}
	for _, address := range []string{"https://missing.invalid/article", "http://93.184.216.34/article"} {
		require.NoError(t, ValidateURL(address))
	}
	for _, address := range []string{"file:///tmp/article", "http://", "https://%", "http://127.0.0.1/article", "https://[::1]/"} {
		t.Run(address, func(t *testing.T) {
			require.Error(t, ValidateURL(address))
		})
	}
}

func TestGetHTMLMeta(t *testing.T) {
	originalHTTPClient := httpClient
	t.Cleanup(func() {
		httpClient = originalHTTPClient
	})

	httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			require.Equal(t, "http://93.184.216.34/article", req.URL.String())
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
				Body: io.NopCloser(strings.NewReader(`<!doctype html>
<html>
<head>
  <title>Fallback title</title>
  <meta name="description" content="Fallback description">
  <meta property="og:title" content="Open Graph title">
  <meta property="og:description" content="Open Graph description">
  <meta property="og:image" content="https://example.com/cover.png">
</head>
<body>ignored</body>
</html>`)),
				Request: req,
			}, nil
		}),
	}

	metadata, err := GetHTMLMeta("http://93.184.216.34/article")
	require.NoError(t, err)
	require.Equal(t, HTMLMeta{
		Title:       "Open Graph title",
		Description: "Open Graph description",
		Image:       "https://example.com/cover.png",
	}, *metadata)
}

func TestGetHTMLMetaWithNameOnly(t *testing.T) {
	originalHTTPClient := httpClient
	t.Cleanup(func() {
		httpClient = originalHTTPClient
	})

	httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			require.Equal(t, "http://93.184.216.34/blog", req.URL.String())
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
				Body: io.NopCloser(strings.NewReader(`<!doctype html>
<html>
<head>
  <title>Sample Page</title>
  <meta name="description" content="This description should appear in the link preview.">
</head>
<body>Hello</body>
</html>`)),
				Request: req,
			}, nil
		}),
	}

	metadata, err := GetHTMLMeta("http://93.184.216.34/blog")
	require.NoError(t, err)
	require.Equal(t, HTMLMeta{
		Title:       "Sample Page",
		Description: "This description should appear in the link preview.",
		Image:       "",
	}, *metadata)
}

func TestGetHTMLMetaWithNameCaseInsensitive(t *testing.T) {
	originalHTTPClient := httpClient
	t.Cleanup(func() {
		httpClient = originalHTTPClient
	})

	httpClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			require.Equal(t, "http://93.184.216.34/blog", req.URL.String())
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
				Body: io.NopCloser(strings.NewReader(`<!doctype html>
<html>
<head>
  <title>Sample Page</title>
  <meta name="Description" content="Case insensitive description match.">
</head>
<body>Hello</body>
</html>`)),
				Request: req,
			}, nil
		}),
	}

	metadata, err := GetHTMLMeta("http://93.184.216.34/blog")
	require.NoError(t, err)
	require.Equal(t, HTMLMeta{
		Title:       "Sample Page",
		Description: "Case insensitive description match.",
		Image:       "",
	}, *metadata)
}

func TestGetHTMLMetaForInternal(t *testing.T) {
	// test for internal IP
	if _, err := GetHTMLMeta("http://192.168.0.1"); !errors.Is(err, ErrInternalIP) {
		t.Errorf("Expected error for internal IP, got %v", err)
	}

	// test for resolved internal IP
	if _, err := GetHTMLMeta("http://localhost"); !errors.Is(err, ErrInternalIP) {
		t.Errorf("Expected error for resolved internal IP, got %v", err)
	}
}

func TestHTTPClientHasTimeout(t *testing.T) {
	require.NotZero(t, httpClient.Timeout)
}

func TestSecureDialContextRejectsResolvedInternalIP(t *testing.T) {
	originalLookupIPAddr := lookupIPAddr
	originalDialContext := dialContext
	t.Cleanup(func() {
		lookupIPAddr = originalLookupIPAddr
		dialContext = originalDialContext
	})

	lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
	}
	dialContext = func(context.Context, string, string) (net.Conn, error) {
		t.Fatal("internal IP should be rejected before dialing")
		return nil, nil
	}

	_, err := secureDialContext(context.Background(), "tcp", "rebind.example:80")
	require.ErrorIs(t, err, ErrInternalIP)
}

func TestSecureDialContextDialsResolvedIP(t *testing.T) {
	originalLookupIPAddr := lookupIPAddr
	originalDialContext := dialContext
	t.Cleanup(func() {
		lookupIPAddr = originalLookupIPAddr
		dialContext = originalDialContext
	})

	lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}, nil
	}

	var dialedAddress string
	dialContext = func(_ context.Context, _ string, address string) (net.Conn, error) {
		dialedAddress = address
		clientConn, serverConn := net.Pipe()
		t.Cleanup(func() {
			clientConn.Close()
			serverConn.Close()
		})
		return clientConn, nil
	}

	conn, err := secureDialContext(context.Background(), "tcp", "rebind.example:80")
	require.NoError(t, err)
	require.NotNil(t, conn)
	require.Equal(t, "93.184.216.34:80", dialedAddress)
}

func TestGetHTMLMetaRequestHeaders(t *testing.T) {
	for _, test := range []struct {
		name   string
		url    string
		wechat bool
	}{
		{"article", "https://mp.weixin.qq.com/s/example", true},
		{"uppercase host", "https://MP.WEIXIN.QQ.COM/s?mid=123", true},
		{"other site", "https://juejin.cn/post/example", false},
		{"video channel", "https://channels.weixin.qq.com/finder-preview/pages/feed", false},
		{"lookalike host", "https://mp.weixin.qq.com.example.com/s/example", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			original := httpClient
			t.Cleanup(func() { httpClient = original })
			httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if test.wechat {
					require.Equal(t, "Mozilla/5.0 Chrome/120.0.0.0", req.Header.Get("User-Agent"))
					require.Equal(t, "zh-CN,zh;q=0.9", req.Header.Get("Accept-Language"))
					require.Equal(t, "https://mp.weixin.qq.com/", req.Header.Get("Referer"))
				} else {
					require.Empty(t, req.Header.Get("User-Agent"))
					require.Empty(t, req.Header.Get("Accept-Language"))
					require.Empty(t, req.Header.Get("Referer"))
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"text/html"}},
					Body:       io.NopCloser(strings.NewReader("<title>Article title</title>")),
					Request:    req,
				}, nil
			})}
			meta, err := GetHTMLMeta(test.url)
			require.NoError(t, err)
			require.Equal(t, "Article title", meta.Title)
		})
	}
}

func TestGetHTMLMetaRedirectHeaders(t *testing.T) {
	for _, test := range []struct {
		name string
		urls []string
	}{
		{"other sites", []string{"https://example.com/start", "https://other.example.com/end"}},
		{"leave wechat", []string{"https://mp.weixin.qq.com/s/one", "https://example.com/next", "https://other.example.com/end"}},
		{"enter and leave wechat", []string{"https://example.com/start", "https://mp.weixin.qq.com/s/two", "https://example.com/end"}},
		{"within wechat", []string{"https://mp.weixin.qq.com/s/one", "https://mp.weixin.qq.com/s/two"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			original := httpClient
			t.Cleanup(func() { httpClient = original })
			client := newHTTPClient()
			requests := 0
			client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
				require.Equal(t, test.urls[requests], req.URL.String())
				if req.URL.Hostname() == "mp.weixin.qq.com" {
					require.Equal(t, "Mozilla/5.0 Chrome/120.0.0.0", req.Header.Get("User-Agent"))
					require.Equal(t, "zh-CN,zh;q=0.9", req.Header.Get("Accept-Language"))
					require.Equal(t, "https://mp.weixin.qq.com/", req.Header.Get("Referer"))
				} else {
					require.Empty(t, req.Header.Get("User-Agent"))
					require.Empty(t, req.Header.Get("Accept-Language"))
					if test.name == "other sites" && requests > 0 {
						require.Equal(t, test.urls[requests-1], req.Header.Get("Referer"))
					} else {
						require.Empty(t, req.Header.Get("Referer"))
					}
				}
				requests++
				response := &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"text/html"}},
					Body:       io.NopCloser(strings.NewReader("<title>Final title</title>")),
					Request:    req,
				}
				if requests < len(test.urls) {
					response.StatusCode = http.StatusFound
					response.Header.Set("Location", test.urls[requests])
				}
				return response, nil
			})
			httpClient = client
			meta, err := GetHTMLMeta(test.urls[0])
			require.NoError(t, err)
			require.Equal(t, "Final title", meta.Title)
			require.Equal(t, len(test.urls), requests)
		})
	}
}

func TestExtractHTMLMetaTitlePriority(t *testing.T) {
	for _, test := range []struct {
		name  string
		html  string
		title string
	}{
		{"empty title", "<title></title>", ""},
		{"whitespace title", "<title> \n </title>", ""},
		{"plain title", "<title> Plain &amp; useful </title>", "Plain & useful"},
		{"og before empty title", `<meta property="og:title" content="公众号文章"><title></title>`, "公众号文章"},
		{"og before plain title", `<meta property="og:title" content="Article"><title>Site shell</title>`, "Article"},
		{"og after plain title", `<title>Site shell</title><meta property="og:title" content=" Article ">`, "Article"},
		{"empty og preserves fallback", `<title>Fallback</title><meta property="og:title" content=" ">`, "Fallback"},
		{"empty duplicate og", `<meta property="og:title" content="Article"><meta property="og:title" content="">`, "Article"},
		{"ignore body title", `<title>Page</title><body><title>Body</title>`, "Page"},
	} {
		t.Run(test.name, func(t *testing.T) {
			meta := extractHTMLMeta(strings.NewReader(test.html))
			require.Equal(t, test.title, meta.Title)
		})
	}
}

func TestGetHTMLMetaRejectsHTTPErrorPages(t *testing.T) {
	original := httpClient
	t.Cleanup(func() { httpClient = original })
	for _, status := range []int{http.StatusForbidden, http.StatusNotFound, http.StatusServiceUnavailable} {
		httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: status,
				Header:     http.Header{"Content-Type": []string{"text/html"}},
				Body:       io.NopCloser(strings.NewReader("<title>Access Denied</title>")),
				Request:    req,
			}, nil
		})}
		meta, err := GetHTMLMeta("https://example.com/article")
		require.ErrorContains(t, err, "unexpected HTTP status")
		require.Nil(t, meta)
	}
}

func TestGetHTMLMetaWeChatShellTitles(t *testing.T) {
	for _, test := range []struct {
		url   string
		title string
		want  string
	}{
		{"https://mp.weixin.qq.com/s/example", "title", ""},
		{"https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha", "微信公众平台", ""},
		{"https://channels.weixin.qq.com/finder-preview/pages/feed", "视频号", ""},
		{"https://channels.weixin.qq.com/finder-preview/pages/feed", "真实视频标题", "真实视频标题"},
		{"https://example.com/article", "视频号", "视频号"},
	} {
		t.Run(test.title+test.url, func(t *testing.T) {
			original := httpClient
			t.Cleanup(func() { httpClient = original })
			httpClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"text/html"}},
					Body:       io.NopCloser(strings.NewReader("<title>" + test.title + "</title>")),
					Request:    req,
				}, nil
			})}
			meta, err := GetHTMLMeta(test.url)
			require.NoError(t, err)
			require.Equal(t, test.want, meta.Title)
		})
	}
}
