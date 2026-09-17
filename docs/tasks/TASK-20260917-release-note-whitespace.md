# TASK-20260917-release-note-whitespace：修复多段发布说明阻塞

- 状态：已实现，本地验证通过，待 CI
- 部署状态：未部署；由发布任务负责合并及服务器验证
- 模块与关键词：Changesets、CHANGELOG、版本 PR、空白检查、发布生成器
- 关联任务：[版本流程](TASK-20260915-release-workflow.md)、[笔记功能](TASK-20260916-notes-requirements.md)
- 最后更新：2026-09-17

## 背景与目标

PR #8 合并后，版本 PR #9 的 0.2.0 发布说明包含两个段落。Changesets 默认生成器在段落之间输出两个空格，CI 的 `git diff --check` 拒绝通过。精确再生成校验通过，说明问题来自生成器，不能只手改版本 PR 的 CHANGELOG。

负责发布的任务已获得用户授权，委托本任务在独立修复 PR 中处理并创建 ready PR。合并及生产部署仍由该任务负责。

## 验收标准

- [x] 保留已有发布说明内容与版本计算规则，生成日志没有纯空白行缩进。
- [x] 真实 Changesets CLI 支持多段、嵌套列表和代码缩进，生成结果通过差异空白检查。
- [x] 版本 PR 精确再生成校验保持启用，篡改生成内容仍被拒绝。
- [x] 更新陈旧的版本 PR 部署描述，不修改发布条件、权限或生产服务器。
- [ ] 根目录测试、版本规则、Actionlint 和必要 CI 通过；提交 ready PR 供发布任务合并。

## 实施决策

新增轻量本地 changelog 生成器，委托 Changesets 自带生成器生成内容，只清除输出中纯空白行的缩进。保留原多段 changeset，不放宽现有发布说明所有权规则，不手改版本号或 CHANGELOG，不添加依赖。

## 验证结果

根目录 `corepack pnpm test` 的 7 项测试、`corepack pnpm check:release origin/main`、Actionlint 和 `git diff --check` 通过。新增测试使用真实 Changesets CLI，确认多段说明不产生尾随空白，嵌套列表和代码缩进保留，精确再生成通过，篡改日志仍被拒绝。

另外在一次性 worktree 中使用 main 的真实待发布说明生成 0.2.0，确认只变更 package.json、CHANGELOG.md 与消费 changeset；差异空白检查和版本精确再生成校验均通过。临时验证提交和目录已清理，没有改动实际版本 PR 或生产数据。
