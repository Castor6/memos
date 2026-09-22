# TASK-20260922-upstream-upload：分块上传与账户附件容量

- 记录日期：2026-09-22
- 模块与关键词：附件、分块上传、短时续传、账号容量、三驱动
- 维护归属：schema_review 子会话；初始实现 feat/upstream-upload，单文件上限补充 fix/upload-file-size-limit
- 关联任务：[上游评估](TASK-20260922-upstream-v031-review.md)

## 背景与目标

用户批准移植上传优化和账户附件容量统计。保留个人空间、微信与扩展旧 CreateAttachment 接口，不引入上游协作空间、命名存储或数据库结构迁移。

## 验收标准

- [x] 上传使用 2 MiB 分块、30 分钟空闲过期；绑定用户与起始个人空间，重启后明确失效。
- [x] 重复块、重复完成、失败重试不产生重复附件；校验限额、权限、过期清理。
- [x] 网页按块读取文件并支持短时重试，保留原有即时上传流程与动态照片元数据。
- [x] 账号统计包含全部个人空间及未关联附件，只向本人返回，不包含上传临时文件。
- [ ] SQLite/MySQL/PostgreSQL 使用同一统计含义，三驱动集成检查均通过（SQLite 已通过；本机缺少 Docker，未验证 MySQL/PostgreSQL 实际查询）。

## 讨论结论

参考上游 b3e67399、ba44a669 和 v0.31.0 最终实现，按本 Fork 数据模型适配。临时上传属于单进程短时会话，不承诺跨重启恢复；持久附件统计按所有者汇总，不受当前空间过滤。仅增加 proto 字段和查询，无数据库迁移。

## 实现结果

2026-09-22：新增 UploadAttachment，使用临时文件接收至多 2 MiB 的块，单块请求上限 4 MiB。上传固定当前用户与起始个人空间，重新校验关联笔记权限及容量限制，30 分钟空闲回收；关闭服务清除临时文件。重复最后一块不重复写入，重复完成返回已有附件，已删除附件不复活。每用户最多 8 个活动上传，全局最多 128 个活动上传、1024 个会话。

保留 CreateAttachment，并复用身份、空间、文件名、MIME、笔记关联、动态照片与大小验证。普通文件可流式写入本地或 S3；数据库 Blob、图片 EXIF 处理仍需缓冲文件内容，未宣称所有文件均恒定内存。持久化失败时确认数据库状态后清理已保存对象，避免已提交但响应失败时误删文件。S3 上传成功但签名链接失败时，使用独立 30 秒超时尝试删除对象；删除失败记录错误并保留原始签名失败，未宣称外部存储不可用时能保证清理成功。S3 每次保存使用独立服务端随机对象名，不能由客户端提供的附件 UID 决定对象路径，避免同 UID 并发保存覆盖以及失败清理误删成功对象。ZIP 模块可复用内部校验及存储函数，外部 API 不提供跳过校验的开关。

网页通过 File.slice 按块读取文件，以固定空间请求头完成本轮上传。同一个 File 对象保留会话，重试时查询服务端已写字节；仅网络不可用或超时会短暂重试。过期或重启后的会话明确报错，之后用户再次重试才创建新会话。成功会话暂留弱引用，避免多文件中后续文件失败后重试整批时重复保存前面的文件。

三驱动均增加按 creator_id 汇总 SUM(size) 的 64 位查询；用户自己的 UserStats 返回可选 attachment_storage_bytes，其他用户及匿名访问不返回。账号设置区展示全部个人空间及未关联附件占用，排除临时上传、缩略图与衍生 PDF；缺失或失败与实际 0 字节区别显示。

## 验证事实与边界

2026-09-22，在上传独立工作区、Go 1.26.2 / Node 24.21.0 / Buf 1.73.0 下执行：

