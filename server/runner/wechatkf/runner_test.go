package wechatkf

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"

	core "github.com/usememos/memos/internal/wechatkf"
	apitest "github.com/usememos/memos/server/router/api/v1/test"
	"github.com/usememos/memos/store"
)

type fakeRemote struct {
	mu        sync.Mutex
	message   core.Message
	sends     int
	sendError error
	closed    int
}

func (f *fakeRemote) Sync(context.Context, string, string) (core.Page, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Replays deliberately exercise the durable deduplication boundary.
	return core.Page{Cursor: "cursor-after", Messages: []core.Message{f.message}}, nil
}
func (*fakeRemote) Download(context.Context, string) (core.Media, error) {
	return core.Media{Data: []byte("file content"), Filename: "example.txt", Type: "text/plain"}, nil
}
func (f *fakeRemote) SendText(context.Context, string, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sends++
	return f.sendError
}
func (f *fakeRemote) Close() { f.mu.Lock(); defer f.mu.Unlock(); f.closed++ }

func configured(t *testing.T) (*apitest.TestService, *Runner, core.Config) {
	t.Helper()
	ts := apitest.NewTestService(t)
	t.Cleanup(ts.Cleanup)
	user, err := ts.CreateHostUser(context.Background(), "clip-admin")
	require.NoError(t, err)
	config := core.DefaultConfig()
	config.OwnerID = user.ID
	config.CorpID, config.KFID = "corp", "kf"
	config.AllowedUsers = []string{"self"}
	config.Secret, config.CallbackToken = "synthetic-secret", "testtoken"
	config.EncodingKey = base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	runner := New(ts.Store, ts.Secret, func(c core.Config) core.Notes { return ts.Service.NewWeChatKFNotes(c.OwnerID, c.Space) })
	return ts, runner, config
}
func saveConfig(t *testing.T, ts *apitest.TestService, config core.Config) {
	t.Helper()
	state, err := ts.Store.WeChatConfiguration(context.Background())
	require.NoError(t, err)
	sealed, err := core.SealConfig(config, ts.Secret)
	require.NoError(t, err)
	require.NoError(t, ts.Store.SaveWeChatConfiguration(context.Background(), sealed, state.Revision))
}

func TestRunnerLifecycleAndAmbiguousReceipt(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		t.Run(strconv.FormatBool(uncertain), func(t *testing.T) {
			ts, runner, config := configured(t)
			config.Enabled = true
			saveConfig(t, ts, config)
			remote := &fakeRemote{message: core.Message{"msgid": "input", "msgtype": "text", "text": map[string]any{"content": "剪藏正文 #测试"}, "external_userid": "self", "open_kfid": "kf", "origin": 3, "send_time": time.Now().Unix()}}
			stateName := "sent"
			if uncertain {
				remote.sendError = &core.RemoteError{Category: "network", Unknown: true}
				stateName = "unknown"
			}
			runner.remote = func(core.Config) (Remote, error) { return remote, nil }
			ctx, stop := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { defer close(done); runner.Run(ctx) }()
			t.Cleanup(func() { stop(); <-done })
			require.Eventually(t, func() bool {
				s, err := ts.Store.WeChatStatus(context.Background())
				return err == nil && s.Jobs["done"] == 1 && s.Replies[stateName] == 1
			}, 10*time.Second, 20*time.Millisecond)
			memos, err := ts.Store.ListMemos(context.Background(), &store.FindMemo{})
			require.NoError(t, err)
			require.Len(t, memos, 1)
			require.Equal(t, "剪藏正文", memos[0].Content)
			require.Equal(t, store.Private, memos[0].Visibility)
			config.Enabled = false
			saveConfig(t, ts, config)
			runner.Wake()
			require.Eventually(t, func() bool {
				s, err := ts.Store.WeChatConfiguration(context.Background())
				return err == nil && s.LeaseUntil == 0
			}, 5*time.Second, 20*time.Millisecond)
			config.Enabled = true
			saveConfig(t, ts, config)
			runner.Wake()
			require.Eventually(t, func() bool {
				s, err := ts.Store.WeChatConfiguration(context.Background())
				return err == nil && s.LeaseUntil > time.Now().Unix()
			}, 5*time.Second, 20*time.Millisecond)
			s, err := ts.Store.WeChatConfiguration(context.Background())
			require.NoError(t, err)
			require.NoError(t, ts.Store.SignalWeChat(context.Background(), s.Revision, "notification", time.Now().Unix()))
			runner.Wake()
			stop()
			<-done
			remote.mu.Lock()
			require.Equal(t, 1, remote.sends)
			require.Equal(t, 2, remote.closed)
			remote.mu.Unlock()
			memos, err = ts.Store.ListMemos(context.Background(), &store.FindMemo{})
			require.NoError(t, err)
			require.Len(t, memos, 1)
		})
	}
}

