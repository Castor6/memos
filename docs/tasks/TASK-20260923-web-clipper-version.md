# TASK-20260923-web-clipper-version：扩展独立版本

- 记录日期：2026-09-23
- 模块与关键词：浏览器扩展、Changesets、版本、Release ZIP
- 维护归属：`feat/web-clipper-independent-version`
- 关联任务：[扩展集成](TASK-20260922-web-clipper-compatibility.md)

## 背景与目标

扩展版本原本跟随 Memos，每次应用发布都会变化。用户要求扩展仅在自身交付内容变化时递增，使用与项目一致的 patch/minor/major 规则。

## 验收标准

- [x] Changesets 分别维护应用与扩展版本，应用单独更新不递增扩展。
- [x] 扩展交付变更要求扩展发布说明，普通 PR 不允许手改发布版本或日志。
- [x] 本地 manifest、Release ZIP、候选清单和发布校验使用独立扩展版本。
- [x] 保留独立依赖和现有统一 Release 流程，覆盖历史发布重试。

## 讨论结论

- 独立版本从当前个人发行版本 0.8.2 衔接；上游源码基线 0.4.1 保留。
- 扩展仍随 Memos Release 交付；扩展 changeset 同时包含应用发布说明以触发现有统一发布流程。仅 Memos 更新时，扩展版本不变。
- 根 workspace 只管理两个私有版本包，Web 和扩展的依赖、锁文件、pnpm 版本保持独立。

## 实现结果

- 新增轻量私有版本包 `extensions/web-clipper/release/package.json`，根 Changesets workspace 同时管理应用和扩展；保留扩展源码包的上游基线。
- 本地 manifest、个人 ZIP 及原有商店打包命令统一读取独立扩展版本，候选清单和公开前验证允许两种版本不同，并继续核对同次发布的标签与提交。
- 扩展交付变更必须提供自身 changeset；普通 PR 不能改扩展版本或日志。精确再生成检查补充新建 CHANGELOG 的未跟踪文件集合，防止首次发布漏检。
- 更新发布文档和维护规则，通过根 `corepack pnpm changeset` 生成双方 patch 说明；正式版本由后续版本 PR 生成。

## 验证事实与边界

2026-09-23，在 `39a87f80` 基线上验证：

- 根 `corepack pnpm install --frozen-lockfile` 与 `corepack pnpm test` 通过（11 项），覆盖应用单独升级、扩展 minor/patch 聚合、版本归属与日志篡改拒绝。
- 扩展独立 frozen install、lint、426 项单测、类型检查、语言表检查和生产构建通过。使用 `.env.example` 的公开配置；本机全局 pnpm 与 Corepack 混用时子进程版本不符，临时 PATH 使用 Corepack shim 后通过，未修改项目工具链版本。
- `python3 -m unittest discover -s extensions/web-clipper/scripts -p 'test_package*.py'`：24 项，23 通过、1 跳过。大小写碰撞夹具在本机不区分大小写的文件系统无法成立，改用实际 samefile 检测跳过；Linux CI 保留执行。
- `python3 -m unittest discover -s scripts -p 'test_publish*.py'`：22 项通过，覆盖独立版本 ZIP 身份与历史候选清单路径。
- Actionlint v1.7.12（`-shellcheck=""`）、`corepack pnpm check:release origin/main` 与完整 PR 差异空白检查通过。
- 干净检出上实际执行个人 `package-release.py` 和原有 `package.mjs chrome`，两种 ZIP 均成功生成并回读确认 manifest 为独立元数据版本 0.8.2；尚未消费的 patch changeset 由版本 PR 递增。

## 未覆盖范围与后续建议

本轮没有发布正式版本、上传商店、部署服务器或重新加载用户浏览器扩展。真实 ACR/GitHub Release 上传及历史发布重试需由后续发布运行确认，本轮验证到脚本与夹具。