- 已安装 pre-commit 空白检查，暂存后执行 git diff --cached --check。
- DRIVER=sqlite go test ./server/router/api/v1/... ./store/test -run 'TestChunkUpload|TestAttachmentStorage|TestCreateAttachment|TestGetUserStats'：通过。覆盖重复块、并发重复完成、用户与空间隔离、匿名拒绝、容量限制、笔记权限变化、过期/重启、临时文件清理，以及跨空间 64 位汇总和容量字段可见性。
- DRIVER=sqlite go test ./server/router/api/v1/... -run 'TestS3Concurrent|TestAttachmentPresign|TestChunkUpload|TestAttachmentStorage'：通过。补充验证签名失败后的对象删除不受原请求取消影响、清理存在超时、清理失败仍保留原始错误，以及签名成功不删除对象。使用本地 HTTP fake S3 同时提交同 UID、同名但不同内容，覆盖同一用户和两个用户；验证仅一条附件记录成功、每次 PUT 使用不同 key、失败清理只删除本次对象，成功内容保留。此模拟不等于真实 S3 服务验证。
- cd web && corepack pnpm lint：类型检查与 Biome 通过。
- cd web && corepack pnpm test -- tests/upload-service.test.ts tests/attachment-storage-usage.test.tsx：脚本实际运行完整测试集，78 个文件 / 316 项全部通过，其中新增上传服务 6 项、容量展示 3 项。
- cd web && corepack pnpm build：通过，仅常规大 chunk 提示。
- buf lint proto 与 buf format --diff --exit-code proto：通过；修改 proto 后已运行 buf generate，仅保留实际受影响的生成输出。
- DRIVER=sqlite go test ./server/... ./store/...：API、认证、文件服务、其他服务及查询相关包通过；frontend 的 6 项测试与 store/test 的 7 项迁移测试在 TempDir 清理阶段失败，错误为 Windows SQLite 文件句柄仍占用，未发现这些测试的业务断言失败。因此不能记为后端全量通过。
- go test -race ./server/router/api/v1/... -run 'TestChunkUpload|TestAttachmentStorage'：未能执行，本机未启用 CGO 且缺少 C 编译器。

## 未覆盖范围与后续建议

MySQL/PostgreSQL 容器集成测试、真实 S3、进程异常退出后的磁盘回收、实际网络断开及浏览器手工交互未执行；服务重启失效与过期回收由单进程单元/集成测试模拟。桌面与 430px 两个高度的视觉验收由整合任务统一完成，本记录不推定其结果；窄视口亦不能替代 iPhone/Safari 真机验证。完整 race 检查、全部后端包与三驱动检查需在具备对应工具和容器条件的环境补跑。


## 2026-09-22 补充：单附件大小与三驱动字段边界

基于整合代码 4abd247ad 复核发现，MySQL 与 PostgreSQL 的单条附件 size 为有符号 32 位整数；跨附件 SUM 使用更宽类型并扫描到 Go int64。账号总容量测试应使用多个合法大小记录构造超过 2 GiB 的总和，该测试数据修正由整合任务负责，本次不修改统计查询或数据库结构。

分块上传的 total_size 不再受到旧接口单请求体大小的约束，管理员将限额配置为 2048 MiB 或更大时，原逻辑可能允许最终无法存入上述两驱动的单个附件。本次将共享 attachmentUploadLimit 的有效值限制为配置字节数与 math.MaxInt32（2,147,483,647 字节）的较小值，保留配置乘法的溢出防护及原有默认/普通配置行为。旧 CreateAttachment、分块上传开始/完成、ZIP 内部导入共用大小校验，不增加数据库迁移。

实际验证：DRIVER=sqlite go test ./server/router/api/v1/... -run 'TestChunkUpload|TestCreateAttachment' 通过。新增测试覆盖 1 MiB、默认 30 MiB、2047 MiB、2048 MiB 和 math.MaxInt64 配置：超出有效上限 1 字节返回原有 InvalidArgument 错误，上传 manager 中无 session，磁盘上无临时上传文件；恰好等于有效上限可创建会话，临时文件实际仍为 0 字节。测试不分配或传输 2 GiB 文件。golangci-lint v2.11.3 run --timeout=3m --new-from-rev=4abd247ad ./server/router/api/v1/... 返回 0 issues；这是相对上述基线的新增问题检查。

本次仅执行本地 SQLite 目标验证，未启动 MySQL/PostgreSQL 容器，未实际上传接近 2 GiB 的文件；不把会话开始边界测试当作大文件传输或三驱动集成测试通过。独立分支的暂存空白检查已执行。
