# Castor Web Clipper

Memos 定制版的浏览器剪藏子项目，用于后续个人深度定制。源码、测试和独立依赖均在当前目录；不需要旧 worktree，也不是 Git 子模块。

先阅读 [现有任务记录](../../docs/tasks/TASK-20260922-web-clipper-compatibility.md)。后续会话继续维护该记录，已有试用反馈和正文超限优化项都在其中。

## 当前来源与改动

- 上游：[usememos/web-clipper](https://github.com/usememos/web-clipper)，标签 `v0.4.1`，提交 `3aa66d718313bb9b971901453eb12d1a10fc2764`。
- 上游说明保存在 [UPSTREAM_README.md](UPSTREAM_README.md)，上游 CHANGELOG 和设计说明保留供参考。
- `src/lib/versions.ts` 额外接受 Memos `0.7.0` / `v0.7.0`；相关边界测试已加入，未放开其他旧版本或 dev。
- `manifest.config.ts` 标记为 `Memos Web Clipper - Castor Trial`，与此前交付的试用包名称一致。
- 没有引入上游独立仓库的 GitHub 工作流或 release-please 配置，也未接入 Memos 服务端发布。
- 保留上游依赖、锁文件、接口和认证行为，未添加空间、独立标签或正文超限提示功能。

## 本地开发与验证

以下命令都在 `extensions/web-clipper` 运行。使用本目录固定的 pnpm 11.10.0，和仓库根目录的版本工具独立。此次已验证 Node 22.23.1；项目声明 Node >=20.9.0。

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

`package*` 命令及 `scripts/package.mjs` 保留的是上游商店打包逻辑，要求独立 Git 根目录、干净源码和 zip 等工具，尚未适配当前仓库；目前使用上述 build + 加载 dist 的流程。

## 下一会话接手

1. 阅读关联任务，了解短文字已由用户验证可保存、全文遇到 8 KiB 上限的事实。
2. 按用户偏好继续个人定制；优先明确正文超限错误并在保存前计算 UTF-8 大小。
3. 空间选择、独立标签、交互和页面提取体验按后续实际需求推进。
4. 保持独立依赖和构建；当前尚未为此子项目配置根仓库自动 CI，不要把本地验证当作 CI 或发布完成。

源码、测试、公共配置示例受版本控制；node_modules、.env、dist、artifacts、真实令牌和浏览器运行数据留在本机。
