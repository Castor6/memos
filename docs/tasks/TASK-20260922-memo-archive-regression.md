# TASK-20260922-memo-archive-regression：ZIP 导入故障回归

- 记录日期：2026-09-22
- 模块与关键词：ZIP、SQLite 故障注入、回滚、个人空间、归档权限、资源限制
- 维护归属：`feat/upstream-backend` 分支，独立安全审查会话
- 关联任务：[上游整合](TASK-20260922-upstream-v031-review.md)、[后端修复](TASK-20260922-upstream-backend.md)

## 背景与目标

针对独立审查发现的 ZIP 导入失败残留、权限窗口、重复文件放大与备份重导问题，验证主会话修复。
实现文件仅从主工作区复制到独立工作区用于运行测试，本任务只提交新增回归测试和本记录。

## 验收标准

- [x] SQLite 触发器强制附件绑定、评论父关系或最终状态更新失败后，新笔记、附件、关系及附件文件全部回滚；解除故障后同一 ZIP 可重试。
- [x] 归档公开笔记在导入写入过程中没有正常公开状态，导入后匿名与其他用户无法读取。
- [x] 多个附件 UID 复用同一 ZIP 条目时，按实际恢复总量执行 512 MiB 上限。
- [x] 空间 ID 冲突的归档再次导入时，不创建额外空间；覆盖第一次导入刚好达到 100 个空间的边界。
- [x] 失败导入可保留新增空空间，但重复失败及之后成功重试不会持续新增冲突空间。
- [x] 高压缩率附件能够完整导出、解析并导入。

## 实现结果

- 新增 `server/router/api/v1/test/memo_transfer_regression_test.go`，使用真实 SQLite 触发器注入失败，验证跨空间回滚和重试结果。
- 使用数据库 INSERT/UPDATE 审计记录检查归档公开笔记的所有写入状态，避免只检查请求完成后的权限而漏掉中间公开窗口。
- 构造一个 24 MiB ZIP 条目被 22 个不同附件 UID 引用的归档，验证 528 MiB 逻辑恢复量在写入前拒绝。
- 使用三份各 24 MiB 的全零附件验证服务端导出、归档读取、导入和字节一致性。
- 首轮测试实际发现跨空间附件清理遗漏及空间满额重导提前误拒绝；主会话修复后，全部新增回归通过。

## 验证事实与边界

2026-09-22，在整合 `c54433ac` 并复制主会话当日 ZIP 实现的独立工作区运行：

- `DRIVER=sqlite go test ./server/router/api/v1/test -run TestMemoArchiveRegression -count=1`：通过，4.3 秒。
- `DRIVER=sqlite go test ./server/router/api/v1/...`：两个包均通过，服务测试包 11.4 秒。
- `go test ./internal/memoexport`：通过，含 golden ZIP 样本。
- `gofmt` 和提交前 `git diff --cached --check`：通过。

测试使用隔离 SQLite 数据，不连接线上服务。依赖的 ZIP 实现与基础 `memo_transfer_test.go` 由主会话维护；本次提交仅包含新增回归测试及本记录。

## 未覆盖范围

- 当前 Windows 环境没有 CGO 编译工具链，`go test -race ./server/router/api/v1/test -run TestMemoArchiveRegression -count=1` 返回 `-race requires cgo`；竞态检查需在支持环境补跑。
- 未覆盖 MySQL/PostgreSQL 故障注入、真实 S3、进程强制退出后的恢复和前端操作；此次验证范围为 SQLite 的 API 与存储结果。
