package v1

import (
	"context"
	"strings"
	"time"

	"github.com/pkg/errors"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"

	core "github.com/usememos/memos/internal/wechatkf"
	v1pb "github.com/usememos/memos/proto/gen/api/v1"
	"github.com/usememos/memos/store"
)

func (s *APIV1Service) wechatAdmin(ctx context.Context) error {
	user, err := s.fetchCurrentUser(ctx)
	if err != nil {
		return status.Error(codes.Internal, "无法读取当前用户")
	}
	if user == nil {
		return status.Error(codes.Unauthenticated, "请先登录")
	}
	if user.Role != store.RoleAdmin {
		return status.Error(codes.PermissionDenied, "仅管理员可管理微信客服")
	}
	return nil
}
func (s *APIV1Service) wechatConfig(ctx context.Context) (core.Config, store.WeChatState, error) {
	state, err := s.Store.WeChatConfiguration(ctx)
	if err != nil {
		return core.Config{}, state, status.Error(codes.Internal, "无法读取微信客服配置")
	}
	config, err := core.OpenConfig(state.Value, s.Secret)
	if err != nil {
		return config, state, status.Error(codes.Internal, "无法解密微信客服配置")
	}
	return config, state, nil
}
func (s *APIV1Service) wechatSetting(ctx context.Context, config core.Config, revision int64) (*v1pb.WechatKfSetting, error) {
	owner := ""
	if config.OwnerID > 0 {
		user, err := s.Store.GetUser(ctx, &store.FindUser{ID: &config.OwnerID})
		if err != nil {
			return nil, status.Error(codes.Internal, "无法读取绑定用户")
		}
		if user != nil {
			owner = "users/" + user.Username
		}
	}
	return &v1pb.WechatKfSetting{Enabled: config.Enabled, Owner: owner, Space: config.Space, CorpId: config.CorpID, KfId: config.KFID, AllowedUsers: config.AllowedUsers, DefaultTags: config.DefaultTags, ChatTag: config.ChatTag, ReceiptsEnabled: config.Receipts, MaxMediaMb: int32(config.MaxMediaMB), SecretSet: config.Secret != "", CallbackTokenSet: config.CallbackToken != "", EncodingAesKeySet: config.EncodingKey != "", Revision: revision, CallbackPath: "/wechat/callback"}, nil
}

// GetWechatKfSetting returns only redacted settings to an authenticated admin.
func (s *APIV1Service) GetWechatKfSetting(ctx context.Context, _ *v1pb.GetWechatKfSettingRequest) (*v1pb.WechatKfSetting, error) {
	if err := s.wechatAdmin(ctx); err != nil {
		return nil, err
	}
	config, state, err := s.wechatConfig(ctx)
	if err != nil {
		return nil, err
	}
	return s.wechatSetting(ctx, config, state.Revision)
}

