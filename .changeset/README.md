# 发布说明

本目录记录尚未发布的应用与浏览器扩展变化。根 workspace 的两个私有包只管理版本，不发布 npm 包：

- `memos-personal`：根目录 `package.json` 与 `CHANGELOG.md`，管理 Memos 及统一 Release。
- `memos-web-clipper`：`extensions/web-clipper/release/package.json` 与同目录 `CHANGELOG.md`，管理独立扩展版本；从 0.8.2 衔接。扩展源码包的 0.4.1 保留为上游基线。

在仓库根目录运行 `corepack pnpm changeset`。仅应用变化选择 `memos-personal`；扩展交付变化同时选择两个包，扩展按自身变化选择 patch（兼容修复）、minor（兼容功能）或 major（破坏兼容性），应用记录配套发行（仅扩展变化可选 patch）。填写面向使用者的中文说明，随功能 PR 提交生成的 Markdown。文档、测试和不改变交付行为的 CI 修改无需 changeset。

机器人在 `changeset-release/main` 维护一个 `Version Packages` PR，分别生成两套版本和日志。普通 PR 不手改发布版本、不消费已有 changeset。仅应用升级不递增扩展版本。扩展仍随 `castor-v<应用版本>` Release 交付，ZIP 名称和 manifest 使用扩展版本。详见 [CI 与版本流程](../docs/release.md)。
