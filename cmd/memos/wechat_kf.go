package main

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/pkg/errors"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/usememos/memos/internal/profile"
	"github.com/usememos/memos/internal/version"
	core "github.com/usememos/memos/internal/wechatkf"
	"github.com/usememos/memos/internal/wechatkf/legacy"
	"github.com/usememos/memos/store"
	"github.com/usememos/memos/store/db"
)

func init() {
	var source, env, owner string
	command := &cobra.Command{Use: "import-wechat-kf", Short: "Import a stopped legacy WeChat KF service into disabled Memos settings", RunE: func(cmd *cobra.Command, _ []string) error {
		if source == "" || env == "" || owner == "" {
			return errors.New("必须提供 --state、--env 和 --owner")
		}
		ctx := context.Background()
		config, err := legacy.Configuration(env)
		if err != nil {
			return err
		}
		snapshot, err := legacy.Read(ctx, source, config.KFID)
		if err != nil {
			return err
		}
		p := &profile.Profile{Data: viper.GetString("data"), Driver: viper.GetString("driver"), DSN: viper.GetString("dsn"), Version: version.GetCurrentVersion()}
		if p.Data == "" {
			return errors.New("必须明确指定目标 --data 目录")
		}
		if err = p.Validate(); err != nil {
			return errors.New("Memos 数据库配置无效")
		}
		driver, err := db.NewDBDriver(p)
		if err != nil {
			return errors.New("无法打开 Memos 数据库")
		}
		s := store.New(driver, p)
		defer s.Close()
		if err = s.Migrate(ctx); err != nil {
			return errors.New("无法迁移 Memos 数据库")
		}
		owner = strings.TrimPrefix(owner, "users/")
		user, err := s.GetUser(ctx, &store.FindUser{Username: &owner})
		if err != nil || user == nil || user.RowStatus != store.Normal {
			return errors.New("Memos 绑定用户不存在或已停用")
		}
		config.OwnerID = user.ID
		config.Enabled = false
		if err = config.Validate(); err != nil {
			return err
		}
		basic, err := s.GetInstanceBasicSetting(ctx)
		if err != nil || basic.SecretKey == "" {
			return errors.New("Memos 实例尚未初始化")
		}
		state, err := s.WeChatConfiguration(ctx)
		if err != nil {
			return errors.New("无法读取迁移目标")
		}
		if state.Value != "" {
			previous, err := core.OpenConfig(state.Value, basic.SecretKey)
			if err != nil {
				return errors.New("无法解密迁移目标配置")
			}
			if previous.Enabled {
				return errors.New("请先关闭 Memos 内置微信客服，再执行导入")
			}
			if previous.OwnerID != config.OwnerID || previous.CorpID != config.CorpID || previous.KFID != config.KFID || previous.Space != "" {
				return errors.New("旧服务与 Memos 绑定不一致")
			}
			config = previous
		}
		sealed, err := core.SealConfig(config, basic.SecretKey)
		if err != nil {
			return errors.New("无法加密迁移配置")
		}
		counts, err := s.ImportWeChatState(ctx, snapshot, sealed, state.Revision)
		if err != nil {
			return errors.New("状态导入失败：检查配置版本、运行中的消费者或源状态")
		}
		// Output only counts; never print config, IDs, cursors, message or reply content.
		return json.NewEncoder(cmd.OutOrStdout()).Encode(counts)
	}}
	command.Flags().StringVar(&source, "state", "", "read-only legacy state.db snapshot")
	command.Flags().StringVar(&env, "env", "", "private legacy service.env path")
	command.Flags().StringVar(&owner, "owner", "", "destination Memos username")
	rootCmd.AddCommand(command)
}