// UpdateWechatKfSetting never accepts owner selection from a callback payload.
func (s *APIV1Service) UpdateWechatKfSetting(ctx context.Context, request *v1pb.UpdateWechatKfSettingRequest) (*v1pb.WechatKfSetting, error) {
	if err := s.wechatAdmin(ctx); err != nil {
		return nil, err
	}
	input := request.GetSetting()
	if input == nil {
		return nil, status.Error(codes.InvalidArgument, "缺少微信客服设置")
	}
	previous, state, err := s.wechatConfig(ctx)
	if err != nil {
		return nil, err
	}
	if input.Revision != state.Revision {
		return nil, status.Error(codes.Aborted, "配置已更新，请刷新后重试")
	}
	owner := strings.TrimPrefix(input.Owner, "users/")
	if owner == "" || owner == input.Owner {
		return nil, status.Error(codes.InvalidArgument, "请选择保存笔记的 Memos 用户")
	}
	user, err := s.Store.GetUser(ctx, &store.FindUser{Username: &owner})
	if err != nil {
		return nil, status.Error(codes.Internal, "无法读取绑定用户")
	}
	if user == nil || user.RowStatus != store.Normal {
		return nil, status.Error(codes.InvalidArgument, "绑定用户不存在或已停用")
	}
	config := core.DefaultConfig()
	config.Enabled = input.Enabled
	config.OwnerID = user.ID
	config.Space = input.Space
	config.CorpID = strings.TrimSpace(input.CorpId)
	config.KFID = strings.TrimSpace(input.KfId)
	config.AllowedUsers = input.AllowedUsers
	config.DefaultTags = input.DefaultTags
	config.ChatTag = input.ChatTag
	config.Receipts = input.ReceiptsEnabled
	config.MaxMediaMB = int(input.MaxMediaMb)
	config.Secret = input.Secret
	config.CallbackToken = input.CallbackToken
	config.EncodingKey = input.EncodingAesKey
	if config.Secret == "" {
		config.Secret = previous.Secret
	}
	if config.CallbackToken == "" {
		config.CallbackToken = previous.CallbackToken
	}
	if config.EncodingKey == "" {
		config.EncodingKey = previous.EncodingKey
	}
	if err = config.Validate(); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if _, err = s.validateSelectedSpace(store.WithSpace(ctx, config.Space), user.ID); err != nil {
		return nil, err
	}
	tags := append([]string(nil), config.DefaultTags...)
	if config.ChatTag != "" {
		tags = append(tags, config.ChatTag)
	}
	if err = validateExplicitTags(tags); err != nil {
		return nil, err
	}
	if previous.CorpID != "" && (previous.CorpID != config.CorpID || previous.KFID != config.KFID || previous.OwnerID != config.OwnerID || previous.Space != config.Space) {
		stats, err := s.Store.WeChatStatus(ctx)
		if err != nil {
			return nil, status.Error(codes.Internal, "无法检查已有剪藏记录")
		}
		if len(stats.Jobs) > 0 || len(stats.Replies) > 0 {
			return nil, status.Error(codes.FailedPrecondition, "已有处理记录，不能直接更换客服账号、保存用户或空间")
		}
	}
	sealed, err := core.SealConfig(config, s.Secret)
	if err != nil {
		return nil, status.Error(codes.Internal, "无法加密微信客服配置")
	}
	if err = s.Store.SaveWeChatConfiguration(ctx, sealed, state.Revision); err != nil {
		if errors.Is(err, store.ErrWeChatLease) {
			return nil, status.Error(codes.Aborted, "配置已更新，请刷新后重试")
		}
		return nil, status.Error(codes.Internal, "无法保存微信客服配置")
	}
	return s.wechatSetting(ctx, config, state.Revision+1)
}

// GetWechatKfStatus deliberately excludes raw messages, sender IDs and reply bodies.
func (s *APIV1Service) GetWechatKfStatus(ctx context.Context, _ *v1pb.GetWechatKfStatusRequest) (*v1pb.WechatKfStatus, error) {
	if err := s.wechatAdmin(ctx); err != nil {
		return nil, err
	}
	config, _, err := s.wechatConfig(ctx)
	if err != nil {
		return nil, err
	}
	stats, err := s.Store.WeChatStatus(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, "无法读取微信客服处理记录")
	}
	result := &v1pb.WechatKfStatus{Enabled: config.Enabled, ConsumerActive: stats.LeaseUntil > time.Now().Unix(), Jobs: stats.Jobs, Replies: stats.Replies, SyncError: stats.Sync.LastError, NextSyncTime: stats.Sync.NextAt}
	for _, job := range stats.Recent {
		result.RecentResults = append(result.RecentResults, &v1pb.WechatKfResult{Type: core.Label(job.Kind), State: job.State, Attempts: int32(job.Attempts), Error: job.Error, CreatedTime: job.CreatedAt})
	}
	return result, nil
}

// TestWechatKfSetting tests stored account credentials without sending a message.
func (s *APIV1Service) TestWechatKfSetting(ctx context.Context, _ *v1pb.TestWechatKfSettingRequest) (*emptypb.Empty, error) {
	if err := s.wechatAdmin(ctx); err != nil {
		return nil, err
	}
	config, _, err := s.wechatConfig(ctx)
	if err != nil {
		return nil, err
	}
	if err = config.Validate(); err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	client, err := core.NewClient(config.Binding, config.Secret, int64(config.MaxMediaMB)<<20)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "微信客服配置不完整")
	}
	defer client.Close()
	accounts, err := client.Accounts(ctx)
	if err != nil {
		var remote *core.RemoteError
		if errors.As(err, &remote) {
			return nil, status.Error(codes.Unavailable, remote.Error())
		}
		return nil, status.Error(codes.Unavailable, "微信接口请求失败")
	}
	for _, account := range accounts {
		if account["open_kfid"] == config.KFID {
			return &emptypb.Empty{}, nil
		}
	}
	return nil, status.Error(codes.FailedPrecondition, "当前凭据无法访问配置的客服账号")
}
