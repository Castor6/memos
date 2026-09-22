package httpgetter

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pkg/errors"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

var ErrInternalIP = errors.New("internal IP addresses are not allowed")

const maxHTMLMetaBytes = 512 * 1024

var (
	lookupIPAddr = net.DefaultResolver.LookupIPAddr
	dialContext  = (&net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext
	httpClient = newHTTPClient()
)

func newHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = secureDialContext

	return &http.Client{
		Transport: transport,
		Timeout:   5 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if err := ValidateURL(req.URL.String()); err != nil {
				return errors.Wrap(err, "redirect to internal IP")
			}
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			// net/http copies the original headers across redirects. Keep the
			// WeChat request profile confined to the destination's exact host.
			if isWeChatArticleURL(via[0].URL) || isWeChatArticleURL(via[len(via)-1].URL) {
				req.Header.Del("User-Agent")
				req.Header.Del("Accept-Language")
				req.Header.Del("Referer")
			}
			setWeChatArticleHeaders(req)
			return nil
		},
	}
}

func secureDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.Wrap(err, "invalid address")
	}

	ips, err := resolveAllowedIPs(ctx, host)
	if err != nil {
		return nil, err
	}

	var dialErr error
	for _, ip := range ips {
		conn, err := dialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		dialErr = err
	}
	return nil, dialErr
}

func resolveAllowedIPs(ctx context.Context, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		if isInternalIP(ip) {
			return nil, errors.Wrap(ErrInternalIP, ip.String())
		}
		return []net.IP{ip}, nil
	}

	addrs, err := lookupIPAddr(ctx, host)
	if err != nil {
		return nil, errors.Errorf("failed to resolve hostname: %v", err)
	}

	ips := make([]net.IP, 0, len(addrs))
	for _, addr := range addrs {
		ip := addr.IP
		if ip == nil {
			continue
		}
		if isInternalIP(ip) {
			return nil, errors.Wrapf(ErrInternalIP, "host=%s, ip=%s", host, ip.String())
		}
		ips = append(ips, ip)
	}
	if len(ips) == 0 {
		return nil, errors.New("hostname resolved to no addresses")
	}

	return ips, nil
}

func isInternalIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return true
	}
	// IsPrivate excludes RFC 6598 shared address space. To4 also covers mapped IPv6.
	ipv4 := ip.To4()
	return ipv4 != nil && ipv4[0] == 100 && ipv4[1] >= 64 && ipv4[1] <= 127
}

// ValidateURL checks URL syntax, protocol, and literal IP restrictions without resolving DNS.
func ValidateURL(urlStr string) error {
	u, err := url.Parse(urlStr)
	if err != nil {
		return errors.New("invalid URL format")
	}

	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("only http/https protocols are allowed")
	}

	host := u.Hostname()
	if host == "" {
		return errors.New("empty hostname")
	}

	if ip := net.ParseIP(host); ip != nil && isInternalIP(ip) {
		return errors.Wrap(ErrInternalIP, ip.String())
	}

	return nil
}

type HTMLMeta struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Image       string `json:"image"`
}

func isWeChatArticleURL(u *url.URL) bool {
	return strings.EqualFold(u.Hostname(), "mp.weixin.qq.com")
}

func setWeChatArticleHeaders(req *http.Request) {
	if !isWeChatArticleURL(req.URL) {
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 Chrome/120.0.0.0")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	req.Header.Set("Referer", "https://mp.weixin.qq.com/")
}

func GetHTMLMeta(urlStr string) (*HTMLMeta, error) {
	return GetHTMLMetaWithContext(context.Background(), urlStr)
}

// GetHTMLMetaWithContext fetches metadata with cancellation and the same network restrictions.
func GetHTMLMetaWithContext(ctx context.Context, urlStr string) (*HTMLMeta, error) {
	if err := ValidateURL(urlStr); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlStr, nil)
	if err != nil {
		return nil, errors.Wrap(err, "create link metadata request")
	}
	setWeChatArticleHeaders(req)
	response, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, errors.Errorf("unexpected HTTP status: %d", response.StatusCode)
	}

	mediatype, err := getMediatype(response)
	if err != nil {
		return nil, err
	}
	if mediatype != "text/html" {
		return nil, errors.New("not a HTML page")
	}

	htmlMeta := extractHTMLMeta(io.LimitReader(response.Body, maxHTMLMetaBytes))
	enrichSiteMeta(response.Request.URL, htmlMeta)
	return htmlMeta, nil
}

func extractHTMLMeta(resp io.Reader) *HTMLMeta {
	tokenizer := html.NewTokenizer(resp)
	htmlMeta := new(HTMLMeta)

	for {
		tokenType := tokenizer.Next()
		if tokenType == html.ErrorToken {
			break
		} else if tokenType == html.StartTagToken || tokenType == html.SelfClosingTagToken {
			token := tokenizer.Token()
			if token.DataAtom == atom.Body {
				break
			}

			if token.DataAtom == atom.Title {
				// An empty <title></title> yields an end tag, whose Data is "title".
				// Only use actual text, and never overwrite an earlier Open Graph title.
				if tokenizer.Next() == html.TextToken && htmlMeta.Title == "" {
					htmlMeta.Title = strings.TrimSpace(tokenizer.Token().Data)
				}
			} else if token.DataAtom == atom.Meta {
				ogTitle, ok := extractMetaProperty(token, "og:title")
				if ok && strings.TrimSpace(ogTitle) != "" {
					htmlMeta.Title = strings.TrimSpace(ogTitle)
				}

				ogDescription, ok := extractMetaProperty(token, "og:description")
				if ok {
					htmlMeta.Description = ogDescription
				}

				ogImage, ok := extractMetaProperty(token, "og:image")
				if ok {
					htmlMeta.Image = ogImage
				}

				description, ok := extractMetaProperty(token, "description")
				if ok && htmlMeta.Description == "" {
					htmlMeta.Description = description
				}
			}
		}
	}

	return htmlMeta
}

func extractMetaProperty(token html.Token, prop string) (content string, ok bool) {
	content, ok = "", false
	for _, attr := range token.Attr {
		if (attr.Key == "property" || attr.Key == "name") && strings.EqualFold(attr.Val, prop) {
			ok = true
		}
		if attr.Key == "content" {
			content = attr.Val
		}
	}
	return content, ok
}

func enrichSiteMeta(url *url.URL, meta *HTMLMeta) {
	// These are site-shell titles, not article or video titles. Leave the title
	// empty so clients can keep the original link instead of a misleading card.
	switch strings.ToLower(url.Hostname()) {
	case "mp.weixin.qq.com":
		if strings.EqualFold(meta.Title, "title") || meta.Title == "微信公众平台" {
			meta.Title = ""
		}
	case "channels.weixin.qq.com":
		if strings.EqualFold(meta.Title, "title") || meta.Title == "视频号" {
			meta.Title = ""
		}
	default:
		// Preserve titles from other sites.
	}
	if url.Hostname() == "www.youtube.com" {
		if url.Path == "/watch" {
			vid := url.Query().Get("v")
			if vid != "" {
				meta.Image = fmt.Sprintf("https://img.youtube.com/vi/%s/mqdefault.jpg", vid)
			}
		}
	}
}
