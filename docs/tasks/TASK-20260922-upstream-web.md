# TASK-20260922-upstream-web：上游前端修复、搜索与多窗口同步

- 记录日期：2026-09-22
- 模块与关键词：Markdown、共享附件、时间编辑、搜索、SSE
- 维护归属：分支 `feat/upstream-web`
- 关联任务：[v0.31 评估](TASK-20260922-upstream-v031-review.md)

## 背景与目标

按已选择范围适配上游分享附件、编号任务、时间弹窗、电话短信链接、金额识别、正文搜索高亮和多窗口 SSE；保持本地 Tiptap、独立标签、个人空间与手机导航。

## 验收标准

- [x] 分享附件保留授权参数，数字任务可以勾选，关闭时间弹窗不丢合法更改。
- [x] 电话短信链接可用且危险协议仍过滤，货币保持文字而有效公式保留。
- [x] 搜索高亮兼容已有 Markdown 渲染，清空搜索及卸载后移除。
- [x] 同账号窗口共享 SSE 并正确切换连接；不同账号隔离，服务端慢客户端断开重同步。
- [x] 前端 lint、单元测试、构建与 SSE 后端目标测试通过；完整 race 检查的本机限制见下文。

## 实现结果

- 2026-09-22：择取上游 `3f567fda` 分享授权参数、`fa5e55df` 数字任务、`0716eaac` 时间弹窗、`289ca1ec` 电话短信协议修复，并保留本地菜单、标签与媒体渲染。
- `e99ae780` 金额安全公式语法同时供正文 remark 和 Tiptap 兼容块使用，避免金额文本变成不可编辑块；没有引入 CodeMirror 新运行逻辑。
- `14d3c689` 搜索高亮使用 CSS Custom Highlight API，支持多关键词、异步正文与卸载清理；浏览器缺少 API 时降级为正常文字。
- `dd18002b` SSE 适配可见标签页共享连接、失联退避、主窗口交接与缓存重同步；协调 channel 与 Web Lock 额外按账号命名，避免不同账号混用连接。个人空间仍通过原有 API 请求头过滤查询，SSE 仅触发当前标签页已有查询失效，不写入其他空间数据。
- 服务端 SSE 预先编码 frame，缓冲满的慢客户端断开后通过客户端重连恢复；心跳只在无事件时发送。鉴权和服务端可见性规则保持现状。

## 验证事实与边界

- 2026-09-22，Node 24.21.0 / Go 1.26.2：`corepack pnpm --dir web lint` 通过；`corepack pnpm --dir web test` 通过 82 个文件、368 条测试；`corepack pnpm --dir web build` 成功。
- 构建器 LightningCSS 对标准 `::highlight(...)` 发出未知伪元素告警，构建产物仍保留对应规则；另有大 chunk 提示。未通过升级依赖规避提示。
- `go test ./server/router/api/v1/... -run TestSSE -count=1` 两包通过。`go test ./server/...` 除 `server/router/frontend` 外全部通过；该包 6 条既有测试的断言完成后，Windows 清理临时 SQLite 文件时因未关闭句柄失败，不涉及本次 SSE 代码。
- `go test -race ./server/router/api/v1/... -run TestSSE -count=1` 受本机 CGO 未启用限制，未运行；完整 `go test -v -race ./server/...` 仍由具备 CGO 的环境执行。
- Windows checkout 的 CRLF 先恢复为仓库 LF 以运行 Biome；Git 暂存只包含实质修改，没有全目录行尾提交。

## 未覆盖范围与后续建议

- 此分支未进行真实浏览器、iPhone Safari、软键盘或 PWA 交互验证，需在主分支集成后检验桌面与 430px 页面及实际跨窗口交接。
- 不包含上传、ZIP 导入导出、附件容量、PWA、导航重构及鉴权语义变更；这些独立范围由主任务记录。
- 时间弹窗对应服务端时间字段保持与金额/PDF原文回归由配套后端任务处理。
