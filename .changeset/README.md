# 发布说明

本目录记录尚未发布的应用与浏览器扩展变化。根 workspace 的两个私有包只管理版本，不发布 npm 包：

- `memos-personal`：根目录 `package.json` 与 `CHANGELOG.md`，管理 Memos 版本及 Release。
- `memos-web-clipper`：`extensions/web-clipper/release/package.json` 与同目录 `CHANGELOG.md`，管理独立扩展版本；首个独立正式版为 0.1.0。初始 0.0.1 为 Chromium 可接受的未发布构建占位值，首份 minor changeset 生成 0.1.0。扩展源码包的 0.4.1 保留为上游基线。

在仓库根目录运行 `corepack pnpm changeset`。仅应用变化选择 `memos-personal`；仅扩展交付变化选择 `memos-web-clipper`，两者变化才同时选择两个包。分别按自身变化选择 patch（兼容修复）、minor（兼容功能）或 major（破坏兼容性）。填写面向使用者的中文说明，随功能 PR 提交生成的 Markdown。文档、测试和不改变交付行为的 CI 修改无需 changeset。

机器人在 `changeset-release/main` 维护一个 `Version Packages` PR，分别生成两套版本和日志。普通 PR 不手改发布版本、不消费已有 changeset。仅应用升级不递增扩展版本。仅扩展升级也不递增 Memos 版本。版本 PR 合并后分别按变更组件发布：Memos 使用 `castor-v<应用版本>`，扩展使用 `web-clipper-v<扩展版本>` 独立 Release；仅扩展发布不运行镜像构建、冒烟、ACR 或 stable 更新。详见 [CI 与版本流程](../docs/release.md)。
