# Web Clipper 开发约定

- 当前模块用于个人深度定制，先阅读 `README.md` 和 `../../docs/tasks/TASK-20260922-web-clipper-compatibility.md`，交接后续写原任务。
- 这是 Memos 仓库内的独立前端子项目，依赖和锁文件在本目录，不是 Git 子模块；使用本目录固定的 pnpm 版本。
- 在本目录运行 `corepack pnpm install --frozen-lockfile`、`corepack pnpm lint`、`corepack pnpm test`、`corepack pnpm build`。构建需要本地 `.env`，准备方式见 README。
- 日常通过 `dist/` 加载已解压扩展。`package*` 是上游商店发布脚本，尚未适配当前仓库结构；当前不接入商店发布或 Memos 发布流程。
- 实际令牌、浏览器数据、抓取网页、构建产物和 node_modules 不提交。保留现有试用版直到用户切换加载目录。
- 当前只增加 Memos 0.7.0 版本校验例外及试用名称；空间、独立标签、正文超限提示属于后续定制，不能当作已经实现。
