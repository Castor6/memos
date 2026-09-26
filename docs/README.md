# 个人 Fork：协作与开发入口

以官方 `v0.30.0` 为源码基线，在 `main` 维护个人定制，按需吸收 `upstream` 的修复或功能。

## 按需导航

| 现在要做什么 | 去哪里 |
| --- | --- |
| 查找某个需求、问题或历史结论 | 按[检索说明](tasks/INDEX.md)搜索任务文件，只打开相关详情 |
| 记录需求、设计理由或工作结果 | [AgentNotes](../.agents/skills/agentnotes/SKILL.md)、[任务模板](tasks/TEMPLATE.md) |
| 启动本地应用、准备数据或验证修改 | [本地开发与验证](development.md) |
| 提交发布说明、了解 CI 和版本 PR | [CI 与版本流程](release.md) |
| 了解上游基线、个人差异、发布和部署方案 | [定制与部署记录](customization-and-deployment.zh-CN.md) |
| 配置微信客服或从旧服务迁移 | [内置接入方案](wechat-kf-integration.md)、[迁移任务](tasks/TASK-20260919-wechat-kf-integration.md) |
| 了解链接预览是否重新抓取及后台重试规则 | [链接预览缓存与后台处理](link-previews.md) |
| 查看长期协作和代码规则 | [AGENTS.md](../AGENTS.md) |

## Task 记录

项目级安装的 [AgentNotes](../.agents/skills/agentnotes/SKILL.md) 说明需求、设计理由、实现与验证事实的记录和回顾方法。记录继续使用现有 `docs/tasks/`、中文[任务模板](tasks/TEMPLATE.md)和固定[检索说明](tasks/INDEX.md)，历史任务保留原文件。

真实部署地址、凭据、笔记、备份及运维详情继续放在独立的私有维护目录；维护入口见 [AGENTS.md](../AGENTS.md)。

## 微信客服内置迁移

用户已选择把微信客服做成 Memos 的 Go 内置模块。主方案、功能实现和后续 Task 归入本仓库；开通、需求和原任务已归档到 `docs/wechat-kf/legacy`；`~/Code/wechat-kf-memos` 保留 Python 代码作为历史参照。迁移期的配套任务和 PR 互引，不继续建设两套长期同步的产品。详见[迁移任务](tasks/TASK-20260919-wechat-kf-integration.md)。
