package wechatkf

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/pkg/errors"
)

const maxJSONBytes = 8 << 20

// RemoteError carries only a safe category and numeric status, never a URL/body.
// Unknown means a send may have reached WeChat and must not be blindly retried.
type RemoteError struct {
	Category string
	Code     int
	Unknown  bool
}

func (e *RemoteError) Error() string {
	switch e.Category {
	case "api":
		return "微信错误码 " + strconv.Itoa(e.Code)
	case "http":
		return "微信 HTTP " + strconv.Itoa(e.Code)
	case "size":
		return "微信响应超过大小限制"
	case "network":
		return "微信网络请求失败或超时"
	default:
		return "微信响应格式异常"
	}
}

// Client calls only the official API host. Its transport ignores proxy environment
// variables and refuses redirects to keep credentials on the configured host.
type Client struct {
	corp, secret, kfid string
	allowed            map[string]bool
	maxMedia           int64
	http               *http.Client
	mu                 sync.Mutex
	token              string
	expires            time.Time
}

func NewClient(binding Binding, secret string, maxMedia int64) (*Client, error) {
	if binding.CorpID == "" || binding.KFID == "" || secret == "" || len(binding.AllowedUsers) == 0 || maxMedia <= 0 || maxMedia > 100<<20 {
		return nil, errors.New("invalid WeChat client configuration")
	}
	allowed := map[string]bool{}
	for _, user := range binding.AllowedUsers {
		if user == "" {
			return nil, errors.New("empty WeChat sender")
		}
		allowed[user] = true
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &Client{corp: binding.CorpID, secret: secret, kfid: binding.KFID, allowed: allowed, maxMedia: maxMedia, http: &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Close releases idle connections; it does not cancel in-flight requests.
func (c *Client) Close() { c.http.CloseIdleConnections() }

func (c *Client) accessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Before(c.expires) {
		return c.token, nil
	}
	data, _, err := c.exchange(ctx, "/cgi-bin/gettoken", url.Values{"corpid": {c.corp}, "corpsecret": {c.secret}}, nil, maxJSONBytes)
	if err != nil {
		return "", err
	}
	var result struct {
		AccessToken string `json:"access_token"`
		Expires     int    `json:"expires_in"`
	}
	if err = decode(data, &result); err != nil {
		return "", err
	}
	if result.AccessToken == "" || result.Expires <= 0 {
		return "", &RemoteError{Category: "format"}
	}
	c.token = result.AccessToken
	c.expires = time.Now().Add(time.Duration(max(1, result.Expires-120)) * time.Second)
	return c.token, nil
}
func (c *Client) invalidate(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token == token {
		c.token = ""
	}
}

func (c *Client) exchange(ctx context.Context, endpoint string, query url.Values, payload any, limit int64) ([]byte, http.Header, error) {
	method := http.MethodGet
	var body io.Reader
	if payload != nil {
		method = http.MethodPost
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, nil, &RemoteError{Category: "format"}
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://qyapi.weixin.qq.com"+endpoint+"?"+query.Encode(), body)
	if err != nil {
		return nil, nil, &RemoteError{Category: "format"}
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(req)
	if err != nil {
		return nil, nil, &RemoteError{Category: "network", Unknown: true}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, &RemoteError{Category: "http", Code: response.StatusCode, Unknown: true}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, nil, &RemoteError{Category: "network", Unknown: true}
	}
	if int64(len(data)) > limit {
		return nil, nil, &RemoteError{Category: "size", Unknown: true}
	}
	return data, response.Header, nil
}
func decode(data []byte, target any) error {
	data = bytes.TrimSpace(data)
	var envelope struct {
		Code int `json:"errcode"`
	}
	if json.Unmarshal(data, &envelope) != nil || len(data) == 0 || data[0] != '{' {
		return &RemoteError{Category: "format", Unknown: true}
	}
	if envelope.Code != 0 {
		return &RemoteError{Category: "api", Code: envelope.Code}
	}
	if json.Unmarshal(data, target) != nil {
		return &RemoteError{Category: "format", Unknown: true}
	}
	return nil
}
func (c *Client) request(ctx context.Context, endpoint string, payload, target any) error {
	for attempt := 0; attempt < 2; attempt++ {
		token, err := c.accessToken(ctx)
		if err != nil {
			return err
		}
		data, _, err := c.exchange(ctx, endpoint, url.Values{"access_token": {token}}, payload, maxJSONBytes)
		if err == nil {
			err = decode(data, target)
		}
		var remote *RemoteError
		if attempt == 0 && errors.As(err, &remote) && remote.Category == "api" && (remote.Code == 40014 || remote.Code == 42001) {
			c.invalidate(token)
			continue
		}
		return err
	}
	return &RemoteError{Category: "format"}
}

// Page is durably committed with its cursor by the queue, never by this client.
type Page struct {
	Cursor   string    `json:"next_cursor"`
	HasMore  int       `json:"has_more"`
	Messages []Message `json:"msg_list"`
}

func (c *Client) Sync(ctx context.Context, cursor, notificationToken string) (Page, error) {
	payload := map[string]any{"cursor": cursor, "open_kfid": c.kfid, "limit": 100, "voice_format": 0}
	if notificationToken != "" {
		payload["token"] = notificationToken
	}
	var page Page
	err := c.request(ctx, "/cgi-bin/kf/sync_msg", payload, &page)
	if err == nil && (page.HasMore < 0 || page.HasMore > 1 || (page.HasMore == 1 && (page.Cursor == "" || page.Cursor == cursor))) {
		err = &RemoteError{Category: "format"}
	}
	return page, err
}

// SendText does not retry ambiguous failures. The worker must reserve a durable
// reply-window slot before calling it, and persist Unknown on ambiguous errors.
func (c *Client) SendText(ctx context.Context, user, id, content string) error {
	if !c.allowed[user] || len(id) == 0 || len(id) > 32 || content == "" || len(content) > 2048 {
		return errors.New("invalid WeChat reply")
	}
	var result map[string]any
	return c.request(ctx, "/cgi-bin/kf/send_msg", map[string]any{"touser": user, "open_kfid": c.kfid, "msgid": id, "msgtype": "text", "text": map[string]string{"content": content}}, &result)
}

// Download reads bounded media from Tencent, preserving a safe original filename.
func (c *Client) Download(ctx context.Context, id string) (Media, error) {
	if id == "" {
		return Media{}, errors.New("missing media ID")
	}
	for attempt := 0; attempt < 2; attempt++ {
		token, err := c.accessToken(ctx)
		if err != nil {
			return Media{}, err
		}
		data, header, err := c.exchange(ctx, "/cgi-bin/media/get", url.Values{"access_token": {token}, "media_id": {id}}, nil, c.maxMedia)
		if err != nil {
			return Media{}, err
		}
		_, params, _ := mime.ParseMediaType(header.Get("Content-Disposition"))
		name := SafeFilename(params["filename"])
		contentType, _, _ := mime.ParseMediaType(header.Get("Content-Type"))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		if strings.Contains(contentType, "json") && name == "" {
			var result map[string]any
			err = decode(data, &result)
			var remote *RemoteError
			if attempt == 0 && errors.As(err, &remote) && remote.Category == "api" && (remote.Code == 40014 || remote.Code == 42001) {
				c.invalidate(token)
				continue
			}
			if err != nil {
				return Media{}, err
			}
		}
		return Media{Data: data, Type: contentType, Filename: name}, nil
	}
	return Media{}, &RemoteError{Category: "format"}
}

// SafeFilename discards directory components and control characters.
func SafeFilename(value string) string {
	name := path.Base(strings.ReplaceAll(value, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.Trim(name, " .")
	if len(name) > 240 {
		return ""
	}
	return name
}

// Accounts reads the same bounded account inventory as the legacy integration.
func (c *Client) Accounts(ctx context.Context) ([]map[string]any, error) {
	var accounts []map[string]any
	for offset := 0; offset < 5000; offset += 100 {
		var page struct {
			Accounts []map[string]any `json:"account_list"`
		}
		if err := c.request(ctx, "/cgi-bin/kf/account/list", map[string]int{"offset": offset, "limit": 100}, &page); err != nil {
			return nil, err
		}
		accounts = append(accounts, page.Accounts...)
		if len(page.Accounts) < 100 {
			return accounts, nil
		}
	}
	return accounts, nil
}

// Customers only retrieves metadata for explicitly authorized senders.
func (c *Client) Customers(ctx context.Context, users []string) (map[string]any, error) {
	if len(users) == 0 || len(users) > 100 {
		return nil, errors.New("invalid customer lookup")
	}
	for _, user := range users {
		if !c.allowed[user] {
			return nil, errors.New("unauthorized customer lookup")
		}
	}
	var result map[string]any
	err := c.request(ctx, "/cgi-bin/kf/customer/batchget", map[string]any{"external_userid_list": users, "need_enter_session_context": 1}, &result)
	return result, err
}
