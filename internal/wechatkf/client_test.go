package wechatkf

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}
func testClient(t *testing.T, transport roundTripFunc) *Client {
	t.Helper()
	client, err := NewClient(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"owner"}}, "private-test-secret", 32)
	require.NoError(t, err)
	require.Nil(t, client.http.Transport.(*http.Transport).Proxy)
	client.http.Transport = transport
	t.Cleanup(client.Close)
	return client
}
func TestClientRefreshAndSync(t *testing.T) {
	var tokens, requests int
	client := testClient(t, func(r *http.Request) (*http.Response, error) {
		require.Equal(t, "qyapi.weixin.qq.com", r.URL.Host)
		if r.URL.Path == "/cgi-bin/gettoken" {
			tokens++
			return response(200, `{"access_token":"token","expires_in":7200}`), nil
		}
		requests++
		var payload map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
		require.Equal(t, "kf", payload["open_kfid"])
		require.Equal(t, float64(0), payload["voice_format"])
		require.Equal(t, "notice", payload["token"])
		if requests == 1 {
			return response(200, `{"errcode":42001}`), nil
		}
		return response(200, `{"next_cursor":"next","has_more":0,"msg_list":[{"msgid":"one"}]}`), nil
	})
	page, err := client.Sync(context.Background(), "before", "notice")
	require.NoError(t, err)
	require.Equal(t, "next", page.Cursor)
	require.Len(t, page.Messages, 1)
	require.Equal(t, 2, tokens)
	require.Equal(t, 2, requests)
}
func TestClientConcurrentTokenCache(t *testing.T) {
	var tokens atomic.Int32
	client := testClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/cgi-bin/gettoken" {
			tokens.Add(1)
			return response(200, `{"access_token":"token","expires_in":7200}`), nil
		}
		return response(200, `{"next_cursor":"end","has_more":0}`), nil
	})
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			_, err := client.Sync(context.Background(), "", "")
			if err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	require.Equal(t, int32(1), tokens.Load())
}
func TestSendAmbiguityDoesNotRetryOrLeak(t *testing.T) {
	calls := 0
	client := testClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/cgi-bin/gettoken" {
			return response(200, `{"access_token":"sensitive-token","expires_in":7200}`), nil
		}
		calls++
		return nil, errors.New("https://qyapi.weixin.qq.com?access_token=sensitive-token response private chat")
	})
	require.Error(t, client.SendText(context.Background(), "stranger", "id", "保存成功"))
	require.Zero(t, calls)
	err := client.SendText(context.Background(), "owner", "id", "保存成功")
	var remote *RemoteError
	require.ErrorAs(t, err, &remote)
	require.True(t, remote.Unknown)
	require.Equal(t, 1, calls)
	require.NotContains(t, err.Error(), "sensitive")
	require.NotContains(t, FailureReply("image", Outcome{MemoID: "memo"}, err, 12), "private")
	require.Contains(t, FailureReply("image", Outcome{MemoID: "memo"}, err, 12), "图片部分保存")
}
func TestMediaLimitsNamesAndRedirects(t *testing.T) {
	for _, scenario := range []string{"valid", "oversize", "redirect", "api"} {
		t.Run(scenario, func(t *testing.T) {
			calls := 0
			client := testClient(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/cgi-bin/gettoken" {
					return response(200, `{"access_token":"token","expires_in":7200}`), nil
				}
				calls++
				require.Equal(t, "/cgi-bin/media/get", r.URL.Path)
				switch scenario {
				case "oversize":
					return response(200, strings.Repeat("x", 33)), nil
				case "redirect":
					v := response(302, "")
					v.Header.Set("Location", "https://attacker.invalid")
					return v, nil
				case "api":
					v := response(200, `{"errcode":40007}`)
					v.Header.Set("Content-Type", "application/json")
					return v, nil
				default:
					v := response(200, "data")
					v.Header.Set("Content-Type", "text/plain")
					v.Header.Set("Content-Disposition", `attachment; filename="../hello.txt"`)
					return v, nil
				}
			})
			media, err := client.Download(context.Background(), "media")
			if scenario == "valid" {
				require.NoError(t, err)
				require.Equal(t, "hello.txt", media.Filename)
				require.Equal(t, []byte("data"), media.Data)
			} else {
				require.Error(t, err)
			}
			require.Equal(t, 1, calls)
		})
	}
	require.Empty(t, SafeFilename(strings.Repeat("中", 81)))
	require.Equal(t, "file.txt", SafeFilename("C:\\path\\file.txt"))
}
func TestSyncRejectsStuckCursorAndMalformedResponse(t *testing.T) {
	for _, body := range []string{`{"has_more":1,"next_cursor":"same"}`, `{"has_more":2}`, `null`, `[]`, `<html>secret</html>`} {
		client := testClient(t, func(r *http.Request) (*http.Response, error) {
			if r.URL.Path == "/cgi-bin/gettoken" {
				return response(200, `{"access_token":"token","expires_in":7200}`), nil
			}
			return response(200, body), nil
		})
		_, err := client.Sync(context.Background(), "same", "")
		require.Error(t, err)
		require.NotContains(t, err.Error(), "secret")
	}
}

func TestAccountAndCustomerLookupScope(t *testing.T) {
	client := testClient(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/cgi-bin/gettoken":
			return response(200, `{"access_token":"token","expires_in":7200}`), nil
		case "/cgi-bin/kf/account/list":
			return response(200, `{"account_list":[{"open_kfid":"kf"}]}`), nil
		default:
			var payload map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
			require.Equal(t, []any{"owner"}, payload["external_userid_list"])
			require.Equal(t, float64(1), payload["need_enter_session_context"])
			return response(200, `{"customer_list":[{"external_userid":"owner"}]}`), nil
		}
	})
	accounts, err := client.Accounts(context.Background())
	require.NoError(t, err)
	require.Len(t, accounts, 1)
	_, err = client.Customers(context.Background(), []string{"stranger"})
	require.Error(t, err)
	customers, err := client.Customers(context.Background(), []string{"owner"})
	require.NoError(t, err)
	require.NotEmpty(t, customers["customer_list"])
}
