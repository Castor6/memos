# Castor Web Clipper

Memos 定制版的浏览器剪藏子项目。Star 剪藏通用网页，Pick up 留存 X 互动；源码、测试和独立依赖均在当前目录，不是 Git 子模块。

先阅读 [现有任务记录](../../docs/tasks/TASK-20260922-web-clipper-compatibility.md)。后续会话继续维护该记录，已有试用反馈和正文超限优化项都在其中。

## 当前来源与改动

- 上游：[usememos/web-clipper](https://github.com/usememos/web-clipper)，标签 `v0.4.1`，提交 `3aa66d718313bb9b971901453eb12d1a10fc2764`。
- 上游说明保存在 [UPSTREAM_README.md](UPSTREAM_README.md)，上游 CHANGELOG 和设计说明保留供参考。
- `src/lib/versions.ts` 保留 Memos `0.7.0` / `v0.7.0` 兼容例外；具备 `webClipperSupported` 的定制服务器可通过能力声明支持独立版本号和本地 dev。
- `manifest.config.ts` 标记为 `Memos Web Clipper - Castor Trial`，与此前交付的试用包名称一致。
- 未引入上游独立仓库的工作流或 release-please；扩展检查接入 Memos 的 `validate`，个人发行 ZIP 随同一版本的 GitHub Release 提供。
- 沿用上游依赖与连接方式；没有增加登录系统、OCR、空间或独立标签选择器。

## Star 与 Pick up

- 打开弹窗不提取正文。点击 **Star** 后剪藏普通网页；有选中文字时优先选区，否则尝试提取正文。X 帖子详情使用专用提取器，保留短帖。提取失败明确说明当前只有选区、摘要或链接。
- Star 将「我的思考」放在「原内容」之前。可编辑原内容；长来源在保存的 Markdown 中使用 `details` 折叠，不自动截断。
- **Pick up** 用于 X 回复或引用帖详情，自动取得当前帖与页面已加载的必要上文。保存「我的评论 → 可选背景 → 回应内容与上文」，保留作者、时间、来源与原始互动快照。本人原话只读，后续感想写在背景中。
- 页面能识别登录用户时自动核对作者；无法确认时需要勾选本人声明，明确识别为他人时拒绝 Pick up。服务端仅验证快照一致性，不绑定或证明 X 账号身份。
- X 对话可能未完整加载；需核对预览，展开原网页的折叠内容后重新提取。视频只保留链接；已识别图片沿用附件上传，失败会显示提示。
- 本期不包含 Linux.do 互动适配、微信评论图、二维码或 OCR。

## 保存、草稿与同步

直接连接继续填写 **Memos 地址 + PAT**。新版本服务端必须声明 `webClipperSupported`；扩展先检查能力和实际正文 UTF-8 字节上限，旧服务器不会被当作已完成同步。现有默认上限 8 KiB 保持不变，可在 Memos 原有实例设置中调整。

Star / Pick up 的来源、类型、思考或评论、背景和 X 帖子快照随笔记同次写入 `Memo.capture`。历史和「已保存」提示读取服务器，另一浏览器用同一用户的 PAT 可恢复；不同 PAT 不影响归属。当前扩展使用默认个人空间，服务端仍按用户和空间隔离。

普通正文编辑保留首次互动快照；历史展示服务器当前正文，归档和删除状态按服务器读取。快照仅创建者可读，笔记正文仍服从用户选择的可见性。草稿按实例、用户、页面和模式保存在本机，不跨设备同步；关闭重开可恢复。未知保存结果使用持久化请求 ID 重试，确认成功后的再次保存才使用新 ID。

上游右键「快速保存选区/图片」暂时沿用旧流程，不包含思考编辑或结构化记录同步；本次两个入口均在弹窗。旧本地历史不自动迁移成云记录，原有笔记仍留在 Memos。回滚到不认识 `capture` 的旧服务端后编辑笔记可能丢失新快照字段，回滚前应保留数据库备份。

## 本地开发与验证

以下命令都在 `extensions/web-clipper` 运行。使用本目录固定的 pnpm 11.10.0，和仓库根目录的版本工具独立；CI 使用 Node 24。

首次准备（PowerShell）：

```powershell
Copy-Item .env.example .env
corepack pnpm install --frozen-lockfile
```

`.env.example` 包含上游 v0.4.1 发布包中的公开 OAuth 客户端配置，不包含个人令牌。实际 Memos 地址和访问令牌在扩展的「直接连接」中填写，不写入源码或构建配置。

```powershell
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

构建输出为本目录下的 `dist/`。Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，开启开发者模式并加载该目录。重新构建后，在扩展管理页面点击重新加载，必要时刷新正在剪藏的网页。

保留官方 Chromium key，扩展 ID 仍为 `nebaoebnljalfegiidibihhkebeiklbl`。切换到新 dist 时停用此前加载的试用目录或官方扩展，避免同一 ID 的不同副本冲突。旧试用目录 `../../tmp/web-clipper-trial/extension/` 仍保留，本次迁移不会自动更新浏览器已加载的副本。

## GitHub Release 安装包

包含本发布流程的版本 PR 合并后，GitHub Release 提供 `memos-web-clipper-chromium-v<版本>.zip`，Chrome 与 Edge 共用。下载 ZIP 并解压到固定目录，在扩展管理页开启开发者模式，选择「加载已解压的扩展程序」，选中含 `manifest.json` 的目录。它不是 CRX，也不会通过浏览器商店自动更新；更新时替换解压目录中的文件，再点击重新加载。切换目录前停用旧副本，保留原目录直到确认连接、草稿和历史正常。

ZIP 中的扩展版本跟随仓库根目录的 Memos 个人发行版本，`castor-release.json` 记录版本、确定提交与上游扩展基线；源码 `package.json` 的 `0.4.1` 继续表示上游基线。Release 的 `release.json` 列出配套 ZIP，`SHA256SUMS` 包含其校验和。安装扩展不等于服务器已升级，Star / Pick up 保存仍要求连接的实例声明对应能力。

从干净的源码检出构建个人 ZIP（需要 Python 3）：

```powershell
corepack pnpm package:release
```

输出在 `artifacts/`。已有构建也可在仓库根目录执行 `python extensions/web-clipper/scripts/package-release.py --output build/candidate`。打包保留 Chromium key、去除 `update_url`，只修改包内版本，不改源码；拒绝未提交改动、开发服务器构建或不完整产物。

`package` / `package:chrome` / `package:edge` / `package:firefox` 继续保留上游商店打包逻辑，另需 zip 等工具。本项目 Release 只提供个人 Chromium 包，不自动提交商店或发布 Firefox 签名包，也不为历史 Release 补发扩展。普通 PR 的扩展 CI 会提供短期 Actions artifact，供试用，不视为正式版本。

## 后续维护

继续维护关联任务中的实际验证与未覆盖范围。扩展修改触发独立 lint、单测、Python 打包测试、构建和 ZIP 生成，纳入根仓库 `validate`；版本 PR 与工作流修改也运行该检查。扩展交付行为变化需新增根目录 Changeset。不要把检查通过当作扩展商店发布或服务器部署完成。新增界面文案以个人使用的中文为主，上游设置与通用文案仍沿用语言配置。

源码、测试、公共配置示例受版本控制；node_modules、.env、dist、artifacts、真实令牌和浏览器运行数据留在本机。
