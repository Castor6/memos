package mcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"

	"github.com/usememos/memos/internal/profile"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/server/auth"
	apiv1 "github.com/usememos/memos/server/router/api/v1"
	"github.com/usememos/memos/store"
	teststore "github.com/usememos/memos/store/test"
)

func TestMCPPrivacyThroughRealGatewayWithSamePAT(t *testing.T) {
	ctx := context.Background()
	st := teststore.NewTestingStore(ctx, t)
	t.Cleanup(func() { require.NoError(t, st.Close()) })
	p := &profile.Profile{Demo: true, Data: t.TempDir(), Driver: "sqlite", DSN: ":memory:"}
	service := apiv1.NewAPIV1Service("test-secret", p, st)
	server := echo.New()
	require.NoError(t, service.RegisterGateway(ctx, server))
	user, err := st.CreateUser(ctx, &store.User{Username: "gateway-privacy", Role: store.RoleAdmin})
	require.NoError(t, err)
	app := context.WithValue(ctx, auth.UserIDContextKey, user.ID)
	memo, err := service.CreateMemo(app, &v1pb.CreateMemoRequest{Memo: &v1pb.Memo{Content: "private gateway content", McpHidden: true}})
	require.NoError(t, err)
	pat, err := service.CreatePersonalAccessToken(app, &v1pb.CreatePersonalAccessTokenRequest{Parent: "users/" + user.Username})
	require.NoError(t, err)
	authorization := "Bearer " + pat.Token
	mcpService, err := NewMCPService(p, server)
	require.NoError(t, err)
	operation := mcpService.operationsByTool["memo_get_memo"]
	result, err := newAPIAdapter(server).execute(ctx, operation.Operation, map[string]any{"name": memo.Name}, authorization)
	require.NoError(t, err)
	require.True(t, result.IsError)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/"+memo.Name, nil)
	req.Header.Set("Authorization", authorization)
	req.Header.Set("X-MCP-Request", "true")
	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, req)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), "private gateway content")
}
