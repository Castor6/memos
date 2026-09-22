# Web Clipper 开发约定

- 当前模块用于个人深度定制，先阅读 `README.md` 和 `../../docs/tasks/TASK-20260922-web-clipper-compatibility.md`，交接后续写原任务。
- 这是 Memos 仓库内的独立前端子项目，依赖和锁文件在本目录，不是 Git 子模块；使用本目录固定的 pnpm 版本。
- 在本目录运行 `corepack pnpm install --frozen-lockfile`、`corepack pnpm lint`、`corepack pnpm test`、`corepack pnpm build`。构建需要本地 `.env`，准备方式见 README。
- 日常通过 `dist/` 加载已解压扩展。`package:release` 用 Python 3 标准库生成个人 Chromium ZIP，要求干净检出；包内版本跟随根 Memos 版本，不手改扩展源码版本。其他 `package*` 保留上游商店逻辑，不自动提交商店。
- 扩展 CI 纳入根 `validate`，运行 lint/test/build、`python -m unittest discover -s scripts -p 'test_package*.py'` 和 ZIP 生成；版本 PR 合并后同一提交的 ZIP 进入 GitHub Release 与 SHA256SUMS。交付行为变化需根目录 Changeset。
- 实际令牌、浏览器数据、抓取网页、构建产物和 node_modules 不提交。保留现有试用版直到用户切换加载目录。
- Star 是通用网页剪藏，Pick up 是 X 互动留存。弹窗打开不读正文，点击后提取；草稿本地保存，已保存记录以 Memos `Memo.capture` 为准。能力和正文限制从实例 Profile 读取，连接仍复用 URL + PAT。
- 服务端快照仅创建者可见且创建后不可修改；普通正文编辑保留快照。更改保存、幂等或历史行为时同时验证服务端与扩展边界。空间、独立标签选择、旧历史迁移与右键快速保存改造尚未实现。
