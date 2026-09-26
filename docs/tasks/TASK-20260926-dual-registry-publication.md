# TASK-20260926-dual-registry-publication：双仓独立发布

- 记录日期：2026-09-26
- 模块与关键词：GitHub Actions、ACR、GHCR、OCI、历史转存
- 维护归属：feat/dual-registry 发布子任务

## 背景与目标

同一测试通过镜像独立上传两仓，一路故障不阻止另一路更新。保留正式版本路由和独立扩展发布，以可信旧版测试升级，支持旧镜像原样补传。

## 验收标准

- [x] 本地测试证明标签保护、升级基线备用来源、缺失失败、stable 防倒退。
- [x] 两路 matrix 不互相取消，失败不隐藏；成功通道可以发布兼容 GitHub Release 元数据。
- [x] 手动历史转存不重建，默认不移动 stable；可信工具与历史源码 checkout 分离。
- [x] 既有版本及扩展路由单测通过。
- [ ] 实际 Actions 双仓、部分失败和历史镜像传输验收（由主任务执行）。

## 实现结果

`publish-image.py prepare` 输出固定 OCI archive 和摘要；`publish` 每个渠道独立登录、验证、发布版本/sha/stable；`transfer` 读取正式 Release 身份原样搬运。相同版本已有 Release 或已测试版本标签时恢复原摘要，避免重试重建。上一正式版绑定 Release metadata 与 Git tag，GHCR 优先且包括下载失败时的 ACR fallback，验证来源、版本、提交、平台、摘要。

上传总步骤 15 分钟，每次复制 5 分钟、最多 3 次，间隔 5 秒。registry job 20 分钟含安装/下载工具产物。两路失败不产生 GitHub Release，任一路失败整次 workflow 红，成功一路仍可更新。GitHub Release 继续白名单产物，不发布 OCI 大文件或仓库地址。

手动 `Copy Published Image` 使用 main 当前工具、输入 version/channel/advance_stable。与发布共享并发组，防止 stable 并发覆盖。更新器及线上切源入口属主任务独立负责范围。

## 验证事实与边界

2026-09-26：Python 发布单测、13 项 Node CI/版本规则测试、`node scripts/release-check.mjs origin/main`、Actionlint v1.7.12 均通过。Node 本机为 22.22.0，项目要求与 CI 为 Node 24，安装依赖出现 engine 警告；CI 仍需验证要求版本。尚未在本机运行完整 Docker 构建/安装升级（将在 Actions 验证）。历史是否成功回填、GHCR 包可见性及服务器实际拉取不由本记录推断。

2026-09-26 审查补充：正式 Release 身份显式排除 draft/prerelease，核验 release.json 与 image-digest.txt 的 SHA256SUMS；草稿重试转为恢复已测试仓库镜像，不读取未完整上传的草稿附件。历史转存仅最新正式版本可推进 stable。新增目标测试后 `test_publish_image.py` 20 项通过。

2026-09-26 独立审查修复：在任何仓库上传前写持久 candidate commit status 收据，记录已测试 OCI artifact。重试读取并核验 run/workflow/source job、artifact 校验和、版本提交与镜像摘要；原产物不可取回则失败，避免 ACR 不可达时重建已发布版本。无收据首次发布仍允许 ACR 不可达。新增 artifact 恢复、过期、未知网络、首次构建与冲突收据测试。目标镜像发布单测 27 项通过，包含其它发布测试共 56 项。

2026-09-26 重跑审查：渠道结果 artifact 仅成功后覆盖自身固定名称，保留另一渠道既有成功结果供失败任务重跑汇总；扩展候选也允许完整验证后覆盖同名 artifact。Memos 主候选按 attempt 命名并保留收据原 artifact。相关 workflow 测试及 Actionlint 通过。
