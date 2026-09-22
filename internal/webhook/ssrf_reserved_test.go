package webhook

import (
	"context"
	"net"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSharedAndUnspecifiedDestinations(t *testing.T) {
	original := AllowPrivateIPs
	AllowPrivateIPs = false
	t.Cleanup(func() { AllowPrivateIPs = original })
	for _, address := range []string{"0.0.0.0", "0.1.2.3", "::", "::ffff:0.0.0.0", "100.64.0.0", "100.100.100.200", "100.127.255.255", "::ffff:100.64.0.1"} {
		t.Run(address, func(t *testing.T) {
			require.True(t, isReservedIP(net.ParseIP(address)))
			destination := net.JoinHostPort(address, "80")
			require.Error(t, ValidateURL("http://"+destination+"/hook"))
			conn, err := safeDialContext(context.Background(), "tcp", destination)
			require.Error(t, err)
			require.Nil(t, conn)
		})
	}
	for _, address := range []string{"100.63.255.255", "100.128.0.0", "8.8.8.8"} {
		require.False(t, isReservedIP(net.ParseIP(address)), address)
	}
	AllowPrivateIPs = true
	require.False(t, isReservedIP(net.ParseIP("100.64.0.1")))
}
