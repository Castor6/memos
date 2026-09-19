# TASK-20260917-pre-commit-whitespace：提交前空白检查

- 模块与关键词：Git、提交钩子、空白、CI、开发环境
- 记录日期：2026-09-17（历史事实，不表示实时进度）

## 背景与目标

PR #18 在最终追加任务记录后出现文件末尾多余空行，导致 CI 的 `git diff --check` 失败。用户要求把检查提前并固化到新会话流程。

## 验收标准

- [x] 提交前检查暂存内容，拦截多余空行及行尾空白，不自动修改工作区或暂存区。
- [x] 正常提交可通过，部分暂存时不能用工作区的修正掩盖暂存区错误。
- [x] 安装可重复执行，保留已有自定义钩子；本机启用，开发 setup 自动安装。
- [x] 仓库说明要求新会话在最终更新任务记录后检查暂存区和完整 PR 差异。

## 实现结果

新增版本管理的 pre-commit 与独立安装脚本，开发 setup 自动安装。钩子复制到本机共享 hooks 目录，已在本机启用。新增 `.editorconfig`，Markdown 保留有语义的行尾双空格；AGENTS.md 和开发文档固化最终暂存检查及推送前完整 PR 差异检查。开发工具改动不改变应用交付行为，不新增 Changeset。

## 验证结果

2026-09-17：临时 Git 仓库实际提交验证通过，覆盖正常提交、末尾空行、行尾空白、工作区修正但暂存区仍错误、工作区及暂存区保持不变、重复安装、自定义钩子与 core.hooksPath 保护。

- `bash -n scripts/install-git-hooks.sh`、`sh -n .githooks/pre-commit`、Python AST 语法检查通过。
- 根目录 `corepack pnpm test`：7 项通过；`corepack pnpm check:release origin/main` 通过（Node 24）。
- 本机 `./scripts/install-git-hooks.sh` 成功；最终暂存空白与完整分支差异在提交/推送前检查。
- 未运行完整开发 setup（会重新安装应用依赖）；其新增安装步骤已独立验证。无应用或部署改动。
