// Package wechatkf implements the protocol and content core of the built-in WeChat KF integration.
package wechatkf

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // WeChat's documented callback signature uses SHA-1.
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"io"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
)

const MaxCallbackBytes = 1 << 20

// ErrInvalidCallback deliberately omits input, signatures and key material.
var ErrInvalidCallback = errors.New("invalid WeChat callback")

// CallbackCrypto verifies the documented WeChat signature and encrypted envelope.
// Instances are immutable and safe for concurrent use.
type CallbackCrypto struct {
	token, receiver string
	key             []byte
}

func NewCallbackCrypto(token, encodingKey, receiver string) (*CallbackCrypto, error) {
	if token == "" || receiver == "" || len(encodingKey) != 43 {
		return nil, ErrInvalidCallback
	}
	// Tencent's published key contains nonzero unused base64 bits. Match its
	// decoder while still validating the alphabet and exact decoded key length.
	key, err := base64.StdEncoding.DecodeString(encodingKey + "=")
	if err != nil || len(key) != 32 {
		return nil, ErrInvalidCallback
	}
	return &CallbackCrypto{token: token, receiver: receiver, key: key}, nil
}

// Verify includes the ten-minute request age check used by the existing bridge.
func (c *CallbackCrypto) Verify(signature, timestamp, nonce, encrypted string, now time.Time) ([]byte, error) {
	if len(timestamp) > 256 || len(nonce) > 256 || len(signature) != 40 {
		return nil, ErrInvalidCallback
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || seconds < now.Unix()-600 || seconds > now.Unix()+600 {
		return nil, ErrInvalidCallback
	}
	return c.Decrypt(signature, timestamp, nonce, encrypted)
}

// Decrypt validates a signed envelope. Call Verify for live requests; this method
// also permits verification of the historical official test vector.
func (c *CallbackCrypto) Decrypt(signature, timestamp, nonce, encrypted string) ([]byte, error) {
	if len(encrypted) > MaxCallbackBytes || len(signature) != 40 {
		return nil, ErrInvalidCallback
	}
	parts := []string{c.token, timestamp, nonce, encrypted}
	slices.Sort(parts)
	sum := sha1.Sum([]byte(strings.Join(parts, ""))) //nolint:gosec // Required by WeChat's protocol.
	provided, err := hex.DecodeString(signature)
	if err != nil || !hmac.Equal(sum[:], provided) {
		return nil, ErrInvalidCallback
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encrypted)
	if err != nil || len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return nil, ErrInvalidCallback
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, ErrInvalidCallback
	}
	cipher.NewCBCDecrypter(block, c.key[:aes.BlockSize]).CryptBlocks(data, data)
	padding := int(data[len(data)-1])
	if padding < 1 || padding > 32 || padding > len(data) || !bytes.Equal(data[len(data)-padding:], bytes.Repeat([]byte{byte(padding)}, padding)) {
		return nil, ErrInvalidCallback
	}
	data = data[:len(data)-padding]
	if len(data) < 20 {
		return nil, ErrInvalidCallback
	}
	size := uint64(binary.BigEndian.Uint32(data[16:20]))
	if size > uint64(len(data)-20) {
		return nil, ErrInvalidCallback
	}
	end := 20 + int(size)
	if !hmac.Equal(data[end:], []byte(c.receiver)) {
		return nil, ErrInvalidCallback
	}
	return data[20:end], nil
}

// Notification contains only routing fields; it must never be logged verbatim.
type Notification struct {
	XMLName  xml.Name `xml:"xml"`
	Receiver string   `xml:"ToUserName"`
	Event    string   `xml:"Event"`
	KFID     string   `xml:"OpenKfId"`
	Token    string   `xml:"Token"`
}

// ParseNotification rejects DTDs, entities, oversized bodies and multiple XML roots.
// Signature/envelope verification must precede parsing this decrypted payload.
func ParseNotification(data []byte) (Notification, error) {
	var event Notification
	if err := decodeXML(data, &event); err != nil {
		return Notification{}, err
	}
	if len(event.Token) > 128 {
		return Notification{}, ErrInvalidCallback
	}
	return event, nil
}

// EncryptedBody reads the encrypted field from a POST envelope without expanding entities.
func EncryptedBody(data []byte) (string, error) {
	var envelope struct {
		XMLName xml.Name `xml:"xml"`
		Encrypt string   `xml:"Encrypt"`
	}
	if err := decodeXML(data, &envelope); err != nil {
		return "", err
	}
	if envelope.Encrypt == "" {
		return "", ErrInvalidCallback
	}
	return envelope.Encrypt, nil
}

func decodeXML(data []byte, target any) error {
	if len(data) == 0 || len(data) > MaxCallbackBytes {
		return ErrInvalidCallback
	}
	scan := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := scan.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return ErrInvalidCallback
		}
		if _, ok := token.(xml.Directive); ok {
			return ErrInvalidCallback
		}
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	if decoder.Decode(target) != nil {
		return ErrInvalidCallback
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return ErrInvalidCallback
		}
		if text, ok := token.(xml.CharData); !ok || strings.TrimSpace(string(text)) != "" {
			return ErrInvalidCallback
		}
	}
}
