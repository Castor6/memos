package wechatkf

import (
	"io"
	"net/http"
	"time"

	"github.com/labstack/echo/v5"

	core "github.com/usememos/memos/internal/wechatkf"
)

// Callback accepts only signed WeChat requests and durably records a notification
// before acknowledging it. Disabled POST requests fail visibly instead of dropping data.
func (r *Runner) Callback(c *echo.Context) error {
	request := c.Request()
	state, err := r.store.WeChatConfiguration(request.Context())
	if err != nil {
		return c.NoContent(http.StatusServiceUnavailable)
	}
	config, err := core.OpenConfig(state.Value, r.secret)
	if err != nil || config.Validate() != nil {
		return c.NoContent(http.StatusServiceUnavailable)
	}
	crypto, err := core.NewCallbackCrypto(config.CallbackToken, config.EncodingKey, config.CorpID)
	if err != nil {
		return c.NoContent(http.StatusServiceUnavailable)
	}
	query := request.URL.Query()
	encrypted := query.Get("echostr")
	if request.Method == http.MethodPost {
		body, err := io.ReadAll(io.LimitReader(request.Body, core.MaxCallbackBytes+1))
		if err != nil {
			return c.NoContent(http.StatusBadRequest)
		}
		if len(body) > core.MaxCallbackBytes {
			return c.NoContent(http.StatusRequestEntityTooLarge)
		}
		encrypted, err = core.EncryptedBody(body)
		if err != nil {
			return c.NoContent(http.StatusBadRequest)
		}
	}
	plain, err := crypto.Verify(query.Get("msg_signature"), query.Get("timestamp"), query.Get("nonce"), encrypted, time.Now())
	if err != nil {
		return c.NoContent(http.StatusForbidden)
	}
	if request.Method == http.MethodGet {
		return c.Blob(http.StatusOK, "text/plain", plain)
	}
	if !config.Enabled {
		return c.NoContent(http.StatusServiceUnavailable)
	}
	event, err := core.ParseNotification(plain)
	if err != nil || event.Receiver != config.CorpID || event.KFID != config.KFID || event.Event != "kf_msg_or_event" {
		return c.NoContent(http.StatusBadRequest)
	}
	if err = r.store.SignalWeChat(request.Context(), state.Revision, event.Token, time.Now().Unix()); err != nil {
		return c.NoContent(http.StatusServiceUnavailable)
	}
	r.Wake()
	return c.String(http.StatusOK, "success")
}