func callbackRequest(t *testing.T, method, receiver, body string) *http.Request {
	t.Helper()
	key := bytes.Repeat([]byte{7}, 32)
	data := append(bytes.Repeat([]byte{'r'}, 16), binary.BigEndian.AppendUint32(nil, uint32(len(body)))...)
	data = append(data, []byte(body)...)
	data = append(data, []byte(receiver)...)
	padding := 32 - len(data)%32
	data = append(data, bytes.Repeat([]byte{byte(padding)}, padding)...)
	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	cipher.NewCBCEncrypter(block, key[:16]).CryptBlocks(data, data)
	encrypted := base64.StdEncoding.EncodeToString(data)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	parts := []string{"testtoken", timestamp, "nonce", encrypted}
	slices.Sort(parts)
	sum := sha1.Sum([]byte(strings.Join(parts, "")))
	query := url.Values{"msg_signature": {hex.EncodeToString(sum[:])}, "timestamp": {timestamp}, "nonce": {"nonce"}}
	if method == http.MethodGet {
		query.Set("echostr", encrypted)
	}
	return httptest.NewRequest(method, "/wechat/callback?"+query.Encode(), strings.NewReader("<xml><Encrypt>"+encrypted+"</Encrypt></xml>"))
}

func TestCallbackAcknowledgesOnlyDurableNotification(t *testing.T) {
	ts, runner, config := configured(t)
	saveConfig(t, ts, config)
	e := echo.New()
	e.GET("/wechat/callback", runner.Callback)
	e.POST("/wechat/callback", runner.Callback)
	call := func(req *http.Request) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		e.ServeHTTP(recorder, req)
		return recorder
	}
	resp := call(callbackRequest(t, http.MethodGet, "corp", "exact-no-newline"))
	require.Equal(t, 200, resp.Code)
	require.Equal(t, "exact-no-newline", resp.Body.String())
	notification := `<xml><ToUserName>corp</ToUserName><Event>kf_msg_or_event</Event><OpenKfId>kf</OpenKfId><Token>notify-token</Token></xml>`
	require.Equal(t, 503, call(callbackRequest(t, http.MethodPost, "corp", notification)).Code)
	config.Enabled = true
	saveConfig(t, ts, config)
	require.Equal(t, 403, call(callbackRequest(t, http.MethodPost, "wrong", notification)).Code)
	require.Equal(t, 400, call(callbackRequest(t, http.MethodPost, "corp", strings.ReplaceAll(notification, "<OpenKfId>kf", "<OpenKfId>other"))).Code)
	forged := callbackRequest(t, http.MethodPost, "corp", notification)
	query := forged.URL.Query()
	query.Set("msg_signature", strings.Repeat("0", 40))
	forged.URL.RawQuery = query.Encode()
	require.Equal(t, 403, call(forged).Code)
	require.Equal(t, 413, call(httptest.NewRequest(http.MethodPost, "/wechat/callback", strings.NewReader(strings.Repeat("x", core.MaxCallbackBytes+1)))).Code)
	resp = call(callbackRequest(t, http.MethodPost, "corp", notification))
	require.Equal(t, 200, resp.Code)
	require.Equal(t, "success", resp.Body.String())
	syncState, err := ts.Store.ReadWeChatSync(context.Background())
	require.NoError(t, err)
	require.Equal(t, "notify-token", syncState.Token)
	require.EqualValues(t, 1, syncState.Generation)
	// A database failure must not acknowledge an unrecorded message notification.
	require.NoError(t, ts.Store.Close())
	require.Equal(t, 503, call(callbackRequest(t, http.MethodPost, "corp", notification)).Code)
}
