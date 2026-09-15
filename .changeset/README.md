# 发布说明

本目录记录尚未发布的应用变化。根目录的私有 `memos-personal` 包只管理整个 Go + Web 应用的版本，不发布到 npm。

在仓库根目录运行 `corepack pnpm changeset`，选择 patch（兼容修复）、minor（兼容功能）或 major（破坏兼容性），填写面向使用者的中文说明，随功能 PR 提交生成的 Markdown 文件。文档、测试和不改变交付行为的 CI 修改无需 changeset。

机器人在 `changeset-release/main` 分支维护一个 `Version Packages` PR，集中更新根目录 `package.json` 和 `CHANGELOG.md`。普通 PR 不手改这两处的发布版本信息。

当前 `0.0.0` 是初始化占位值，`personal-baseline.md` 会生成首个 `0.1.0` 版本 PR。标签约定为 `castor-v<版本号>`，上游基线单独记录。详见 [CI 与版本流程](../docs/release.md)。
