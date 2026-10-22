package httpgetter

import (
	"context"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
	"golang.org/x/net/html/charset"
)

// MaxWeChatArticleBytes bounds both downloaded and decoded article HTML.
const MaxWeChatArticleBytes = 8 << 20

func weChatArticleAddress(address string) (*url.URL, error) {
	u, err := url.Parse(address)
	if err != nil || u.User != nil || !strings.EqualFold(u.Hostname(), "mp.weixin.qq.com") ||
		(u.Scheme != "https" && u.Scheme != "http") ||
		(u.Port() == "" && strings.Contains(u.Host, ":")) ||
		(u.Port() != "" && (u.Scheme != "https" || u.Port() != "443") && (u.Scheme != "http" || u.Port() != "80")) {
		return nil, errors.New("公众号文章地址无效")
	}
	u.Scheme, u.Host, u.Fragment = "https", "mp.weixin.qq.com", ""
	return u, nil
}

func newWeChatArticleClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = secureDialContext
	return &http.Client{
		Transport: transport,
		Timeout:   25 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("文章重定向次数过多")
			}
			u, err := weChatArticleAddress(req.URL.String())
			if err != nil || req.URL.Scheme != "https" {
				return errors.New("文章跳转到不受支持的地址")
			}
			req.URL = u
			setWeChatArticleHeaders(req)
			return nil
		},
	}
}

// GetWeChatArticleHTML fetches one article without proxies or off-host redirects.
// DNS validation is repeated by secureDialContext at the actual connection.
func GetWeChatArticleHTML(ctx context.Context, address string) (string, error) {
	client := newWeChatArticleClient()
	defer client.CloseIdleConnections()
	return fetchWeChatArticleHTML(ctx, address, client)
}

func fetchWeChatArticleHTML(ctx context.Context, address string, client *http.Client) (string, error) {
	u, err := weChatArticleAddress(address)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", errors.New("公众号文章地址无效")
	}
	setWeChatArticleHeaders(req)
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errors.New("文章获取失败：网络超时或访问受限，请稍后重试")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
		return "", errors.New("文章已删除或不可访问")
	}
	if response.StatusCode != http.StatusOK {
		return "", errors.New("微信未返回文章（HTTP " + strconv.Itoa(response.StatusCode) + "）")
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaType != "" && mediaType != "text/html" && mediaType != "application/xhtml+xml" {
		return "", errors.New("微信返回的内容不是文章网页")
	}
	if response.ContentLength > MaxWeChatArticleBytes {
		return "", errors.New("文章网页超过 8 MB 大小限制")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxWeChatArticleBytes+1))
	if err != nil {
		return "", errors.New("文章下载中断，请稍后重试")
	}
	if len(data) > MaxWeChatArticleBytes {
		return "", errors.New("文章网页超过 8 MB 大小限制")
	}
	reader, err := charset.NewReader(strings.NewReader(string(data)), response.Header.Get("Content-Type"))
	if err != nil {
		return "", errors.New("文章编码无法识别")
	}
	decoded, err := io.ReadAll(io.LimitReader(reader, MaxWeChatArticleBytes+1))
	if err != nil || len(decoded) > MaxWeChatArticleBytes {
		return "", errors.New("文章解码失败或超过大小限制")
	}
	return string(decoded), nil
}
