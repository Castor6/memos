package wechatkf

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/pkg/errors"
)

// Config is trusted, encrypted server configuration for one personal integration.
// Never log it or return it through a public instance-settings API.
type Config struct {
	Binding
	Enabled       bool
	OwnerID       int32
	Space         string
	Secret        string
	CallbackToken string
	EncodingKey   string
	Receipts      bool
	MaxMediaMB    int
	PollSeconds   int
}

// DefaultConfig leaves the integration disabled until explicitly configured.
func DefaultConfig() Config {
	return Config{Binding: Binding{DefaultTags: []string{"微信剪藏"}, ChatTag: "微信聊天记录"}, Receipts: true, MaxMediaMB: 20, PollSeconds: 300}
}

// Validate verifies a complete binding before enabling or testing it.
func (c Config) Validate() error {
	if len(c.Secret) > 512 {
		return errors.New("客服 Secret 长度异常")
	}
	if c.OwnerID <= 0 || c.CorpID == "" || c.KFID == "" || c.Secret == "" || len(c.AllowedUsers) == 0 {
		return errors.New("请填写 Memos 用户、企业 ID、客服账号、Secret 和本人白名单")
	}
	for _, id := range append([]string{c.CorpID, c.KFID}, c.AllowedUsers...) {
		if len(id) > 191 || strings.ContainsAny(id, "\x00\r\n\t ") {
			return errors.New("账号标识格式不正确")
		}
	}
	if len(c.AllowedUsers) > 100 || c.MaxMediaMB < 1 || c.MaxMediaMB > 100 || c.PollSeconds < 10 || c.PollSeconds > 3600 {
		return errors.New("白名单或处理限制超出允许范围")
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9]{3,32}$`).MatchString(c.CallbackToken) {
		return errors.New("回调 Token 应为 3–32 位字母数字")
	}
	if _, err := NewCallbackCrypto(c.CallbackToken, c.EncodingKey, c.CorpID); err != nil {
		return errors.New("回调 EncodingAESKey 格式不正确")
	}
	return nil
}

// SealConfig encrypts credentials using the existing instance secret with a
// domain-separated key and fresh nonce. Backups must retain the instance secret.
func SealConfig(config Config, secret string) (string, error) {
	aead, err := configCipher(secret)
	if err != nil {
		return "", err
	}
	plain, err := json.Marshal(config)
	if err != nil {
		return "", errors.New("invalid integration configuration")
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", errors.New("unable to encrypt integration configuration")
	}
	sealed := aead.Seal(nonce, nonce, plain, []byte("memos.wechat-kf.v1"))
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// OpenConfig returns defaults for an unconfigured instance and never echoes data.
func OpenConfig(value, secret string) (Config, error) {
	if value == "" {
		return DefaultConfig(), nil
	}
	aead, err := configCipher(secret)
	if err != nil {
		return Config{}, err
	}
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(data) < aead.NonceSize() {
		return Config{}, errors.New("unable to decrypt integration configuration")
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte("memos.wechat-kf.v1"))
	if err != nil {
		return Config{}, errors.New("unable to decrypt integration configuration")
	}
	var result Config
	if json.Unmarshal(plain, &result) != nil {
		return Config{}, errors.New("invalid integration configuration")
	}
	return result, nil
}
func configCipher(secret string) (cipher.AEAD, error) {
	if secret == "" {
		return nil, errors.New("missing instance secret")
	}
	key := sha256.Sum256([]byte("memos.wechat-kf.configuration\x00" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
