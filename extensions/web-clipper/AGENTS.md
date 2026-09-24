# Web Clipper 开发约定

- 当前模块用于个人深度定制，先阅读 `README.md` 和 `../../docs/tasks/TASK-20260922-web-clipper-compatibility.md`，交接后续写原任务。
- 这是 Memos 仓库内的独立前端子项目，依赖和锁文件在本目录，不是 Git 子模块；使用本目录固定的 pnpm 版本。
- 在本目录运行 `corepack pnpm install --frozen-lockfile`、`corepack pnpm lint`、`corepack pnpm test`、`corepack pnpm build`。构建需要本地 `.env`，准备方式见 README。
- 日常通过 `dist/` 加载已解压扩展。`package:release` 用 Python 3 标准库生成个人 Chromium ZIP，要求干净检出；manifest 与 ZIP 使用 `release/package.json` 的独立扩展版本；源码 `package.json` 保留上游基线，不手改发布版本。其他 `package*` 保留上游商店逻辑，不自动提交商店。
- 扩展 CI 纳入根 `validate`，运行 lint/test/build、`python -m unittest discover -s scripts -p 'test_package*.py'` 和 ZIP 生成；版本 PR 中扩展版本变化时，ZIP 发布到 `web-clipper-v<版本>` 独立 Release 并提供 SHA256SUMS，不更改仓库 Latest。交付变化的根 Changeset 只选择 `memos-web-clipper`；仅同时改变 Memos 时再选择 `memos-personal`。仅扩展变化不运行 Memos 构建或镜像发布。
- 实际令牌、浏览器数据、抓取网页、构建产物和 node_modules 不提交。保留现有试用版直到用户切换加载目录。
- Star 是通用网页剪藏，Pick up 是 X 互动留存。工具栏图标打开独立编辑页，按来源 URL 复用，打开不读正文，点击 Star / Pick up 后提取。编辑页固定原网页身份，不能按当前活动标签页提取；原页关闭或跳转仍保留草稿。能力和正文限制从实例 Profile 读取，连接仍复用 URL + PAT。
- 编辑页自有产出优先，标签置于产出模块顶部；原内容和保存预览直接切换，正文展开、输入框随内容增高，只有页面纵向滚动。Enter、Shift + Enter、Ctrl + Enter 均换行，按钮保存；输入法确认与标签选择维持原行为。页面继续使用既有可信路径 `src/popup/index.html`，构建与打包必须包含该入口。界面任务见 `../../docs/tasks/TASK-20260924-clipper-editor-tab.md`。
- 服务端快照仅创建者可见且创建后不可修改；普通正文编辑保留快照。更改保存、幂等或历史行为时同时验证服务端与扩展边界。编辑页以 `tags` + `explicitTags` 保存独立标签，新草稿默认 `star` / `pick up`；旧的未知结果请求保留原正文及标签语义。空间、旧历史迁移与右键结构化同步尚未实现。
- 图片以最终 Markdown 为准，保留原位并去重转存；逐张持久化附件 ID/进度与最终正文，旧 pending 保持原语义。正文只存稳定文件路径；历史私有附件经当前连接授权读取，分享令牌只用于渲染，不入正文。下载限制与失败回退见 README。
