# TASK-20260915-repository-presentation：启用 Issues 与清理上游赞助展示

- 模块与关键词：Fork、Issues、README、赞助、FUNDING、问题模板
- 关联任务：[发布基础设施讨论](TASK-20260915-release-workflow.md)、[环境初始化](TASK-20260915-local-environment.md)
- 交付：[PR #1](https://github.com/Castor6/memos/pull/1)，分支 `chore/personal-fork-foundation`，已合并（`2bf6e786`）
- 记录日期：2026-09-15（历史事实，不表示实时进度）

## 背景与目标

用户看到 fork 没有 Issues 入口，并不喜欢 README 中继承的赞助展示。核查并启用本仓库的问题入口，清理赞助展示，保留上游来源和许可证说明。

## 验收标准

- [x] GitHub 仓库设置确认 Issues 已启用。
- [x] README 移除置顶赞助、Sponsors 章节和捐赠链接；移除本仓库 FUNDING 配置。
- [x] README 的问题与 PR 入口指向 Castor6/memos，表单文件名与实际文件一致。
- [x] 问题模板不再将本 fork 的问题导向上游，允许空白 Issue 记录讨论。
- [x] 保留上游来源、许可证和参考文档；注明现有安装命令安装的是上游版本。
- [x] 文件变更通过分支和 PR 交付，不直接推送 main。

## 讨论结论

- 当前没有 Issues 是仓库功能开关关闭，fork 可以独立启用 Issues。
- README 与 `.github/FUNDING.yml` 来自上游，可以按个人仓库的定位调整，无需脱离 fork。
- Issues 可作为问题入口；详细讨论结论和验证结果仍按已有任务约定沉淀，存在关联 Issue 时记录链接，无需为每段对话重复创建 Issue。

## 实现结果

- 使用 `gh repo edit Castor6/memos --enable-issues` 启用 Issues。
- README 清理赞助内容，明确个人 fork 的反馈入口和上游安装来源。
- 删除 `.github/FUNDING.yml`，清理上游赞助按钮配置。
- 调整问题模板中的仓库链接、复现版本要求和提问入口；允许空白 Issue。
- 与已完成的协作文档、本地开发工具初始化一起整理为基础设施 PR。版本工具、发布工作流和服务器部署仍按关联任务另行推进。

## 验证结果

2026-09-15：通过 GitHub API 回读 `hasIssuesEnabled: true`；检查文档差异、相对链接和三个问题模板的 YAML 语法。
本轮未修改应用代码；沿用环境初始化任务中已完成的前后端检查，未重复执行全量测试。

Issues 开关立即生效；README、赞助按钮配置和模板需 PR 合并后才体现在默认分支。PR #1 已创建，当前继承的 CI 路径过滤未为这批文档/本地工具改动产生检查；上述结果来自本地验证，统一必需 CI 仍待发布基础设施任务实施。未创建测试 Issue，也未执行发布或部署。

## 参考

- [GitHub：fork 的独立功能](https://docs.github.com/en/pull-requests/reference/forks)
- [GitHub：Issues 功能开关](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/disabling-issues)
