# TASK-20260915-release-workflow：PR、版本发布与 CI 基础设施约定

- 状态：待讨论（需求已记录，方案尚未实施）
- 部署状态：未部署
- 模块与关键词：Fork、BrowserRig、Changesets、Release Please、Version PR、版本号、CI、主分支保护
- 关联任务：[本地环境初始化](TASK-20260915-local-environment.md)、[定制与部署记录](../customization-and-deployment.zh-CN.md)
- 参考项目：[Castor6/BrowserRig](https://github.com/Castor6/BrowserRig)
- 最后更新：2026-09-15

## 背景与目标

以个人定制为主，按需吸收 Memos 上游修复和功能。用户希望采用 BrowserRig 的工作方式：日常更新提 PR，机器人持续维护一个版本 PR，合并版本 PR 后按规则发布新版本并最终触发部署，配备必要的 CI 检查。

本阶段先建立基础设施约定，部署流程暂不验证；同时讨论保留 GitHub fork 身份是否会限制独立维护。

## 已明确的要求

- 日常修改通过 PR 合入自己的 `main`，包括文档、基础设施及上游引入。
- 可发布改动汇总到一个持续更新的版本 PR；合并它才进入正式发布流程。
- 版本号有明确规则，版本 PR 能展示本次发布的变化。
- CI 作为合并前的必要检查；部署流程验证留到后续阶段。
- 历史按任务索引检索，记录区分建议、已实施、已验证和已部署。

## 现状核查

2026-09-15 通过本地代码及 GitHub 只读 API 核查：

| 项目 | BrowserRig | 当前 Memos |
| --- | --- | --- |
| GitHub 仓库身份 | 独立公开仓库 | `usememos/memos` 的公开 fork |
| 版本 PR | Changesets 汇总每个 PR 的发布说明和升级级别 | 已有 Release Please YAML，按提交信息计算版本；尚未验证本 fork 的运行链路 |
| 正式发布 | 合并本仓库 `changeset-release/main` PR 后，从合并提交构建发布候选，再执行 npm/扩展发布 | 继承的 Release 工作流由 `v*.*.*` 标签或手动事件触发 |
| 主分支保护 | 活跃规则集要求 PR 和 `validate`，不强制另一位成员批准 | 无规则集，经典分支保护也未配置 |
| 检查 | `validate` 及发布说明/版本变更检查 | 已有前端、Go、Proto 和升级检查，触发与汇总方式待整理 |
| 镜像及部署 | 发布目标与 BrowserRig 产品对应 | 仍有上游镜像名、每次 main push 的 Canary 和 Demo 部署工作流 |

Memos Actions 已启用，相关工作流处于 active 状态；本次查询未返回运行记录，不能据此认定现有 CI 或发布可用。Release 与 Canary 中的镜像目标仍包含 `neosmemo/memos`、`ghcr.io/usememos/memos`，需在启用个人发布前调整。

BrowserRig 的 GitHub Release 还有后续完成流程；这里借鉴的是其版本 PR 和确定提交的发布方式，不照搬 npm、扩展商店或 GitHub Release 的全部实现。

## 建议方案（待确定）

### 仓库身份与上游

建议先保留 fork 身份，采用自己的版本、CI、镜像和发布节奏。所需的 PR、版本 PR、Actions 和主分支保护不要求先脱离 fork。

上游更新也通过专门 PR 引入，记录来源提交、选择原因和兼容性检查。引入上游版本时审查工作流、版本元数据及个人定制冲突，避免覆盖本项目的发布约定。

公开 fork 不能单独改成私有。若以后需要独立产品身份或不同的可见性，再评估独立仓库；Git 的 `upstream` 远程和源码历史仍可用于引入更新。GitHub 当前的脱离 fork 文档说明，该操作不可撤销，并不保留 issues、PR 等仓库元数据，因此本次不执行身份迁移。

### 版本工具与规则

建议采用 Changesets，与 BrowserRig 保持一致：功能 PR 只提交相对升级级别和面向使用者的说明；机器人在版本 PR 中计算具体版本号、汇总更新日志。上游引入 PR 同样明确本次个人版本的发布影响。

保留现有 Release Please 也能实现持续更新版本 PR，改动更少，但版本决策主要依赖提交规范。两种工具只保留一个负责版本，不同时运行两套自动版本流程。最终选型尚未确定。

建议版本命名示例：

| 信息 | 示例 | 含义 |
| --- | --- | --- |
| 个人应用版本 | `0.1.0` | 独立递增，不随上游版本跳号 |
| 发布标签 / 镜像版本标签 | `castor-v0.1.0` | 与上游 `v0.30.0` 等标签区分 |
| 上游来源 | `v0.30.0` 及提交 SHA，另列后续引入提交 | 追溯源码来源，不参与个人版本号计算 |
| 数据库 schema 版本 | 沿用迁移文件序列 | 独立于个人应用版本，不因重设应用版本而重编号 |

起始版本和前缀仍待确定。建议 patch 用于兼容修复，minor 用于兼容功能，major 用于破坏兼容性的变化；纯文档、测试和不影响交付行为的 CI 改动不产生发布。一次发布汇总多个改动，按所需的最高升级级别计算，不按 PR 数量连续加号。

已检查 `store/migrator.go`：迁移目标取自数据库迁移文件的最新 schema 版本，当前实现没有用应用显示版本决定迁移目标。个人版本工具不应改写数据库迁移序列。

### CI 与合并入口

- 所有 PR 都产生一个稳定的必需检查 `validate`，按变更范围运行重检查；文档 PR 和机器人版本 PR 也能得到明确结果。
- 前端：类型、Biome、单元测试、生产构建。
- Go：格式/依赖一致性、lint、相关测试；存储改动包含 SQLite/MySQL/PostgreSQL 检查，保持已有验证要求。
- Proto：lint、格式及生成结果一致性；影响接口时覆盖前后端相关检查。
- 基础设施：检查开发脚本、工作流语法、发布说明和版本变更范围；发布候选需要能正常构建。
- `validate` 必须汇总依赖任务的真实失败和取消状态，不能把需要执行但未成功的检查当作通过。避免工作流级路径过滤让必需检查一直处于 Pending。
- 主分支规则要求 PR、`validate` 通过，禁止强推和删除；个人项目无需强制另一位成员批准。

### 发布与后续部署衔接

目标流程：修改 PR → CI → 合入 main → 更新同一个版本 PR → 合并版本 PR → 检查并构建该提交 → 发布带版本的产物 → 后续接入服务器更新。

- 发布识别本仓库受控的版本 PR，不能仅凭标题认定；版本、提交 SHA、构建产物之间可追溯。
- 为版本机器人配置限定到本仓库的凭据，并验证它创建/更新 PR 后能够自动触发 CI。BrowserRig 的凭据仅作为模式参考，不读取或复用其秘密值。
- 将继承的 Release Please、Release、Canary、Demo 工作流一并审查，替换或移除重复/不适用的触发入口。
- 版本 PR 合并后发布同一份验证过的产物；构建或发布失败时，不推进部署通道。
- 本阶段不启用服务器更新，也不将合并版本 PR 视为已完成部署验证。后续再连接镜像仓库与既有服务器主动拉取方案。

## 验收标准

- [x] 记录用户要求、现状、建议方案和本阶段边界。
- [ ] 确定版本工具、起始版本及标签前缀。
- [ ] 普通 PR 获得必需 CI 结果，失败时不能合入 main，文档 PR 不被挂起的检查阻塞。
- [ ] 连续合并两个可发布 PR 时，同一个版本 PR 正确汇总更新说明和升级级别；不修改正式版本元数据的普通 PR 可正常通过检查。
- [ ] 版本 PR 自身接受检查；其发布入口固定到合并提交，且不会调用上游镜像或 Demo 部署目标。
- [ ] 无发布权限的 CI 和版本计算可先验证；需要实际发布权限的部分单独记录，服务器部署验证留待后续。

## 实现与验证结果

本轮仅更新协作/分支约定、部署方案入口和这份讨论记录。尚未修改工作流、安装版本工具、配置 GitHub 规则集或凭据，也未触发发布或部署。

已通过只读 API 对照两个仓库的工作流与规则集，并阅读本地版本配置和迁移实现。文档检查使用 `git diff --check`，新增文件另查行尾空格与本地链接。自动版本 PR、云端 CI 和发布行为尚未验证。

## 参考

- [BrowserRig：PR 与发布说明约定](https://github.com/Castor6/BrowserRig/blob/main/CONTRIBUTING.md)
- [BrowserRig：持续更新版本 PR](https://github.com/Castor6/BrowserRig/blob/main/.github/workflows/version-packages.yml)
- [BrowserRig：版本 PR 合并后的发布入口](https://github.com/Castor6/BrowserRig/blob/main/.github/workflows/release.yml)
- [Changesets Action](https://github.com/changesets/action)
- [Release Please Action](https://github.com/googleapis/release-please-action)
- [GitHub：必需检查与路径过滤](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
- [GitHub：工作流之间的触发与凭据](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub：fork 的独立设置与可见性限制](https://docs.github.com/en/pull-requests/reference/forks)
- [GitHub：脱离 fork 网络的条件和影响](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork)
