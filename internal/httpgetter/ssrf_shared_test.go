package httpgetter

import (
	"context"
	"net"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSharedAddressSpaceBlockedAcrossFetchPaths(t *testing.T) {
	for _, address := range []string{"100.64.0.0", "100.100.100.200", "100.127.255.255", "::ffff:100.64.0.1"} {
		t.Run(address, func(t *testing.T) {
			url := "http://" + net.JoinHostPort(address, "80") + "/image.png"
			require.True(t, isInternalIP(net.ParseIP(address)))
			require.ErrorIs(t, validateURL(url), ErrInternalIP)
			_, err := GetPDFImage(context.Background(), url)
			require.ErrorIs(t, err, ErrInternalIP)
			req, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)
			require.ErrorIs(t, newHTTPClient().CheckRedirect(req, []*http.Request{req}), ErrInternalIP)
		})
	}
	for _, address := range []string{"100.63.255.255", "100.128.0.0", "8.8.8.8"} {
		require.False(t, isInternalIP(net.ParseIP(address)), address)
	}

	originalLookup := lookupIPAddr
	t.Cleanup(func() { lookupIPAddr = originalLookup })
	lookupIPAddr = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("100.64.0.1")}}, nil
	}
	_, err := resolveAllowedIPs(context.Background(), "mixed.example")
	require.ErrorIs(t, err, ErrInternalIP)
}
