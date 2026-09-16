# 个人内容的存储与索引

本 PR 的空间与笔记/待办分类是核心查询条件，使用独立列，偏好和非查询属性继续使用原有 JSON。数据库结构版本从 0.30.1 升为 0.30.2，与个人产品发布版本号分别管理。

## 唯一数据来源与迁移

- `memo.space`：个人空间 ID，空字符串表示原来的默认空间。
- `memo.is_todo`：独立待办类型标记，不依附于另一条笔记。
- `attachment.space`：附件空间归属。
- 创建、读取、筛选与引用校验使用这些列。更新正文或其他 payload 属性不会覆盖空间和类型。
- SQLite/MySQL/PostgreSQL 均有 `0.30/01__personal_content_indexes.sql`，并同步更新 `LATEST.sql`。迁移先回填预览版 JSON 的 `space` / `isTodo`，再移除旧属性；没有这些属性的生产数据使用默认值。不做长期双写，也不保留读取旧 JSON 的兜底路径。
- 内部 proto 已保留原字段编号和名称，防止复用；外部 API 不变。
- 应用启动自动执行迁移。上线前由既有部署流程备份数据库和附件；回滚需要恢复匹配备份，不能只换回旧镜像。

## 查询与索引

| 查询 | 索引列（按顺序） |
| --- | --- |
| 默认创建时间列表 | `creator_id, space, row_status, is_todo, created_ts DESC, id DESC` |
| 更新时间列表 | `creator_id, space, row_status, is_todo, updated_ts DESC, id DESC` |
| 置顶优先的创建/更新时间列表 | 在对应时间索引前加入 `pinned DESC` |
| 空间内附件列表 | `creator_id, space, updated_ts DESC` |
| 笔记的附件、关联清理 | `memo_id, space` |
| 引用的反向查找、反向关联清理 | `related_memo_id, type, memo_id` |

已有 UID 唯一索引负责单条资源定位，引用正向查询沿用已有联合唯一索引。MySQL 排序使用底层时间列，不对 `UNIX_TIMESTAMP` 展示表达式排序。

四个笔记索引覆盖已提供的创建/更新时间及置顶选择，不为每一种搜索条件继续叠加组合。升序与混合排序、跨范围列表可能仍需部分排序；标签/正文筛选先利用用户、空间、状态和类型索引缩小候选集，JSON 标签数组与正文包含搜索本身没有专用倒排索引。这不替代未来按真实数据评估标签关联表或中文全文索引。

## 验证方法

- `DRIVER=sqlite go test -v ./store/db/sqlite -run TestPersonalContentQueryPlans`：使用真实 SQL 构建函数及一万条数据，验证四种列表、附件与反向引用查询计划，不强制指定索引。
- `go test -v ./store/...`：三驱动验证新安装与迁移后的索引存在、旧生产/预览数据回填、正文/标签/二进制附件/引用保留、重复启动及后续 payload 更新。
- `python3 scripts/benchmark-personal-indexes.py --rows 100000`：在自动清理的临时 SQLite 中比较迁移前后结果与查询耗时，并记录迁移时间、文件大小和写入成本。仅使用生成数据，不连接生产数据库。

2026-09-17 本机 Python SQLite 3.51.3 的十万条模拟笔记结果（热缓存、15 次查询中位数）：

| 场景 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 四种列表查询 | 19.0–20.1 ms | 0.036–0.037 ms |
| 空间内正文匹配样例 | 19.127 ms | 0.027 ms |
| 附件列表 | 2.374 ms | 0.012 ms |
| 反向引用 | 0.700 ms | 0.018 ms |

此次迁移约 630 ms，文件由 74.6 MB 增至 90.0 MB（含列和索引）。同结构一次写入 1000 条笔记，有索引约 7.6 ms、去除新增索引约 3.8 ms。该结果用于说明收益和写入/存储代价，不作为线上承诺或 CI 的绝对性能阈值；正文查询样例为高命中率关键词，不能推断任意搜索性能。

代码提交 `015943ab` 的 [CI](https://github.com/Castor6/memos/actions/runs/35125894821) 已验证 SQLite/MySQL/PostgreSQL 全新安装、历史数据迁移、空间隔离和容器升级；本地预览也实际完成 0.30.1 → 0.30.2 迁移。尚未部署生产。
