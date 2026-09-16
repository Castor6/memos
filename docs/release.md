# CI 与版本流程

本项目保留 GitHub fork 身份，独立维护版本。日常更新通过 PR 合入 `Castor6/memos:main`，不触发服务器部署。

## 日常修改

1. 在功能分支修改、验证并记录任务。
2. 若改变应用行为，准备一份中文发布说明：在仓库根目录执行 `corepack pnpm install --frozen-lockfile`，然后 `corepack pnpm changeset`。
3. 提交 PR。新增功能选 minor，兼容修复选 patch，破坏兼容性选 major；同一版本取最高升级级别。纯文档、测试和不影响交付行为的 CI 修改无需发布说明。
4. `validate` 通过后合并。版本号和 `CHANGELOG.md` 由机器人统一更新，普通 PR 不手改，也不消耗已经合入 main 的 changeset。

根目录的 Node 包只用于版本管理，与 `web/` 的依赖和锁文件分开；不发布 npm 包。Node 24 / pnpm 11.0.1 与现有前端一致。使用 fnm 的电脑可在命令前加 `fnm exec --using 24`。

## CI 检查

所有 PR 和 main 更新运行 `CI`，也可手动触发。工作流不使用路径过滤跳过整个运行，固定生成 `validate` 结果。

| 检查 | 触发范围 | 内容 |
| --- | --- | --- |
| 基础检查 | 所有 PR | CI/版本规则测试、发布说明及版本归属、部署/备份恢复测试、差异空白与本地开发脚本语法 |
| 前端 | 前端、Proto、工作流修改及版本 PR | 类型、Biome、单元测试、生产构建 |
| 后端 | Go、依赖、Proto、工作流修改及版本 PR | tidy、golangci-lint、store/server/internal/other 测试；store 含三种数据库 |
| Proto | Proto、工作流修改及版本 PR | Buf lint、格式检查 |
| 容器升级 | 存储结构/迁移、服务器入口、Docker/入口脚本及升级工作流修改 | 三驱动升级测试、真实容器的安装/升级、入口脚本检查 |
| 工作流语法 | 工作流文件修改 | 固定版本 Actionlint |

`validate` 检查所有需要执行的任务是否成功，失败、取消、缺少分类或意外跳过都会失败。文档 PR 跳过应用重检查，仍得到完整的合并判断。手动运行普通分支时执行全套检查；版本分支按版本 PR 规则检查。

Proto 目前保留上游的 lint/格式检查。部分远程生成器未固定版本，生成结果一致性检查需先固定生成工具，另行处理；当前不声称自动检查可重现生成。

本地可执行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm check:release origin/main
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -shellcheck=""
python3 -m unittest discover -s scripts/deploy -p 'test_*.py'
python3 -m unittest discover -s scripts -p 'test_publish_image.py'
```

应用检查继续使用 `scripts/dev.sh` 和 `AGENTS.md` 的命令。CI 中容器测试运行于 GitHub 托管 runner，与线上服务器无关。

## 版本 PR

main 的 CI 成功后，`Version Packages` 工作流对仍为当前 main 的提交运行 Changesets；过时的检查结果不会推进版本 PR。可在 main 手动重试此工作流。

- 有待发布 changeset 时，机器人创建或更新同一个 `changeset-release/main` PR，标题为 `Version Packages`。
- PR 汇总中文更新说明、计算版本并删除已消费的 changeset。
- 初始 `0.0.0` 是未发布占位值；首份基线 changeset 生成 `0.1.0`，上游源码基线仍是官方 `v0.30.0`。
- 个人标签约定为 `castor-v<版本号>`，例如 `castor-v0.1.0`，与上游标签区分。数据库迁移序列保持独立。
- CI 从 main 重新运行 Changesets，比较完整文件集合和内容，保证版本 PR 只包含应生成的版本改动。
- 官方历史日志保存在 `docs/upstream/CHANGELOG.md`；根目录 `CHANGELOG.md` 记录个人发行版本。

### 机器人权限与 CI 触发

推荐在 GitHub 创建仅授权 `Castor6/memos` 的细粒度 Token，Contents 和 Pull requests 设为 Read and write，在仓库 Settings → Secrets and variables → Actions 中保存为 `CHANGESETS_TOKEN`。它用于维护版本分支和 PR，不需要服务器权限；令牌只保存在 GitHub Secrets，不写入代码或聊天。

配置后，版本 PR 的创建和更新事件正常触发 CI，与 BrowserRig 一致。按仓库所有者选择，当前 `memos-changesets` 令牌设为不过期；需要轮换时在 GitHub 重新生成并同步更新 `CHANGESETS_TOKEN`。版本 PR 可能显示仓库所有者为创建者。

未配置时仍可使用 GitHub 临时 `GITHUB_TOKEN` 自动维护版本 PR，但 GitHub 会要求有写权限的人批准其工作流。实际验证发现：额外 dispatch 的 CI 即使成功，也没有进入该 PR 的必需检查汇总，因此不能把它当作自动门禁的替代；已移除这条重复运行路径。

仓库默认工作流权限保持只读，并允许 Actions 创建 PR；仅版本任务声明 contents/PR 写权限，普通 CI 只有代码读取权限。配置状态与实际验证见本次任务记录。

## 合并版本 PR 后

`Publish Release` 从可信版本 PR 的确定合并提交重新核对 Changesets 生成结果，构建 Linux amd64/arm64 二进制和 Linux amd64 容器。新安装、登录、持久化与上一版升级冒烟测试全部通过后，才推送 ACR 镜像并推进 `stable`。服务器定时检查该通道；普通 PR 合并不会触发发布。

镜像标签为 `castor-v<版本>`、`sha-<完整提交>` 和 `stable`。服务器使用不可变摘要运行镜像。版本标签存在时，重试必须复用对应提交的镜像，不能重新构建覆盖；认证或网络错误不能当作标签不存在。重试旧版本不能把 `stable` 降级。首版升级测试从官方 `ghcr.io/usememos/memos:0.30.0` 开始，后续从上一版个人镜像开始。

仓库变量 `ACR_REGISTRY`、`ACR_IMAGE` 指定发布目标；Secrets `ACR_USERNAME`、`ACR_PASSWORD` 保存发布凭据。GitHub 不持有服务器 SSH 密钥。工作流也支持在 main 手动输入已经合并的版本 PR 编号重试，会重新验证 PR 来源和完整版本差异。二进制、校验和、镜像摘要记录保留在 Actions artifacts 30 天；这与令牌有效期无关。当前不创建 GitHub Release 或 Git 标签。

部署脚本与安装、恢复步骤见 [自动部署说明](deployment.md)。实际上线状态和验证证据见 [自动部署任务](tasks/TASK-20260916-automated-deployment.md)。

继承的 Release Please、标签发布、Canary、Demo 和自动关闭旧 Issue/PR 工作流已移除。源码、GitHub 设置和实际验证状态见 [本次任务](tasks/TASK-20260915-release-workflow.md)。

## 上游引入

上游修复和功能同样通过 PR，引入后写明来源提交与自己的发布说明。审查工作流和发布元数据冲突，保留本项目的 CI、版本号与发布目标。

上游最新的仓库配置与本 fork 起点可能不同。这里只读核查公开工作流和可访问的规则；上游 Secrets、组织策略和不可访问的保护设置不应推测。
