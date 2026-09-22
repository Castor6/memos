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
- 第一阶段不包含上传、ZIP 导入导出、附件容量、PWA、导航重构及鉴权语义变更；ZIP 前端随后在本记录第二阶段实现，其后端和其他范围由主任务记录。
- 时间弹窗对应服务端时间字段保持与金额/PDF原文回归由配套后端任务处理。

## 第二阶段：ZIP 导入导出设置入口

- 2026-09-22，范围：接入主任务提供的 `MemoTransferService`，在普通账号设置新增 ZIP 导入导出入口、React Query mutation、英简繁文案与结果明细。后端、Proto 及生成物由主任务维护。
- 验收目标：导出下载 ZIP；文件选择后显式点击导入；空文件、非 ZIP 和超过 128 MiB 的文件在读取前拒绝；导入前显示账号、空间归属及不覆盖规则；成功/跳过/附件数量和逐条警告/错误可读；请求中避免并发重复操作。
- 实现：普通账号设置新增“导入与导出”；React Query mutation 复用既有鉴权/当前空间 transport，请求中禁用导入导出，禁止自动重试。导入完成后刷新笔记、附件、用户查询与空间设置。下载及时移除 DOM 链接并延后释放对象 URL，mutation 完成后清理大文件结果缓存。
- 2026-09-22 验证：`corepack pnpm --dir web lint` 通过；`corepack pnpm --dir web test` 共 83 文件、377 条测试通过；`corepack pnpm --dir web build` 成功，告警与第一阶段相同。新增 9 条测试覆盖显式导入、文件限制、部分成功、逐条失败、导入重试、导出错误、ZIP 下载/URL 释放、缓存刷新和英简繁键覆盖。
- 边界：编译使用主任务已生成的 `memo_transfer_service_pb.ts`，生成物不纳入本分支提交；真实后端 ZIP 互操作和浏览器下载需在主分支集成后验证。

## 第三阶段：集成后本地 HTTP 验收

- 2026-09-22：主任务集成后，以 Go 1.26.2 构建本地服务，API 监听 `127.0.0.1:8081`，Vite 监听 `127.0.0.1:3001`；使用 `tmp/local-dev/upstream-ui-20260922/` 独立 SQLite 数据及开发文档中的公开测试账号，不访问历史或线上数据。Windows 无 `fcntl`，按开发脚本相同请求初始化 4 条笔记和图片样例。
- ZIP：通过真实 HTTP 导出 4 条笔记与 3 个关联附件，生成 5000 字节 ZIP，压缩包 CRC 检查通过；在同账号重导入得到成功 0、跳过 4、附件 0，无警告或错误，符合 UID 去重不覆盖规则。样例保存在 `tmp/local-dev/evidence/upstream-ui-export.zip`。
- 上传与容量：713 字节 PNG 分两段传输，首段 40 字节重试不会重复写入，查询进度仍为 40；续传完成后重发末段返回同一个附件，空 MIME 元数据识别为 `image/png`，下载 SHA-256 与原文件一致。容量从 1426 增至 2139 字节，等于附件列表持久化大小之和。
- SSE：两个独立鉴权 HTTP 连接均立即收到连接注释，并按序收到同一测试笔记的创建、更新、删除事件；测试笔记随后删除。未登录访问 SSE 与 ZIP 导出均返回 401。详细响应记录在 `tmp/local-dev/evidence/http-verification.json` 与 `http-sse-verification.json`，不包含访问令牌。
- 边界：本阶段证明本地 SQLite、HTTP 服务与文件内容互操作；不代替跨数据库、容器、真实 Safari 或大文件压力检查。子会话没有可用 IAB，桌面与 430px 界面、浏览器下载、搜索高亮及跨窗口共享连接的界面验收交由主任务使用 Codex IAB 完成，未使用常用 Chrome。
