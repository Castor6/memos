package wechatkf

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUploadFileMultipartAndTokenRefresh(t *testing.T) {
	media := Media{Data: []byte("# 标题\n\n正文。\n"), Filename: "公众号文章.md", Type: "text/markdown; charset=utf-8"}
	var tokens, uploads int
	client := testClient(t, func(r *http.Request) (*http.Response, error) {
		require.Equal(t, "https", r.URL.Scheme)
		require.Equal(t, "qyapi.weixin.qq.com", r.URL.Host)
		if r.URL.Path == "/cgi-bin/gettoken" {
			tokens++
			return response(200, `{"access_token":"token-`+strconv.Itoa(tokens)+`","expires_in":7200}`), nil
		}
		uploads++
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/cgi-bin/media/upload", r.URL.Path)
		require.Equal(t, "file", r.URL.Query().Get("type"))
		require.Equal(t, "token-"+strconv.Itoa(tokens), r.URL.Query().Get("access_token"))
		reader, err := r.MultipartReader()
		require.NoError(t, err)
		part, err := reader.NextPart()
		require.NoError(t, err)
		require.Equal(t, "media", part.FormName())
		require.Equal(t, media.Filename, part.FileName())
		_, params, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		require.NoError(t, err)
		require.Equal(t, strconv.Itoa(len(media.Data)), params["filelength"])
		require.Equal(t, media.Type, part.Header.Get("Content-Type"))
		data, err := io.ReadAll(part)
		require.NoError(t, err)
		require.Equal(t, media.Data, data)
		_, err = reader.NextPart()
		require.ErrorIs(t, err, io.EOF)
		if uploads == 1 {
			return response(200, `{"errcode":42001}`), nil
		}
		return response(200, `{"errcode":0,"type":"file","media_id":"temporary-media","created_at":1}`), nil
	})
	id, err := client.UploadFile(context.Background(), media)
	require.NoError(t, err)
	require.Equal(t, "temporary-media", id)
	require.Equal(t, 2, tokens)
	require.Equal(t, 2, uploads)
}

func TestUploadFileRejectsInvalidInputBeforeNetwork(t *testing.T) {
	client := testClient(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid input reached the network")
		return nil, nil
	})
	valid := Media{Data: []byte("content"), Filename: "文章.md"}
	for _, name := range []string{"", ".", "..", "../article.md", `folder\article.md`, "bad\nname.md", "bad\x00name.md", "bad:name.md", "bad\"name.md", strings.Repeat("中", 81), string([]byte{0xff})} {
		t.Run(strconv.QuoteToASCII(name), func(t *testing.T) {
			media := valid
			media.Filename = name
			_, err := client.UploadFile(context.Background(), media)
			require.Error(t, err)
		})
	}
	for _, size := range []int{0, 5, 33} {
		media := valid
		media.Data = bytes.Repeat([]byte("x"), size)
		_, err := client.UploadFile(context.Background(), media)
		require.Error(t, err)
	}
	media := valid
	media.Type = "text/plain\r\nX-Private: secret"
	_, err := client.UploadFile(context.Background(), media)
	require.Error(t, err)
	require.NotContains(t, err.Error(), "secret")
	client.maxMedia = 100 << 20
	media = valid
	media.Data = make([]byte, (20<<20)+1)
	_, err = client.UploadFile(context.Background(), media)
	require.Error(t, err)
}

