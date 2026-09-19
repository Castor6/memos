package test

import (
	"bytes"
	"context"
	"encoding/base64"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	core "github.com/usememos/memos/internal/wechatkf"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
)

func TestWechatSettingsAdminEncryptionAndRevision(t *testing.T) {
	ts := NewTestService(t)
	defer ts.Cleanup()
	ctx := context.Background()
	admin, err := ts.CreateHostUser(ctx, "clip-admin")
	require.NoError(t, err)
	member, err := ts.CreateRegularUser(ctx, "clip-member")
	require.NoError(t, err)
	for _, c := range []context.Context{ctx, ts.CreateUserContext(ctx, member.ID)} {
		_, err = ts.Service.GetWechatKfSetting(c, &v1pb.GetWechatKfSettingRequest{})
		require.Error(t, err)
		_, err = ts.Service.UpdateWechatKfSetting(c, &v1pb.UpdateWechatKfSettingRequest{})
		require.Error(t, err)
		_, err = ts.Service.GetWechatKfStatus(c, &v1pb.GetWechatKfStatusRequest{})
		require.Error(t, err)
		_, err = ts.Service.TestWechatKfSetting(c, &v1pb.TestWechatKfSettingRequest{})
		require.Error(t, err)
	}
	ctx = ts.CreateUserContext(ctx, admin.ID)
	initial, err := ts.Service.GetWechatKfSetting(ctx, &v1pb.GetWechatKfSettingRequest{})
	require.NoError(t, err)
	require.False(t, initial.Enabled)
	require.False(t, initial.SecretSet)
	input := &v1pb.WechatKfSetting{Owner: "users/clip-admin", CorpId: "corp", KfId: "kf", AllowedUsers: []string{"self"}, DefaultTags: []string{"微信剪藏"}, ChatTag: "微信聊天记录", ReceiptsEnabled: true, MaxMediaMb: 20, Secret: "synthetic-api-secret", CallbackToken: "testtoken", EncodingAesKey: base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))}
	saved, err := ts.Service.UpdateWechatKfSetting(ctx, &v1pb.UpdateWechatKfSettingRequest{Setting: input})
	require.NoError(t, err)
	require.Empty(t, saved.Secret)
	require.Empty(t, saved.CallbackToken)
	require.Empty(t, saved.EncodingAesKey)
	require.True(t, saved.SecretSet)
	require.True(t, saved.CallbackTokenSet)
	require.True(t, saved.EncodingAesKeySet)
	state, err := ts.Store.WeChatConfiguration(ctx)
	require.NoError(t, err)
	require.NotContains(t, state.Value, input.Secret)
	require.NotContains(t, state.Value, "corp")
	decrypted, err := core.OpenConfig(state.Value, ts.Secret)
	require.NoError(t, err)
	require.Equal(t, input.Secret, decrypted.Secret)
	_, err = ts.Service.UpdateWechatKfSetting(ctx, &v1pb.UpdateWechatKfSettingRequest{Setting: input})
	require.Equal(t, codes.Aborted, status.Code(err))
	saved.Enabled = true
	updated, err := ts.Service.UpdateWechatKfSetting(ctx, &v1pb.UpdateWechatKfSettingRequest{Setting: saved})
	require.NoError(t, err)
	require.True(t, updated.Enabled)
	state, err = ts.Store.WeChatConfiguration(ctx)
	require.NoError(t, err)
	decrypted, err = core.OpenConfig(state.Value, ts.Secret)
	require.NoError(t, err)
	require.Equal(t, input.Secret, decrypted.Secret)
	updated.DefaultTags = []string{"bad\ntag"}
	_, err = ts.Service.UpdateWechatKfSetting(ctx, &v1pb.UpdateWechatKfSettingRequest{Setting: updated})
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}
