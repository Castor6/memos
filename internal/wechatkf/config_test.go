package wechatkf

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEncryptedConfig(t *testing.T) {
	config := DefaultConfig()
	config.Secret = "private-test-secret"
	config.CallbackToken = "private-test-token"
	sealed, err := SealConfig(config, "instance-secret")
	require.NoError(t, err)
	require.NotContains(t, sealed, config.Secret)
	second, err := SealConfig(config, "instance-secret")
	require.NoError(t, err)
	require.NotEqual(t, sealed, second)
	opened, err := OpenConfig(sealed, "instance-secret")
	require.NoError(t, err)
	require.Equal(t, config, opened)
	_, err = OpenConfig(sealed, "wrong-instance-secret")
	require.Error(t, err)
	require.NotContains(t, err.Error(), config.Secret)
	_, err = OpenConfig(strings.Repeat("x", 20), "instance-secret")
	require.Error(t, err)
	defaults, err := OpenConfig("", "instance-secret")
	require.NoError(t, err)
	require.False(t, defaults.Enabled)
}

func TestConfigRejectsEmptySenderEntry(t *testing.T) {
	config := DefaultConfig()
	config.OwnerID = 1
	config.CorpID, config.KFID, config.Secret = "corp", "kf", "synthetic-secret"
	config.CallbackToken = "synthetictoken"
	config.EncodingKey = base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	config.AllowedUsers = []string{"self"}
	require.NoError(t, config.Validate())
	config.AllowedUsers = []string{""}
	require.Error(t, config.Validate())
}
