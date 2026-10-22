package wechatkf

import (
	"bytes"
	"context"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/pkg/errors"
)

// UploadFile creates temporary media without sending a customer-visible message.
// Upload failures are always safe to retry, even if the upload response was lost.
func (c *Client) UploadFile(ctx context.Context, media Media) (string, error) {
	if len(media.Data) <= 5 || int64(len(media.Data)) > min(c.maxMedia, 20<<20) {
		return "", errors.New("invalid WeChat file size")
	}
	if media.Filename == "" || media.Filename != SafeFilename(media.Filename) || !utf8.ValidString(media.Filename) || strings.ContainsAny(media.Filename, `/\:*?"<>|`) {
		return "", errors.New("invalid WeChat filename")
	}
	contentType := media.Type
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	parsedType, params, err := mime.ParseMediaType(contentType)
	if err != nil || strings.ContainsAny(contentType, "\r\n") || !strings.Contains(parsedType, "/") {
		return "", errors.New("invalid WeChat content type")
	}
	contentType = mime.FormatMediaType(parsedType, params)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	// Use a quoted UTF-8 filename, as required by the media upload endpoint.
	header.Set("Content-Disposition", `form-data; name="media"; filename="`+media.Filename+`"; filelength="`+strconv.Itoa(len(media.Data))+`"`)
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", errors.New("cannot prepare WeChat file upload")
	}
	if _, err = part.Write(media.Data); err != nil {
		return "", errors.New("cannot prepare WeChat file upload")
	}
	if err = writer.Close(); err != nil {
		return "", errors.New("cannot prepare WeChat file upload")
	}
	for attempt := 0; attempt < 2; attempt++ {
		token, err := c.accessToken(ctx)
		if err != nil {
			return "", uploadFailure(err)
		}
		query := url.Values{"access_token": {token}, "type": {"file"}}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://qyapi.weixin.qq.com/cgi-bin/media/upload?"+query.Encode(), bytes.NewReader(body.Bytes()))
		if err != nil {
			return "", &RemoteError{Category: "format"}
		}
		req.Header.Set("Content-Type", writer.FormDataContentType())
		id, err := c.uploadFileRequest(req)
		var remote *RemoteError
		if attempt == 0 && errors.As(err, &remote) && remote.Category == "api" && (remote.Code == 40014 || remote.Code == 42001) {
			c.invalidate(token)
			continue
		}
		return id, uploadFailure(err)
	}
	return "", &RemoteError{Category: "format"}
}

func (c *Client) uploadFileRequest(req *http.Request) (string, error) {
	response, err := c.http.Do(req)
	if err != nil {
		return "", &RemoteError{Category: "network"}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", &RemoteError{Category: "http", Code: response.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxJSONBytes+1))
	if err != nil {
		return "", &RemoteError{Category: "network"}
	}
	if len(data) > maxJSONBytes {
		return "", &RemoteError{Category: "size"}
	}
	var result struct {
		Type    string `json:"type"`
		MediaID string `json:"media_id"`
	}
	if err := decode(data, &result); err != nil {
		return "", uploadFailure(err)
	}
	if result.Type != "file" || !validMediaID(result.MediaID) {
		return "", &RemoteError{Category: "format"}
	}
	return result.MediaID, nil
}

func uploadFailure(err error) error {
	var remote *RemoteError
	if errors.As(err, &remote) {
		return &RemoteError{Category: remote.Category, Code: remote.Code}
	}
	return err
}

// SendFile sends uploaded media only after the worker reserves a durable slot.
// Ambiguous send failures are not retried by this client.
func (c *Client) SendFile(ctx context.Context, user, id, mediaID string) error {
	if !c.allowed[user] || !validReplyID(id) || !validMediaID(mediaID) {
		return errors.New("invalid WeChat file reply")
	}
	var result map[string]any
	return c.request(ctx, "/cgi-bin/kf/send_msg", map[string]any{
		"touser": user, "open_kfid": c.kfid, "msgid": id,
		"msgtype": "file", "file": map[string]string{"media_id": mediaID},
	}, &result)
}

func validReplyID(id string) bool {
	if len(id) == 0 || len(id) > 32 {
		return false
	}
	for _, r := range id {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' {
			return false
		}
	}
	return true
}

func validMediaID(id string) bool {
	if len(id) == 0 || len(id) > 1024 {
		return false
	}
	for _, r := range id {
		if r < 33 || r > 126 {
			return false
		}
	}
	return true
}
