# TASK-20260923-clipper-connection-startup：修复扩展后台启动失败和连接转圈

- 记录日期：2026-09-23
- 模块与关键词：Web Clipper、Service Worker、Markdown、连接状态
- 维护归属：本次排查会话，工作分支 `fix/clipper-connection-startup`
- 关联任务：[扩展兼容与功能实现](TASK-20260922-web-clipper-compatibility.md)、[扩展独立版本](TASK-20260923-web-clipper-version.md)

## 背景与目标

用户安装扩展 0.1.0 后，设置页一直显示“正在检查连接…”，Memos 网页可以正常使用。Chrome 扩展管理页报告 `Service worker registration failed. Status code: 15` 和 `Uncaught ReferenceError: document is not defined`。主目录已切换 main 并快进拉取至 `c439afc4`；修复使用独立 worktree。

## 验收标准

- [x] 确认生产构建的后台启动失败原因，并用不提供 DOM 的环境复现。
- [x] 修复生产构建，使后台能启动并返回连接状态。
- [x] 后台无响应时设置页停止等待，显示错误并允许重试。
- [x] 扩展 lint、单测、构建和打包检查通过，记录实际验证与未覆盖范围。

## 讨论结论

后台图片归档引入 `mdast-util-from-markdown`，其间接依赖 `decode-named-character-reference` 被 Vite 按 browser 条件解析到 `index.dom.js`。该模块顶层执行 `document.createElement`；Service Worker 没有 document，导致消息处理器注册前即启动失败。用户提供的实际报错代码与本地已有 dist 中的顶层调用一致。

源码单测在 Node 环境解析到无 DOM 的默认导出，在 jsdom 环境又具备 document，两种测试都不能发现生产构建中错误选择 browser 导出的情况。需要直接加载生产产物的启动检查。

## 实现结果

- Vite 增加 worker 条件，保留默认客户端条件，使后台和页面共享的 Markdown 模块使用兼容 Worker 的依赖导出；不新增依赖或修改锁文件。
- 新增 `scripts/check-worker.mjs`，在无 window/document、禁止真实网络的独立 Node 进程中加载 manifest 指向的实际后台产物，检查处理器注册、连接状态、账号及弹窗状态响应。`build` 自动执行，现有 CI 和打包入口随构建覆盖此检查。
- 连接检查最多等待 30 秒；超时或空响应显示扩展错误，清理计时器，忽略过期返回。设置页提供错误说明、重新检查和直接连接入口。
- 增加超时、重试、迟到响应、空响应、计时器清理及错误页面操作回归测试。
- Changeset 仅为 `memos-web-clipper` 添加 patch 说明；不改版本号、应用、认证、令牌或发布工作流。

## 验证事实与边界

2026-09-23，基线 `c439afc4`：

- 对原 dist 执行新增启动检查，实际失败为 `ReferenceError: document is not defined`，位置为后台导入的共享模块 `dist-DOgLLz7o.js`。
- 对修复后 dist 执行同一检查成功，连接状态返回 disconnected，账号返回 null，弹窗返回 signed-out；使用一次性内存 API，未连接用户 Memos 或读取浏览器凭据。
- Node 24.21.0 / 扩展 pnpm 11.10.0：lint 检查 128 个文件通过；37 个测试文件、430 项测试通过；类型、223 条 × 9 语言表与 Vite 生产构建通过。
- Python 打包测试 24 项，23 通过，1 项按平台条件跳过；根 CI/版本规则测试 13 项通过。
- 干净检出执行 `corepack pnpm package:release` 生成 Chromium ZIP；解压实际 ZIP 后再次运行后台启动检查通过。发布说明归属检查、工作区/暂存区/完整分支差异空白检查通过。
- 首次 worktree 构建受本机全局 pnpm 12 与项目 pnpm 11 冲突阻断；仅在忽略的本地工具目录准备 Corepack shim 并选择 Node 24 后重跑通过，没有修改依赖或全局版本。
- 浏览器工具的 URL 安全策略拒绝读取扩展页面，未绕过限制或操作用户连接数据。

## 未覆盖范围与后续建议

未验证用户已安装副本更新后的 Chrome 实际连接、权限和剪藏；无 DOM 的产物启动检查不等同于真实浏览器全流程。此次未操作服务器或部署。用户需手动替换扩展文件并在扩展管理页重新加载，正式版本仍由已有版本 PR 流程生成。
