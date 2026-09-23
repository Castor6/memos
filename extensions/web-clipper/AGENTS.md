# Web Clipper 开发约定

- 当前模块用于个人深度定制，先阅读 `README.md` 和 `../../docs/tasks/TASK-20260922-web-clipper-compatibility.md`，交接后续写原任务。
- 这是 Memos 仓库内的独立前端子项目，依赖和锁文件在本目录，不是 Git 子模块；使用本目录固定的 pnpm 版本。
- 在本目录运行 `corepack pnpm install --frozen-lockfile`、`corepack pnpm lint`、`corepack pnpm test`、`corepack pnpm build`。构建需要本地 `.env`，准备方式见 README。
- 日常通过 `dist/` 加载已解压扩展。`package:release` 用 Python 3 标准库生成个人 Chromium ZIP，要求干净检出；manifest 与 ZIP 使用 `release/package.json` 的独立扩展版本；源码 `package.json` 保留上游基线，不手改发布版本。其他 `package*` 保留上游商店逻辑，不自动提交商店。
- 扩展 CI 纳入根 `validate`，运行 lint/test/build、`python -m unittest discover -s scripts -p 'test_package*.py'` 和 ZIP 生成；版本 PR 合并后同一提交的 ZIP 进入 GitHub Release 与 SHA256SUMS。交付行为变化需根目录 Changeset 同时选择 `memos-web-clipper`（扩展升级级别）与 `memos-personal`（配套发行），仅应用变化不升级扩展。
- 实际令牌、浏览器数据、抓取网页、构建产物和 node_modules 不提交。保留现有试用版直到用户切换加载目录。
- Star 是通用网页剪藏，Pick up 是 X 互动留存。弹窗打开不读正文，点击后提取；草稿本地保存，已保存记录以 Memos `Memo.capture` 为准。能力和正文限制从实例 Profile 读取，连接仍复用 URL + PAT。
- 服务端快照仅创建者可见且创建后不可修改；普通正文编辑保留快照。更改保存、幂等或历史行为时同时验证服务端与扩展边界。弹窗以 `tags` + `explicitTags` 保存独立标签，新草稿默认 `star` / `pick up`；旧的未知结果请求保留原正文及标签语义。空间、旧历史迁移与右键结构化同步尚未实现。
- 图片以最终 Markdown 为准，保留原位并去重转存；逐张持久化附件 ID/进度与最终正文，旧 pending 保持原语义。正文只存稳定文件路径；历史私有附件经当前连接授权读取，分享令牌只用于渲染，不入正文。下载限制与失败回退见 README。
