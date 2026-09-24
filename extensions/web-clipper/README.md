# Castor Web Clipper

Memos 定制版的浏览器剪藏子项目。Star 剪藏通用网页，Pick up 留存 X 互动；源码、测试和独立依赖均在当前目录，不是 Git 子模块。

先阅读 [现有任务记录](../../docs/tasks/TASK-20260922-web-clipper-compatibility.md)。后续会话继续维护该记录，已有试用反馈和正文超限优化项都在其中。

## 当前来源与改动

- 上游：[usememos/web-clipper](https://github.com/usememos/web-clipper)，标签 `v0.4.1`，提交 `3aa66d718313bb9b971901453eb12d1a10fc2764`。
- 上游说明保存在 [UPSTREAM_README.md](UPSTREAM_README.md)，上游 CHANGELOG 和设计说明保留供参考。
- `src/lib/versions.ts` 保留 Memos `0.7.0` / `v0.7.0` 兼容例外；具备 `webClipperSupported` 的定制服务器可通过能力声明支持独立版本号和本地 dev。
- `manifest.config.ts` 标记为 `Memos Web Clipper - Castor Trial`，与此前交付的试用包名称一致。
- 未引入上游独立仓库的工作流或 release-please；扩展检查接入 Memos 的 `validate`，个人发行 ZIP 通过独立的 `web-clipper-v<版本>` GitHub Release 提供。
- 沿用上游连接方式，补充与 Memos 主站相同的 Markdown 渲染依赖；没有增加登录系统、OCR 或空间选择器。

## Star 与 Pick up

- 点击工具栏图标直接打开独立剪藏标签页，同一来源重复打开时复用编辑页。打开不提取正文，点击 **Star** 后剪藏原网页；有选中文字时优先选区，否则尝试提取正文。X 帖子详情使用专用提取器，保留短帖。提取失败明确说明当前只有选区、摘要或链接。
- 编辑页依次提供「我的产出」「原内容」「保存预览」三个视图，标签放在我的产出顶部；原文和完整预览直接展示。输入框随内容增高，整页只有一层纵向滚动，底部保存栏融入页面背景。Enter、Shift + Enter、Ctrl + Enter（macOS 也支持 Cmd + Enter）均换行，点击保存按钮提交；标签输入的 Enter 仍用于选择或创建标签，输入法选字仍用于确认文字。
- Star 将「我的思考」放在「原内容」之前。可编辑原内容；长来源在保存的 Markdown 中使用 `details` 折叠，不自动截断。
- **Pick up** 用于 X 回复或引用帖详情，自动取得当前帖与页面已加载的必要上文。保存「Pick up → Context & thinking（可选）→ What they put down」，保留作者、时间、来源与原始互动快照。本人原话只读，Context & thinking 记录形成评论之前的背景、线索与思考过程。
- 新草稿默认加入独立标签 `star` 或 `pick up`；「添加标签」可搜索当前个人空间的已有标签、创建新标签或移除已选标签，支持键盘操作。标签随草稿恢复，重新提取保留选择。保存使用 Memos 独立标签，不把剪藏原文中的 `#文字` 自动变成标签；旧右键保存沿用旧流程。
- 「保存预览」渲染 Markdown 标题、列表、引用、代码、表格和图片，编辑页中的长文全部展开；历史正文使用同一预览组件并保留原有折叠行为。不可信 HTML 经清理后显示。已保存笔记不会因模板改名被批量改写；旧的未知结果保存请求仍按原正文重试。
- 页面能识别登录用户时自动核对作者；无法确认时需要勾选本人声明，明确识别为他人时拒绝 Pick up。服务端仅验证快照一致性，不绑定或证明 X 账号身份。
- X 对话可能未完整加载；需核对预览，展开原网页的折叠内容后重新提取。视频只保留链接；已识别图片保留在对应帖文之后。
- X 提取不按广告标记过滤帖子，避免视频播放器的跟踪容器误伤正常上文；仍检查对话区域、折叠断层与帖子顺序。若详情页夹有推广帖，也可能被纳入上文，保存前需核对。
- 本期不包含 Linux.do 互动适配、微信评论图、二维码或 OCR。

## 图片归档

全文、选区和 X 统一保留图片在 Markdown 中的位置，保存时将最终正文引用的图片下载转存为 Memos 附件，再将原地址替换为稳定的 `/file/attachments/…` 路径。同一 URL 在一次剪藏中只上传一份，文内所有位置共享；在编辑区删除的图片不再上传。懒加载和相对地址在提取时实化，微信公众号保留原始格式与 URL 参数，不强制改成 PNG。

转存失败的图片保留原链接，文字继续保存，编辑页直接列出失败地址和原因。外链能否继续显示取决于原站。每次最多转存 100 个不同来源，单图最大 10 MiB、下载超时 8 秒；只转存可安全处理的 HTTPS/内嵌位图，不发送原站登录凭据，不跟随下载重定向。未支持或超限图片同样保留链接并提示。保存大小先按转存后预计正文检查，最终仍按实际正文校验服务器限制。

图片上传使用稳定 ID 并逐张记录进度；未知上传结果先查询再继续，笔记重试核对替换后的正文，避免重复创建。升级前未确认的保存仍使用原请求；旧草稿只有独立图片列表时，将缺少的图片补到原内容末尾，可重新提取恢复原位置。已保存笔记不会自动补图或重写。

历史预览通过当前连接读取私有附件，不依赖 Memos 网页登录 cookie；匿名分享使用该笔记已有的分享授权显示内联图片。PAT 和分享令牌均不写入保存正文。

## 保存、草稿与同步

直接连接继续填写 **Memos 地址 + PAT**。新版本服务端必须声明 `webClipperSupported`；扩展先检查能力和实际正文 UTF-8 字节上限，旧服务器不会被当作已完成同步。现有默认上限 8 KiB 保持不变，可在 Memos 原有实例设置中调整。

Star / Pick up 的来源、类型、思考或评论、背景和 X 帖子快照随笔记同次写入 `Memo.capture`。历史和「已保存」提示读取服务器，另一浏览器用同一用户的 PAT 可恢复；不同 PAT 不影响归属。当前扩展使用默认个人空间，服务端仍按用户和空间隔离。

普通正文编辑保留首次互动快照；历史展示服务器当前正文，归档和删除状态按服务器读取。快照仅创建者可读，笔记正文仍服从用户选择的可见性。草稿按实例、用户、页面和模式保存在本机，不跨设备同步；关闭重开可恢复。未知保存结果使用持久化请求 ID 重试，确认成功后的再次保存才使用新 ID。

编辑页固定绑定打开时的来源，即使原网页跳转或关闭，仍能编辑、预览和保存已有草稿；重新提取必须先打开原网页。关闭编辑页后，再从相同来源点击扩展图标，会恢复对应草稿。保存成功提示持续显示，再次保存明确标为「另存一条」。未知保存结果先确认原请求，不能修改未确认的正文。

右键「快速保存选区/图片」同样将图片转存并放入正文，仍不包含思考编辑或结构化记录同步，也不具备编辑页的持久化操作恢复。旧本地历史不自动迁移成云记录，原有笔记仍留在 Memos。回滚到不认识 `capture` 的旧服务端后编辑笔记可能丢失新快照字段，回滚前应保留数据库备份。

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

`build` 同时运行生产后台启动检查：在没有 DOM、禁止联网的环境中加载实际 Service Worker 及其共享模块，验证连接状态消息可以返回，避免页面专用依赖导致安装后后台启动失败。已有 `dist/` 可单独运行 `corepack pnpm check:worker`。设置页等待连接状态超过 30 秒时会显示扩展错误，并提供重新检查入口。

保留官方 Chromium key，扩展 ID 仍为 `nebaoebnljalfegiidibihhkebeiklbl`。切换到新 dist 时停用此前加载的试用目录或官方扩展，避免同一 ID 的不同副本冲突。旧试用目录 `../../tmp/web-clipper-trial/extension/` 仍保留，本次迁移不会自动更新浏览器已加载的副本。

## GitHub Release 安装包

包含扩展版本升级的版本 PR 合并后，`web-clipper-v<扩展版本>` GitHub Release 提供 `memos-web-clipper-chromium-v<版本>.zip`，Chrome 与 Edge 共用。下载 ZIP 并解压到固定目录，在扩展管理页开启开发者模式，选择「加载已解压的扩展程序」，选中含 `manifest.json` 的目录。它不是 CRX，也不会通过浏览器商店自动更新；更新时替换解压目录中的文件，再点击重新加载。切换目录前停用旧副本，保留原目录直到确认连接、草稿和历史正常。

扩展独立版本由 `release/package.json` 的私有 `memos-web-clipper` 包管理，首个独立正式版为 0.1.0；只有扩展交付内容变化才通过 Changesets 递增，修复选 patch、新功能选 minor、破坏兼容性选 major。Memos 单独更新不会递增扩展版本。初始 0.0.1 是未发布的构建占位值（Chromium 不允许全零版本），首份 minor changeset 生成正式 0.1.0。本地 `dist/` 与 ZIP manifest 均使用该版本；源码 `package.json` 的 `0.4.1` 继续表示上游基线。`castor-release.json.version` 是扩展版本，`tag` 是扩展自身的 Release 标签，`commit` 是本次构建提交。Memos 与扩展共用 Version PR，但独立发布。只改扩展不会升级 Memos，也不会构建/推送镜像或更新 stable；只改 Memos 不重新发布扩展。同一扩展标签固定到一个提交，重试核对校验和，禁止覆盖不同内容；扩展 Release 不抢占 Memos 的 Latest。Release 的 `release.json` 列出配套 ZIP，`SHA256SUMS` 包含其校验和。安装扩展不等于服务器已升级，Star / Pick up 保存仍要求连接的实例声明对应能力。

从干净的源码检出构建个人 ZIP（需要 Python 3）：

```powershell
corepack pnpm package:release
```

输出在 `artifacts/`。已有构建也可在仓库根目录执行 `python extensions/web-clipper/scripts/package-release.py --output build/candidate`。打包保留 Chromium key、去除 `update_url`，不改源码版本；拒绝未提交改动、开发服务器构建或不完整产物。

`package` / `package:chrome` / `package:edge` / `package:firefox` 继续保留上游商店打包逻辑，另需 zip 等工具。本项目 Release 只提供个人 Chromium 包，不自动提交商店或发布 Firefox 签名包，也不为历史 Release 补发扩展。普通 PR 的扩展 CI 会提供短期 Actions artifact，供试用，不视为正式版本。

## 后续维护

继续维护关联任务中的实际验证与未覆盖范围。扩展修改触发独立 lint、单测、Python 打包测试、构建和 ZIP 生成，纳入根仓库 `validate`；版本 PR 与工作流修改也运行该检查。扩展交付行为变化需在根目录运行 `corepack pnpm changeset`，只选择 `memos-web-clipper`；仅应用变化选择 `memos-personal`，两者变化才同时选择。机器人分别生成根目录与 `release/` 下的版本和 CHANGELOG，普通 PR 不手改。不要把检查通过当作扩展商店发布或服务器部署完成。新增界面文案以个人使用的中文为主，上游设置与通用文案仍沿用语言配置。

源码、测试、公共配置示例受版本控制；node_modules、.env、dist、artifacts、真实令牌和浏览器运行数据留在本机。
