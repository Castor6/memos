# TASK-20260922-upstream-main-integration：上游选定更新适配最新 main

- 记录日期：2026-09-22
- 模块与关键词：上游重放、原子笔记更新、附件异步清理、SSE、查询刷新去重
- 维护归属：`feat/upstream-v031-main` 分支，独立整合会话
- 关联任务：[上游整合](TASK-20260922-upstream-v031-review.md)、[ZIP 故障回归](TASK-20260922-memo-archive-regression.md)

## 背景与目标

将本次上游报告和选定更新重放到 `origin/main` 的 `6f30df69`，排除属于其他工作的剪藏基线 `7d609777`。
在独立工作区处理冲突，保留最新 main 的原子笔记/附件更新、异步文件清理和查询刷新去重，以及本次 ZIP 安全回滚、分块上传和跨标签页 SSE 能力。

## 验收标准

- [x] 本次分支基于最新 main，且不包含剪藏基线提交。
- [x] 后端保留 `ApplyMemoMutation` 写入路径及附件存储身份隔离，ZIP 故障回归通过。
- [x] SSE leader 与 `scheduleQueryRefresh` 去重共存，前端测试、lint 和构建通过。
- [x] 完成相关 Go 测试及差异空白检查，明确本地环境无法验证的项目。

## 实现结果

- 从上游整合结果重放 9 个相关提交。共同祖先为 `6f30df69`；`7d609777` 不是本分支祖先，剪藏基线不在本次差异中。
- 处理 SSE、附件存储和时间校验冲突：保留主线 `ApplyMemoMutation`、每次上传独立随机存储身份、异步清理的引用保护，以及 DNS 解析后直接拨验证 IP 的 SSRF 防护。测试改用主线公开的 `httpgetter.ValidateURL`。
- ZIP 回滚新增 `DeleteAttachmentWithCleanup`，在事务中删除本次附件记录并持久入队；不改变普通 `DeleteAttachment` 的现有行为。未绑定附件和已绑定附件都能在存储删除失败后重试，避免回滚绕过主线清理队列。
- ZIP 回归按异步清理语义显式驱动队列后检查文件已删除；补充入队事务失败、空间隔离、S3 配置快照，以及归档失败后存储清理重试测试。
- UID 复用测试同时保护 `.jpeg`、`.v2.jpeg`、失败标记及动态照片缓存。保留主线按单笔记读取完整附件元数据的行为。
- 前端重连和事件处理保留 leader/follower 共享连接，同时使用主线刷新合并队列；新增两类组合回归，验证本地写入与重复 SSE 合并、reaction 仅刷新包含目标笔记的集合。
- 纳入主会话补充的用户选定范围与实际 UI 验证记录；此任务不重复记录其浏览器操作。

## 验证事实与边界

2026-09-22，在 `.worktrees/ucombine` 独立工作区实际验证：

- `go build -o tmp/memos-integrated.exe ./cmd/memos`：通过。
- `DRIVER=sqlite go test ./server/router/api/v1/... ./server/router/fileserver ./server/runner/... ./internal/httpgetter ./internal/webhook ./internal/memoexport ./internal/scheduler ./internal/imagelimit`：通过。
- 队列适配后重新执行 `go test ./server/router/api/v1/... ./internal/httpgetter ./internal/webhook ./internal/memoexport`：通过。
- `DRIVER=sqlite go test ./store/test -run 'Test(MemoMutation|MemoAttachments|AttachmentCleanup|AttachmentStorage|GetAttachmentStorage|DeleteAttachment)' -count=1`：通过，覆盖原子更新、清理保护及新增删除入队测试。
- `golangci-lint run`：0 issues。Windows checkout 的 CRLF 曾被格式检查报告；仅在工作区临时转为 LF 完成检查，之后恢复不含内容改动的文件，没有提交全仓格式变化。
- 前端 `pnpm lint`、`pnpm test`、`pnpm build`：通过，89 个测试文件、402 个测试。构建仅有既有 CSS 高亮选择器与大包提示。
- `corepack pnpm check:release origin/main`：通过。
- 根目录 `corepack pnpm test`：5 项通过、2 项失败。失败集中于版本生成测试在 Windows 用 `execFileSync` 执行无扩展名 `node_modules/.bin/changeset` 时的 `ENOENT`；未修改与本次功能无关的测试运行器。
- `git diff --cached --check`、`git diff --check origin/main...HEAD`：通过。

## 未覆盖范围

当前 Windows 环境缺少 CGO 编译工具链与 Docker；未运行 race、MySQL/PostgreSQL 容器测试或真实 S3。需在支持环境执行相应 `go test -race` 和三驱动测试。此次新 SQL 沿用主线的占位符转换、行锁与清理配置快照机制，SQLite 的成功、回滚和重试路径已验证。

## 2026-09-22：修复 Linux CI 暴露的实例设置缓存竞争

- 维护分支：`fix/storage-setting-cache-race`，基于整合提交 `4abd247ad`。Linux CI 的并发 S3 上传测试检测到 `GetInstanceStorageSetting` 读写默认上传大小时的数据竞争。
- 根因是普通实例设置缓存直接保存、返回同一个可变 protobuf 指针；getter 填充默认值和调用方修改返回值都可能写入共享缓存。
- 仅在缓存命中返回、缓存存入两处复用现有 `cloneInstanceSetting` 深拷贝，包含嵌套 S3 配置。没有逐个重构 typed getter，也没有改动部署配置优先级或 getter 回写与并发 Upsert 的既有一致性窗口。
- 新增回归覆盖 Upsert/Get/typed getter/List 返回值隔离，以及 32 个 goroutine 并发补默认值、修改各自 S3 配置。修复前，写入返回值隔离测试可确定复现：调用方设置 999 后缓存也读到 999；修复后通过。
- 原实例设置测试改用 `proto.Equal` 比较消息内容，避免把 protobuf 内部反射缓存状态当作业务值比较。
- 实际验证：SQLite 实例设置测试、部署配置/鉴权/缓存测试、S3 并发与分块上传测试连续 5 次、全部 API v1/fileserver/runner 包测试均通过；限定本次变更的 `golangci-lint run --new-from-rev HEAD ./store/...` 为 0 issues；gofmt 和提交前空白检查通过。
- 本地仍无 CGO，未声称本机通过 `-race`；竞态修复需由 Linux CI 重新验证。容量统计 fixture 由主会话独立修复，本补丁未改动该文件。
