# TASK-20260922-backend-ci-concurrency：修复版本检查中的后端并发失败

- 记录日期：2026-09-22
- 模块与关键词：Store、刷新令牌、并发 SSO、MySQL、CI
- 维护归属：`fix/pr39-backend-ci` 工作分支
- 关联 PR：[版本 PR #39](https://github.com/Castor6/memos/pull/39)

## 背景与目标

版本 PR 的完整后端检查暴露两处失败：并发 SSO 首次登录在 `AddUserRefreshToken` 修改共享缓存切片时触发 race detector；MySQL 两个删除测试报 `Error 1615: Prepared statement needs to be re-prepared`。修复令牌并发读改写，并降低共享测试数据库大量独立表带来的缓存淘汰。

## 验收标准

- [x] 并发登录保存全部刷新令牌，新增与移除并发执行不丢失其它会话。
- [x] 刷新令牌读取返回独立快照，不受通用设置缓存的旧值回填影响。
- [x] Server 和 Store SQLite race 检查通过。
- [ ] Store MySQL、PostgreSQL 容器检查通过。
- [x] MySQL 测试保持服务端参数化语句路径，不通过跳过测试或盲目重试掩盖失败。

## 讨论结论

2026-09-22：用户授权修复上述问题。基于 main 单独提交修复，由正常 Changesets 流程更新版本 PR。刷新令牌修复范围为单个 Store 实例的并发读改写，不改变令牌格式、有效期和轮换规则。

## 实现结果

2026-09-22：`Store` 增加刷新令牌互斥锁，新增和移除操作在同一临界区完成读改写。`GetUserRefreshTokens` 直接读取数据库并解码独立对象，避免共享切片修改和通用设置缓存旧值回填。令牌格式、有效期、刷新时先新增再移除的顺序保持原有规则。

新增 Store 回归测试覆盖并发新增、撤销与新增混合、并发读取、返回对象隔离和旧缓存不恢复已撤销会话；SSO 并发首次登录测试增加每次登录都持久保存会话的断言。

共享 MySQL 测试容器设置 `table_definition_cache=8192`、`table_open_cache=8192`，覆盖当前数千张独立测试表。保留服务端 prepared statement 路径；不修改生产驱动、镜像版本和发布工作流。MySQL 官方说明表定义缓存淘汰会触发语句重新准备，见 [statement caching](https://dev.mysql.com/doc/refman/8.0/en/statement-caching.html)。

## 验证事实与边界

原始失败证据：[server](https://github.com/Castor6/memos/actions/runs/35744716581/job/106803344979)、[store](https://github.com/Castor6/memos/actions/runs/35744716581/job/106803344814)。本机没有 Docker，三驱动容器测试需由 GitHub CI 验证。

2026-09-22，本地基线 `55c99283`：

- 新回归测试在未修复代码上失败：16 次并发新增只保留 3 个令牌；修改读取对象也会污染下一次写入。
- 修复后并发 Store、独立快照、原有刷新令牌和并发 SSO 测试通过 `-race -count=10`；旧缓存回归另通过 `-race -count=10`。
- `DRIVER=sqlite go test -race ./server/...` 与 `DRIVER=sqlite go test -race ./store/...` 全部通过。
- `corepack pnpm test` 的 9 项检查及 `corepack pnpm check:release origin/main` 通过。
- 本地源码构建的 golangci-lint v2.11.3 全量扫描报 4 条已有 `epoch-naming` 命名问题，位于未修改的 `store/link_metadata_queue.go` 和 `store/test/attachment_cleanup_delete_test.go`；`--new-from-rev=origin/main` 扫描为 0 issues。正式 CI 使用官方发布二进制，其结果另行核实。
- 独立审查确认登录、注销和轮换调用均经过修复方法，未发现阻塞问题。

## 未覆盖范围与后续建议

互斥保证范围为同一 Store 实例；多个进程同时修改同一用户令牌的事务一致性不在本次范围。MySQL 参数变更需要在真实容器套件中确认效果，单次通过也不能证明所有偶发失败都已消除。
