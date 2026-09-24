# TASK-20260924-clipper-editor-tab：独立剪藏编辑页

- 记录日期：2026-09-24
- 模块与关键词：Web Clipper、独立标签页、草稿、正文预览、单层滚动
- 维护归属：本会话，工作分支 `feat/clipper-editor-tab`
- 关联任务：[扩展兼容与首次实现](TASK-20260922-web-clipper-compatibility.md)、[标签与 Markdown 预览](TASK-20260922-clipper-tags-preview.md)

## 背景与目标

420×600 弹窗限制思考编辑和正文核对；文本框、折叠预览与外层弹窗形成多层滚动。用户已确认独立编辑页效果稿，要求自有产出优先、标签置于模块顶部，原文和保存预览直接切换，操作栏融入背景。

## 验收标准

- [x] 点击扩展图标打开独立编辑页，绑定原网页；重复打开复用编辑页，打开时不提取正文。
- [x] 我的产出、原内容、保存预览直接切换；保留 Star / Pick up 顺序和语义，无折叠正文与嵌套纵向滚动。
- [x] 标签在我的产出顶部，输入框随内容增高；Enter、Shift + Enter、Ctrl + Enter 均换行，不触发保存。
- [x] 原网页跳转或关闭不丢草稿；继续保留账号隔离、保存重试、附件与原始快照边界。
- [x] 完成扩展 lint、测试、生产构建、打包检查与实际组件界面验证。

## 讨论结论

- 取消弹窗编辑和“展开编辑”中间入口，复用既有连接与持久化协议，不新增权限或依赖。
- 保存只由显式按钮触发；中文输入法确认与标签选择保持原行为。
- 保存预览中的长文直接展示，保存到 Memos 的原有正文结构保持兼容。
- 在隔离 worktree 中开发，保留用户已加载的扩展目录。

## 实现结果

2026-09-24：

- 移除工具栏 popup 声明，由后台串行处理点击并打开独立编辑页。同一来源按既有规范化 URL 复用，包含编辑页仍在加载时的重复点击；重复打开另一窗口的编辑页时激活对应窗口。
- 继续使用 `src/popup/index.html` 可信入口，并显式加入 Vite 构建和 ZIP 完整性检查。未扩大消息信任边界、扩展权限或依赖。
- 通过编辑页 URL 固定原网页身份；提取指定来源标签页，原页关闭或跳转后仍保留可编辑、可保存草稿。重新打开同一网页后可重新提取；提取期间导航不会将另一页面正文写入旧来源。
- 产出、原文、完整预览各自占据阅读区域，产出中标签在顶部；Star 思考优先，Pick up 本人原话只读并在背景思考之前。长文直接展示，编辑框自适应高度，固定保存栏使用页面背景。
- Enter / Shift + Enter 保持原生换行，Ctrl / Cmd + Enter 补充为换行；输入法确认和标签选择不触发笔记保存。标签仅通过 × 移除。
- 保存成功和图片失败信息持续展示，后续按钮明确为「另存一条」；未知保存结果仍沿用持久化请求确认，不能修改待确认正文。
- 添加仅针对 `memos-web-clipper` 的 minor Changeset。

## 验证事实与边界

2026-09-24：

- 基线 `15957f834`，开始时主工作区干净，已安装仓库空白检查钩子。
- Node 24.21.0 / 扩展 pnpm 11.10.0：`corepack pnpm lint` 通过；`corepack pnpm test` 38 文件、446 测试通过；`corepack pnpm build` 包含类型检查、9 语言文案校验、生产构建和无 DOM 的实际后台启动检查，全部通过。
- `python -m unittest discover -v -s scripts -p 'test_package*.py'` 共 25 项，24 通过、1 跳过：Windows 大小写不敏感文件系统无法创建大小写冲突夹具。符号链接拒绝和新增独立编辑页入口打包测试均通过。
- 根 `corepack pnpm check:release origin/main` 通过。额外运行根 `corepack pnpm test` 为 9 通过、4 失败；4 项都因 Windows 的 `execFileSync(node_modules/.bin/changeset)` 返回 ENOENT，不能直接执行无扩展名脚本。此未改动的跨平台工具问题交由 Linux CI 验证，未改动发布工具以扩大本次范围。
- Codex 内置浏览器运行实际 React 组件，使用可丢弃的浏览器 API 和保存响应模拟数据。在 1440×900、430×739、430×932 验证 Star / Pick up、标签位置、原内容编辑、完整预览、草稿恢复与保存反馈；30 行文本和长原文无嵌套纵向滚动、无水平溢出，保存栏没有遮挡末尾内容，窄屏无固定左侧栏。
- 实际浏览器按 Enter、Shift + Enter、Ctrl + Enter 后均插入换行，保存仍需点击按钮；输入法组合态保护另有单元测试。界面日志没有 error，临时视口覆盖已恢复。
- 干净检出运行 `corepack pnpm package:release` 通过，生成 `extensions/web-clipper/artifacts/memos-web-clipper-chromium-v0.1.2.zip` 试用包；沿用当前版本元数据，新版本号仅由后续版本 PR 生成。
- `git diff --check`、`git diff --cached --check` 和 `git diff --check origin/main...HEAD` 通过。

## 未覆盖范围与后续建议

- 尚未替换用户 Chrome / Edge 已加载的扩展，也没有通过真实在线 Memos 创建笔记；工具栏、来源绑定和后台消息通过自动化测试覆盖，组件预览使用模拟浏览器 API，不冒充完整安装验证。
- iPhone / Safari、软件键盘、触控、PWA 与 macOS Cmd 键未做真机检查；窄屏结果仅代表响应式布局。该交付面为 Chromium 扩展。
- 主应用、线上服务、既有原始快照及历史数据无迁移或部署操作。
