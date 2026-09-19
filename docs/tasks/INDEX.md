# 任务检索

任务以独立 Markdown 文件保存。本页只提供固定检索说明，不逐项列出任务；新增或续接任务无需修改本页。

从仓库根目录运行：

```bash
# 按文件名定位任务（包含子目录中的历史记录）
rg --files docs/tasks -g 'TASK-*.md'

# 按任务编号定位
rg --files docs/tasks -g '*wechat-kf-integration*'

# 按标题、模块或正文关键词筛选文件，再打开相关详情
rg -l '图片|导出' docs/tasks -g 'TASK-*.md'

# 查看相关事实所在行
rg -n '验收|未覆盖' docs/tasks/TASK-20260919-task-record-search.md
```

旧微信客服记录仅在相关时搜索 `docs/wechat-kf/legacy/tasks/`。已有历史目录保留，不要求批量整理或重建索引。

新增记录使用[模板](TEMPLATE.md)，文件名为 `TASK-YYYYMMDD-短主题.md`，标题和模块关键词应便于检索。单个任务文件由一个会话负责维护；其他会话独立开展的工作另建文件并通过相对链接关联，交接后可继续原文件。

如需浏览总目录，可按需生成本地结果，不提交生成的目录文件。记录范围与协作约定见[开发入口](../README.md)。
