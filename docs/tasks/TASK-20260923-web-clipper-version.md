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
- [x] 保留独立依赖与同一 Version PR，覆盖历史发布重试。

- [x] 仅扩展版本 PR 不更新根版本/日志，CI 与发布不进入 Memos 构建、镜像冒烟、ACR 或 stable 流程。
- [x] 独立扩展 Release 支持同提交重试、校验和核验且不抢占 Memos Latest；保留历史版本重试。

## 讨论结论

- 用户选择首个独立正式版为 0.1.0，替代最初提出的 0.8.2 衔接方案；上游源码基线 0.4.1 保留。初始 0.0.1 是未发布构建占位值，以满足 Chromium 禁止全零版本的要求；首份 minor changeset 生成 0.1.0。
- 2026-09-23 用户追加确认：保留同一个 Version PR，按实际版本变化分别发布。仅扩展变化只发布扩展 ZIP，不升级 Memos、不运行镜像发布；扩展使用 `web-clipper-v<版本>` 独立 Release。此决定替代此前的配套发行方案。
- 根 workspace 只管理两个私有版本包，Web 和扩展的依赖、锁文件、pnpm 版本保持独立。

## 实现结果

- 新增轻量私有版本包 `extensions/web-clipper/release/package.json`，根 Changesets workspace 同时管理应用和扩展；保留扩展源码包的上游基线。
- 本地 manifest、个人 ZIP 及原有商店打包命令统一读取独立扩展版本，Memos 与扩展分别使用自身标签、候选清单及公开前身份校验。
- 扩展交付变更必须提供自身 changeset；普通 PR 不能改扩展版本或日志。精确再生成检查补充新建 CHANGELOG 的未跟踪文件集合，防止首次发布漏检。
- 更新发布文档和维护规则，通过根 `corepack pnpm changeset` 生成扩展 minor 说明（追加需求后移除应用 patch）；正式版本由后续版本 PR 生成。

## 验证事实与边界

2026-09-23，在 `39a87f80` 基线上验证：

- 根 `corepack pnpm install --frozen-lockfile` 与 `corepack pnpm test` 通过（11 项），覆盖应用单独升级、扩展 minor/patch 聚合、版本归属与日志篡改拒绝。
- 扩展独立 frozen install、lint、426 项单测、类型检查、语言表检查和生产构建通过。使用 `.env.example` 的公开配置；本机全局 pnpm 与 Corepack 混用时子进程版本不符，临时 PATH 使用 Corepack shim 后通过，未修改项目工具链版本。
- `python3 -m unittest discover -s extensions/web-clipper/scripts -p 'test_package*.py'`：24 项，23 通过、1 跳过。大小写碰撞夹具在本机不区分大小写的文件系统无法成立，改用实际 samefile 检测跳过；Linux CI 保留执行。
- `python3 -m unittest discover -s scripts -p 'test_publish*.py'`：22 项通过，覆盖独立版本 ZIP 身份与历史候选清单路径。
- Actionlint v1.7.12（`-shellcheck=""`）、`corepack pnpm check:release origin/main` 与完整 PR 差异空白检查通过。
- 干净检出上实际执行个人 `package-release.py` 和原有 `package.mjs chrome`，初次两种 ZIP 均成功生成并回读确认版本来源一致；用户随后选择 0.1.0 起点，对应重新验证记录如下。

2026-09-23 起点确认后补充：用户选择首个独立正式版 0.1.0；已重新运行根版本测试，确认应用独立升级保留 0.0.1 构建占位值、扩展 minor 发布生成 0.1.0，精确再生成校验通过；扩展 lint、类型与生产构建再次通过。

## 2026-09-23：发布流程拆分

- 用户确认同一个 Version PR 分别生成 Memos / 扩展 Release；扩展首版仍为 0.1.0。仅扩展更新只消费扩展 changeset，不改根版本或根日志。
- 发布公共阶段先核对可信 PR 与精确 Changesets 结果，再按相邻提交的版本变化路由。Memos job 才可访问 ACR 凭据并运行主站构建、二进制、镜像冒烟及 stable 更新；扩展候选和发布 job 独立，不依赖镜像 job。
- 扩展使用 `web-clipper-v<版本>`、专属日志与清单，公开前校验 ZIP 身份、提交与所有附件摘要。复用原有草稿上传、回读、冲突拒绝和重试机制；扩展永不设为 Latest。
- CI 识别扩展单独版本 PR 及其合并后的 main push，仅运行必要的扩展检查。Memos/扩展源码变化分别要求所属组件的发布说明。
- 新增模拟仓库测试：Memos 单独升级、扩展单独升级、同时升级、旧捆绑发布和更早无扩展发布。覆盖不同组件任务隔离、版本再生成、发布说明归属、无镜像的扩展发布、Latest、失败重试和冲突拒绝。
- 实际验证：根测试 13 项、发布脚本测试 29 项通过；打包测试 23 项通过、1 项因本机文件系统大小写规则跳过；Actionlint 通过。扩展完整检查与实际版本生成打包结果在收尾补充。

## 未覆盖范围与后续建议

本轮没有发布正式版本、上传商店、部署服务器或重新加载用户浏览器扩展。真实 ACR/GitHub Release 上传及历史发布重试需由后续发布运行确认，本轮验证到脚本与夹具。
