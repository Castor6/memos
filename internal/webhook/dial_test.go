package webhook

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestDialValidatedAddressPinsResolvedIPs(t *testing.T) {
	lookupCalls := 0
	var dialed []string
	client, server := net.Pipe()
	t.Cleanup(func() { client.Close() })
	t.Cleanup(func() { server.Close() })
	conn, err := dialValidatedAddress(context.Background(), "tcp", "hooks.example.test:443",
		func(_ context.Context, host string) ([]string, error) {
			lookupCalls++
			require.Equal(t, "hooks.example.test", host)
			return []string{"2001:4860:4860::8888", "93.184.216.34"}, nil
		},
		func(_ context.Context, network, address string) (net.Conn, error) {
			require.Equal(t, "tcp", network)
			dialed = append(dialed, address)
			if len(dialed) == 1 {
				return nil, errors.New("first address unavailable")
			}
			return client, nil
		})
	require.NoError(t, err)
	require.Same(t, client, conn)
	require.Equal(t, 1, lookupCalls)
	require.Equal(t, []string{"[2001:4860:4860::8888]:443", "93.184.216.34:443"}, dialed)
}

func TestDialValidatedAddressRejectsAllBeforeConnecting(t *testing.T) {
	for _, tc := range []struct {
		name string
		ips  []string
	}{
		{name: "mixed private", ips: []string{"93.184.216.34", "10.0.0.1"}},
		{name: "IPv6 loopback", ips: []string{"::1"}},
		{name: "IPv4 mapped private", ips: []string{"::ffff:127.0.0.1"}},
		{name: "invalid address", ips: []string{"93.184.216.34", "not-an-ip"}},
		{name: "empty result"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := dialValidatedAddress(context.Background(), "tcp", "hooks.example.test:443",
				func(context.Context, string) ([]string, error) { return tc.ips, nil },
				func(context.Context, string, string) (net.Conn, error) {
					t.Fatal("must validate the entire result before connecting")
					return nil, nil
				})
			require.Error(t, err)
		})
	}
}

func TestDialValidatedAddressHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	_, err := dialValidatedAddress(ctx, "tcp", "hooks.example.test:443",
		func(context.Context, string) ([]string, error) {
			cancel()
			return []string{"93.184.216.34"}, nil
		},
		func(context.Context, string, string) (net.Conn, error) {
			t.Fatal("must not dial after cancellation")
			return nil, nil
		})
	require.ErrorIs(t, err, context.Canceled)
}

func TestDialValidatedAddressPreservesHTTPHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "hooks.example.test", r.Host)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialValidatedAddress(ctx, network, addr,
				func(context.Context, string) ([]string, error) { return []string{"93.184.216.34"}, nil },
				func(ctx context.Context, network, addr string) (net.Conn, error) {
					require.Equal(t, "93.184.216.34:80", addr)
					return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
				})
		},
	}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport}
	resp, err := client.Get("http://hooks.example.test/event")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
}
