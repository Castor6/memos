# TASK-20260923-link-preview-loading-fallback：链接预览失败时保持普通链接

- 记录日期：2026-09-23
- 模块与关键词：链接预览、加载状态、网络失败
- 维护归属：本次会话；工作分支 `fix/link-preview-loading-fallback`
- 关联任务：[链接预览缓存与后台处理](../link-previews.md)、[首次成功快照](TASK-20260921-export-link-cache.md)

## 背景与目标

用户打开含有 `learn.chatgpt.com` 链接的笔记时，先看到数秒“正在读取链接预览…”卡片，随后退回普通链接；服务器可能无法访问目标站点。目标是让尚无有效预览的链接从首次显示起保持普通链接外观，抓取成功后仍能显示卡片。

## 验收标准

- [x] 尚未进入视口、正在抓取、抓取失败或取得空标题时显示原始链接，不出现临时加载卡片。
- [x] 首次成功取得有效标题与笔记已有成功快照仍显示预览卡片。
- [x] 单次预览 API 失败不被浏览器立即自动重试；后端现有持久退避与后台恢复机制继续生效。

## 讨论结论

后端已按 URL 保存首次成功快照，并为失败抓取设置持久退避。尚不能仅凭截图判定目标站点失败的具体原因；这次修复前端显示与重复请求行为，不改变抓取规则或后端队列。

浏览器取消的是单次失败查询的自动重试。重新打开笔记、窗口聚焦或网络重连仍可能重新调用 Memos 预览接口；后端退避期内不会重复抓取目标网站，网络恢复后仍有机会取得预览。

## 实现结果

2026-09-23：`LinkMetadataCard` 在无有效标题时直接呈现原始链接，取得有效标题才显示卡片；`useLinkMetadata` 关闭单次查询的自动重试。补充视口外、加载中和失败回退测试；`docs/link-previews.md` 记录展示与重试边界。使用根目录 Changesets CLI 新增中文 patch 说明。

## 验证事实与边界

2026-09-23，基于 `origin/main` 创建的独立工作分支，使用 Node 24.19.0 和仓库 pnpm 11.0.1：

- 单文件预览回归测试 7 项通过；全量 `pnpm test` 为 89 个文件、404 项通过。
- `pnpm exec tsc --noEmit --skipLibCheck` 通过；`pnpm exec biome check src --line-ending=crlf` 检查 452 个文件通过，改动的测试文件同参数检查通过。
- `pnpm build` 成功；构建输出已有的 CSS `::highlight` 识别和大 chunk 提示。
- `pnpm check:release origin/main` 通过；`git diff --check` 通过。
- 原样执行 `pnpm lint` 时，Biome 因 Windows 的 `core.autocrlf=true` 将 452 个检出文件识别为 CRLF 而失败；上面的 TypeScript 与 CRLF 参数下的全量 Biome 检查分别通过，没有改写未涉及的源码文件。

## 未覆盖范围与后续建议

本机找不到 Go，未启动本地完整服务进行内置浏览器验证；组件测试覆盖了对应状态转换，但不证明线上实际网络故障原因。未排查线上服务器连通性，也未执行部署。