func TestUploadFailuresNeverMeanMessageMayHaveBeenSent(t *testing.T) {
	for _, scenario := range []string{"network", "token-network", "format", "oversize", "redirect", "api", "refresh-exhausted", "missing-id", "invalid-id", "wrong-type"} {
		t.Run(scenario, func(t *testing.T) {
			calls := 0
			client := testClient(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/cgi-bin/gettoken" {
					if scenario == "token-network" {
						return nil, errors.New("private-secret")
					}
					return response(200, `{"access_token":"private-token","expires_in":7200}`), nil
				}
				calls++
				switch scenario {
				case "network":
					return nil, errors.New("private-token private-article")
				case "format":
					return response(200, "private-article"), nil
				case "oversize":
					return response(200, strings.Repeat("x", maxJSONBytes+1)), nil
				case "redirect":
					redirect := response(302, "private-article")
					redirect.Header.Set("Location", "https://attacker.invalid")
					return redirect, nil
				case "api":
					return response(200, `{"errcode":40007,"errmsg":"private-article"}`), nil
				case "refresh-exhausted":
					return response(200, `{"errcode":40014}`), nil
				case "missing-id":
					return response(200, `{"type":"file"}`), nil
				case "invalid-id":
					return response(200, `{"type":"file","media_id":"invalid\nidentifier"}`), nil
				default:
					return response(200, `{"type":"image","media_id":"id"}`), nil
				}
			})
			_, err := client.UploadFile(context.Background(), Media{Data: []byte("content"), Filename: "article.md"})
			var remote *RemoteError
			require.ErrorAs(t, err, &remote)
			require.False(t, remote.Unknown)
			require.NotContains(t, err.Error(), "private")
			expected := 1
			if scenario == "token-network" {
				expected = 0
			} else if scenario == "refresh-exhausted" {
				expected = 2
			}
			require.Equal(t, expected, calls)
		})
	}
}

func TestSendFilePayloadAndRefresh(t *testing.T) {
	var tokens, sends int
	client := testClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/cgi-bin/gettoken" {
			tokens++
			return response(200, `{"access_token":"token","expires_in":7200}`), nil
		}
		sends++
		require.Equal(t, "/cgi-bin/kf/send_msg", r.URL.Path)
		var payload map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&payload))
		require.Equal(t, map[string]any{"touser": "owner", "open_kfid": "kf", "msgid": "Reply_1-", "msgtype": "file", "file": map[string]any{"media_id": "media-id"}}, payload)
		if sends == 1 {
			return response(200, `{"errcode":40014}`), nil
		}
		return response(200, `{"errcode":0}`), nil
	})
	require.NoError(t, client.SendFile(context.Background(), "owner", "Reply_1-", "media-id"))
	require.Equal(t, 2, tokens)
	require.Equal(t, 2, sends)
}

func TestSendFileRejectsUnauthorizedOrMalformedInput(t *testing.T) {
	client := testClient(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid input reached the network")
		return nil, nil
	})
	for _, input := range [][3]string{
		{"stranger", "id", "media"}, {"owner", "", "media"}, {"owner", strings.Repeat("x", 33), "media"},
		{"owner", "id.1", "media"}, {"owner", "中文", "media"}, {"owner", "id", ""},
		{"owner", "id", "media\n"}, {"owner", "id", "media id"}, {"owner", "id", strings.Repeat("x", 1025)},
	} {
		require.Error(t, client.SendFile(context.Background(), input[0], input[1], input[2]))
	}
}

func TestSendFileAmbiguityAndDefiniteRejection(t *testing.T) {
	for _, scenario := range []string{"network", "format", "http", "api", "token-network"} {
		t.Run(scenario, func(t *testing.T) {
			sends := 0
			client := testClient(t, func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/cgi-bin/gettoken" {
					if scenario == "token-network" {
						return nil, errors.New("private-token")
					}
					return response(200, `{"access_token":"private-token","expires_in":7200}`), nil
				}
				sends++
				switch scenario {
				case "network":
					return nil, errors.New("private-token private-article")
				case "format":
					return response(200, "private-article"), nil
				case "http":
					return response(502, "private-article"), nil
				default:
					return response(200, `{"errcode":40007,"errmsg":"private-article"}`), nil
				}
			})
			err := client.SendFile(context.Background(), "owner", "id", "media")
			var remote *RemoteError
			require.ErrorAs(t, err, &remote)
			require.Equal(t, scenario != "api" && scenario != "token-network", remote.Unknown)
			require.NotContains(t, err.Error(), "private")
			if scenario == "token-network" {
				require.Zero(t, sends)
			} else {
				require.Equal(t, 1, sends)
			}
		})
	}
}
