package wechatkf

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func signedEnvelope(t *testing.T, receiver string, plain []byte, paddingByte byte) (string, string) {
	t.Helper()
	key := bytes.Repeat([]byte{7}, 32)
	data := append(bytes.Repeat([]byte{'r'}, 16), binary.BigEndian.AppendUint32(nil, uint32(len(plain)))...)
	data = append(data, plain...)
	data = append(data, receiver...)
	padding := 32 - len(data)%32
	if paddingByte == 0 {
		paddingByte = byte(padding)
	}
	data = append(data, bytes.Repeat([]byte{paddingByte}, padding)...)
	block, err := aes.NewCipher(key)
	require.NoError(t, err)
	cipher.NewCBCEncrypter(block, key[:16]).CryptBlocks(data, data)
	encrypted := base64.StdEncoding.EncodeToString(data)
	parts := []string{"test-token", "1700000000", "nonce", encrypted}
	slices.Sort(parts)
	sum := sha1.Sum([]byte(strings.Join(parts, "")))
	return hex.EncodeToString(sum[:]), encrypted
}
func TestCallbackValidation(t *testing.T) {
	crypto, err := NewCallbackCrypto("test-token", strings.TrimRight(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)), "="), "corp")
	require.NoError(t, err)
	sig, encrypted := signedEnvelope(t, "corp", []byte("exact-no-newline"), 0)
	plain, err := crypto.Verify(sig, "1700000000", "nonce", encrypted, time.Unix(1700000000, 0))
	require.NoError(t, err)
	require.Equal(t, "exact-no-newline", string(plain))
	for _, offset := range []int64{-601, 601} {
		_, err = crypto.Verify(sig, "1700000000", "nonce", encrypted, time.Unix(1700000000+offset, 0))
		require.ErrorIs(t, err, ErrInvalidCallback)
	}
	_, err = crypto.Verify(strings.Repeat("0", 40), "1700000000", "nonce", encrypted, time.Unix(1700000000, 0))
	require.ErrorIs(t, err, ErrInvalidCallback)
	for _, receiver := range []string{"wrong", "corp"} {
		padding := byte(0)
		if receiver == "corp" {
			padding = 33
		}
		sig, encrypted = signedEnvelope(t, receiver, []byte("hello"), padding)
		_, err = crypto.Decrypt(sig, strconv.Itoa(1700000000), "nonce", encrypted)
		require.ErrorIs(t, err, ErrInvalidCallback)
	}
	for _, key := range []string{"bad", strings.Repeat("!", 43)} {
		_, err = NewCallbackCrypto("token", key, "corp")
		require.ErrorIs(t, err, ErrInvalidCallback)
	}
}
func TestBoundedStrictXML(t *testing.T) {
	event, err := ParseNotification([]byte(`<xml><ToUserName>corp</ToUserName><Event>kf_msg_or_event</Event><OpenKfId>kf</OpenKfId><Token>token</Token></xml>`))
	require.NoError(t, err)
	require.Equal(t, "kf", event.KFID)
	for _, data := range []string{
		`<!DOCTYPE xml [<!ENTITY x SYSTEM "file:///etc/passwd">]><xml>&x;</xml>`,
		`<xml>&unknown;</xml>`, `<xml></xml><xml></xml>`, `<other/>`, strings.Repeat("x", MaxCallbackBytes+1),
	} {
		_, err = ParseNotification([]byte(data))
		require.ErrorIs(t, err, ErrInvalidCallback)
	}
	body, err := EncryptedBody([]byte(`<xml><Encrypt><![CDATA[abc]]></Encrypt></xml>`))
	require.NoError(t, err)
	require.Equal(t, "abc", body)
	_, err = EncryptedBody([]byte(`<xml/>`))
	require.ErrorIs(t, err, ErrInvalidCallback)
}

// Public Tencent example, not production credentials: https://developer.work.weixin.qq.com/document/path/90968
func TestOfficialCryptoVector(t *testing.T) {
	crypto, err := NewCallbackCrypto("QDG6eK", "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C", "wx5823bf96d3bd56c7")
	require.NoError(t, err)
	plain, err := crypto.Decrypt("477715d11cdb4164915debcba66cb864d751f3e6", "1409659813", "1372623149", "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==")
	require.NoError(t, err)
	require.Contains(t, string(plain), "<![CDATA[hello]]>")
}
