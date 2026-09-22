# TASK-20260922-upstream-backend：上游后端缺陷适配

- 记录日期：2026-09-22
- 模块与关键词：SSRF、cron、MCP Schema、附件处理、时间校验、金额文本
- 维护归属：工作分支 `feat/upstream-backend`
- 关联任务：[上游 v0.31 评估](TASK-20260922-upstream-v031-review.md)

## 背景与目标

按用户批准的缺陷修复范围，将上游修复映射到本 Fork 的代码结构，保留个人空间、微信剪藏、PDF 与动态照片行为。

## 验收标准

- [x] 外链与 Webhook 阻止 CGNAT / 未指定目标；cron 正确处理日和星期。
- [x] MCP Schema 不暴露 enum / bytes / field-mask 专有 format，保留类型与 base64 语义。
- [x] 附件缩略图提前检查像素、缓存永久失败，鉴权后才读取数据库 blob，正确清理派生缓存。
- [x] 错标图片仍清理 EXIF，头像限制在服务端执行，S3 无 UUID 模板不会覆盖同名对象。
- [x] 更新时间拒绝无效 protobuf timestamp；Go Markdown / PDF 保留金额字面量。
- [x] 完成相关回归检查并记录实际结果和未覆盖范围。

## 讨论结论

- 不引入登录/写入限流、会话撤销、权限扩大、S3 代理、包重命名、依赖升级或新上传协议。
- 本 Fork 未启用上游 Goldmark 数学解析器；金额问题在前端适配，后端通过回归测试保证金额和公式原文字面量不被破坏，不借此新增数学渲染能力。
- MCP 提交包含较新 SDK 的服务配置，当前只提取 Schema 归一化，避免扩大依赖面。

## 实现结果

2026-09-22：

- 按 [f4d97faf](https://github.com/usememos/memos/commit/f4d97faf) 与 [607dc284](https://github.com/usememos/memos/commit/607dc284) 补齐抓取客户端的 CGNAT 和 Webhook 的 CGNAT / 未指定地址表，测试覆盖字面 IP、映射 IPv6、DNS 混合结果、重定向与 PDF 图片入口。
- 移植 [3227748a](https://github.com/usememos/memos/commit/3227748a) 的 cron 日/星期匹配和星期日 0/7 规则，以及 [652957c0](https://github.com/usememos/memos/commit/652957c0) 的 MCP Schema 归一化与整个工具目录检查。
- 从 [471745b4](https://github.com/usememos/memos/commit/471745b4) 提取附件修复：复用 50M 像素预检；缩略图拒绝超限或无法解码图片并缓存失败；临时打开失败、流读取中断和取消不写永久标记；拒绝访问时不读取数据库 blob；删除同时清理旧、新缩略图及失败标记；S3 确定性模板附加附件 UID；拒绝负分页偏移。
- EXIF 清理由声明类型和内容 sniff 共同决定；同时识别错标的 Android Motion JPEG，保持内嵌视频容器原样。头像除限制 data URI 长度外，还校验 base64 和解码后的精确 2 MiB 边界。
- 按 [0716eaac](https://github.com/usememos/memos/commit/0716eaac) 在更新笔记时间时拒绝非法 protobuf timestamp；合法自定义时间保留。Go Markdown / PDF 没有上游 math parser，不引入新渲染器，新增金额与公式字面量回归。
- 未更改 Proto、数据库 schema、HTTP 总请求限制或认证策略；发版 Changeset 由主集成任务统一维护。

## 验证事实与边界

2026-09-22，Windows / Go 1.26.2：

- 已安装共享 Git 空白检查钩子，所有改动经 gofmt。
- 通过：`go test ./server/router/fileserver ./server/router/api/v1/... ./server/router/mcp ./internal/httpgetter ./internal/webhook ./internal/scheduler ./internal/imagelimit ./internal/pdfexport ./internal/markdown/...`。
- 通过：设置 `DRIVER=sqlite` 后 `go test ./store/test -run 'TestAttachment'`；覆盖既有附件存储测试。新增文件服务测试使用真实 SQLite 和本地 HTTP 模拟 S3，验证拒绝访问零 blob 读取、错误缓存、流中断恢复、缓存删除；API 测试验证同名 S3 对象独立、错标 EXIF、动态照片、头像边界和时间保存。
- 已执行 `go test ./server/... ./internal/... ./store/...`，未整体通过：`server/router/frontend` 六项与 `store/test` 七项迁移测试在 Windows 清理临时 SQLite 文件时报告句柄占用；未改动的 `internal/wechatkf/legacy/TestReadLegacySnapshot` 报旧状态数据库结构或内容无效。其余服务端与内部包通过；MySQL/PostgreSQL 集成测试因 Docker 不可用跳过。此结果不等于全部驱动通过。
- 已尝试 `go test -race ./server/... ./internal/...`，工具链报告 `-race requires cgo`，本机 `CGO_ENABLED=0` 且没有 GCC；CI 仍需补跑该命令。
- `git diff --check` 通过；最终暂存区继续按仓库规则执行空白检查。

## 未覆盖范围与后续建议

不涉及生产数据、配置、部署或数据库结构变更。未做真实对象存储联调、并发 race、MySQL/PostgreSQL 容器验证，也未修复上述范围外 Windows 测试兼容问题；集成后需在 Linux CI 完成完整检查。
