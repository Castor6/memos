# TASK-20260926-agentnotes-adoption：使用项目级 AgentNotes 维护任务记录

- 记录日期：2026-09-26（事实截至本次工作，不表示实时进度）
- 模块与关键词：AgentNotes、Skill、任务记录、需求、设计理由、历史检索
- 维护归属：`docs/adopt-agentnotes` 工作分支
- 关联：[AgentNotes 仓库](https://github.com/Castor6/agentnotes)、[任务模板](TEMPLATE.md)、[检索说明](INDEX.md)

## 背景与目标

将 Memos 已实践的 Task 记录方法抽成可复用的 AgentNotes Skill，并在本项目按项目级安装。用户希望保留讨论中确认的需求、设计理由与实际工作结果，以便以后回顾“为什么这样设计”；不增加自动召回 hook、记忆数据库或长期任务看板。

## 验收标准

- [x] 在项目中安装更新后的 AgentNotes Skill。
- [x] 移除项目提示词中重复的通用 Task 流程，保留项目语言、并行 worktree 和私有运维等约束。
- [x] 沿用 `docs/tasks/`、现有历史任务、中文模板及固定检索说明。
- [x] 模板明确记录选择理由和新决定对旧决定、旧假设的替代关系。

## 讨论结论

- 通用记录与回顾方法由 Skill 维护，场景触发信息放在 Skill 摘要中，不要求每个使用者另改项目 `AGENTS.md` 才能采用。
- 项目 `AGENTS.md` 保留 Memos 特有的协作、验证和运维规则；文档导航提供 Skill 入口，不增加强制调用包装。
- 现有目录和文件能继续使用，无需重写历史、生成任务总目录或迁移已有任务。保留中文模板能延续本项目记录语言和阅读习惯。
- 记录关键理由与被替代的决定，便于以后解释设计演变；没有讨论过的理由不补造，未验证的行为不写成已完成事实。

## 实现结果

- 通过 `npx skills add Castor6/agentnotes --skill agentnotes --agent codex --copy --yes` 将 Skill 安装到 `.agents/skills/agentnotes/`，根目录 `skills-lock.json` 记录来源。
- `AGENTS.md` 移除通用的创建、续接、检索、收尾和长期规则提炼流程；保留中文记录要求、并行代码修改使用独立 worktree，以及现有项目规则。
- `docs/README.md` 将重复的记录维护清单收敛为 AgentNotes、模板和检索说明的导航，保留私有运维与微信客服迁移入口。
- `docs/tasks/TEMPLATE.md` 仅扩充讨论结论提示，明确选择理由、重要备选方案和日期化替代关系。
- 现有任务文件和 `INDEX.md` 未修改。

## 验证事实与边界

- 2026-09-26：文档调整基于 `7edeedd325368af10f0b77c48b5290eb6d61aeff` 的工作区。
- 2026-09-26：GitHub 来源安装成功，安装的六个文件与 AgentNotes `446322a` 中的 `skills/agentnotes/` 逐字节一致，锁文件来源为 `Castor6/agentnotes`。
- 2026-09-26：`git diff --check` 通过；变更及新增 Markdown 文件（包括 Skill）行尾空白与本地链接检查通过，安装后的 AgentNotes 入口有效。源 Skill 通过结构验证。
- 本次仅修改文档和 Skill，未运行应用测试；文件一致性检查不证明运行时必然自动触发。

## 未覆盖范围与后续建议

本次不改变应用和扩展行为，不涉及线上部署；Skill 的场景描述支持 Agent 选择使用，但不保证每次对话必然触发。
