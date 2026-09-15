# TASK-20260915-release-workflow：统一 CI 与版本 PR 自动化

- 状态：进行中（实现及本地检查完成，等待 GitHub 验证与启用）
- 部署状态：未部署
- 模块与关键词：Fork、BrowserRig、Changesets、Release Please、Version PR、版本号、CI、主分支保护
- 关联任务：[环境初始化](TASK-20260915-local-environment.md)、[仓库展示](TASK-20260915-repository-presentation.md)
- 长期说明：[CI 与版本流程](../release.md)
- 最后更新：2026-09-15

## 背景与目标

用户维护个人 Memos 定制，按需引入上游。希望采用 BrowserRig 的 PR → 持续更新版本 PR → 正式发布流程，同时控制日常 CI 成本。

用户本轮明确要求合并 PR #1，继续实施统一 CI 和版本 PR 自动化，并解释上游配置及调整方式。服务器部署验证继续后置；本轮可以准备版本候选产物，正式镜像发布和部署接入另行实施。

## 已确定的方案

- 保留 fork，所有修改通过自己的 PR 合入 main。
- Changesets 管理单个私有版本元数据包，根目录与前端分别维护依赖，不发布到 npm。
- `0.0.0` 为初始化占位；基线 changeset 生成首个 `0.1.0` 版本 PR。个人标签约定 `castor-v<版本>`，上游仍单独记录官方 `v0.30.0` 及来源提交。
- 每个可发布 PR 添加中文说明及 patch/minor/major 级别；同批按最高级别计算。文档和测试等不改变交付行为的修改无需发版。
- 机器人持续维护 `changeset-release/main`，普通 PR 不手改版本和更新日志，也不能删除 main 中待发布的说明。
- 版本 PR 的文件集合及内容必须与从 main 重新运行 Changesets 的结果一致。
- 所有 PR 都运行 CI，固定必需检查为 `validate`；按变更范围选择重检查，失败、取消、缺少分类及意外跳过均阻止通过。
- main 要求 PR、分支更新到最新 main、`validate` 通过；仅允许 squash，禁止强推/删除，不强制第二人批准。

## 上游配置与调整

以下是本 fork 继承的配置，不代表上游当前所有仓库设置；上游 Secrets 和不可访问的保护设置未读取或推测。

| 继承内容 | 本项目处理 |
| --- | --- |
| 前端 lint/test/build、Go tidy/lint/测试、Buf lint/格式 | 保留为可复用检查，由 CI 统一路由与汇总 |
| PR 工作流级 paths 过滤 | 改为任务级判断，确保文档 PR 和版本 PR 有 validate 结果 |
| Go other 组重复跑 internal、遗漏 scripts | internal 独立覆盖；other 增加 scripts，移除重复项 |
| Codecov 上传 | 移除本 fork 未配置的外部覆盖率上传，测试本身保留 |
| 升级和容器检查 | 保留用于存储、启动和容器相关修改，统一纳入 gate；不访问线上服务器 |
| Release Please 及 v* 标签发布 | 移除旧版本入口，改用 Changesets + 版本 PR 的候选构建 |
| 每次 main 更新构建/推送上游 Canary 镜像 | 停用并移除，普通合并不发布镜像 |
| Render Demo 部署 | 停用并移除 |
| 14 天标记、再过 3 天关闭 Issue/PR | 停用并移除，避免自动关闭个人长期需求及版本 PR |
| 版本日志与上游混用 | 官方日志原样移至 docs/upstream/CHANGELOG.md，根目录记录个人版本 |

公开 API 显示上游当前还存在其他 stable image、Dependabot 和 Copilot 相关工作流；未将它们导入本项目。上游公开 rulesets 查询为空，经典保护查询无权限/返回 404，不能据此断言上游没有保护。

## GitHub 设置与权限

- PR #1 已按用户要求合并，提交 `2bf6e786ed1e3d7a54f17eb7f5906ffcbba9e25d`。
- 合并前在本仓库停用 Canary、Demo、Release Please、Release、Close Stale，避免初始化合并触发旧发布逻辑。
- 仓库默认工作流权限仍为 read，已启用 Actions 创建 PR 的设置；当前无自定义 Secrets。
- 版本任务使用临时 GITHUB_TOKEN，局部授予 contents、pull-requests、actions 写权限。普通 CI 只有 contents read。
- 版本 PR 创建或更新后显式 dispatch 版本分支的 CI，避免依赖令牌派生事件自动运行；首次实际行为待 GitHub 验证。
- 主分支规则模板保存在 `.github/rulesets/main.json`，实际应用及回读结果在后续补充。

## 发布边界

合并受控版本 PR 后，Release Candidate 针对该合并提交检查前端并构建 Linux amd64/arm64 二进制，注入版本和提交号，保存 manifest、校验和与 Actions artifacts。

本阶段不创建正式 GitHub Release/标签、不推容器镜像、不启用服务器更新，也不执行服务器部署验证。数据库迁移目标已确认来自迁移文件序列，保持原有规则；不会随个人应用版本重新编号。

Proto 保留 lint/格式检查；部分生成器未固定版本，自动验证生成一致性留待固定工具版本后处理。

## 验收与验证

- [x] PR #1 已合并，上游自动发布入口在合并前停用。
- [x] 本地测试覆盖文档轻检查、工作流/版本 PR 路由、失败/取消/意外跳过阻断、应用变更缺少说明、普通 PR 手改版本、多个说明合并成一个版本、伪造版本 PR 文件差异。
- [x] Changesets 实际执行：两份 patch/minor 说明汇总为一个 0.1.0，并保留两份说明；无 npm 发布。
- [x] Actionlint 通过，本地版本检查及差异空白检查通过。
- [ ] GitHub 统一 CI 实际通过；主分支规则已应用并回读。
- [ ] 实际机器人版本 PR 正确创建/更新，其 CI 自动运行通过，无重复 PR。
- [ ] 补充 PR、工作流运行链接及最终启用状态。

本轮未改应用源码或 proto 生成文件。实际产物构建需合并版本 PR 才执行；本轮不为验证发布流程而合并首个版本 PR。

## 参考

- [BrowserRig 的版本 PR](https://github.com/Castor6/BrowserRig/blob/main/.github/workflows/version-packages.yml)
- [Changesets Action](https://github.com/changesets/action)
- [GitHub：工作流事件与临时令牌](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub：显式触发工作流](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
