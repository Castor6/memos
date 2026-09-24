# TASK-20260924-clipper-release-editor-validation：独立编辑页发布校验修复

- 记录日期：2026-09-24
- 模块与关键词：Web Clipper、GitHub Release、ZIP、default_popup、独立编辑页
- 维护归属：本会话，工作分支 `fix/clipper-release-editor`
- 关联任务：[独立剪藏编辑页](TASK-20260924-clipper-editor-tab.md)
- 失败证据：[Publish Release 35957506900](https://github.com/Castor6/memos/actions/runs/35957506900)

## 背景与目标

扩展 0.2.0 改为独立标签页，manifest 不再声明 `action.default_popup`。打包已兼容新入口，但发布脚本仍强制要求旧字段，实际 ZIP 在 `stage-web-clipper` 校验时报 `Web clipper manifest mismatch`。用户确认删除旧弹窗的强制要求，同时保留历史包兼容。

## 验收标准

- [x] 已声明 `default_popup` 的旧包仍按该路径校验。
- [x] 未声明该字段的新包检查 `src/popup/index.html`；入口缺失时拒绝发布。
- [x] 保留版本、提交、后台入口、公钥、更新地址与 ZIP 完整性校验。
- [x] 回归覆盖新包准备和发布流程；实际构建包通过发布前校验。

## 讨论结论

- 只修正发布校验及其测试，不恢复产品弹窗、不扩大权限或更改发布触发规则。
- 失败任务绑定已合并版本 PR 的固定提交，重跑不会自动取得新脚本。添加仅针对扩展的 patch Changeset，使修复随下一扩展补丁版本进入可信发布链。

## 实现结果

2026-09-24：

- `verify_web_clipper` 与打包器采用相同入口规则：只有未声明 `default_popup` 时才使用独立编辑页路径；显式声明的错误旧入口仍拒绝。
- 保留旧弹窗测试夹具，并将独立扩展的候选准备、上传中断恢复、版本身份和禁止覆盖测试改用新编辑页包。新增新包接受、新旧入口缺失拒绝、有效编辑页不得替代显式缺失弹窗等回归。
- 发布说明记录两层入口校验必须同步；添加仅选择 `memos-web-clipper` 的 patch Changeset。

## 验证事实与边界

2026-09-24：基于 `d78dd9344` 创建隔离修复分支。使用既有实际独立编辑页 ZIP 已复现旧发布校验报错；该包版本与身份匹配、编辑页入口存在。

- `python -m unittest discover -s scripts -p 'test_publish*.py'`：32 项全部通过，包含新旧入口及独立扩展发布流程回归。
- 修复后的 `verify_web_clipper` 接受此前真实生产构建生成的独立编辑页 ZIP；未修改该 ZIP 内容。
- 重新运行扩展 `corepack pnpm build`（类型、文案、生产构建与后台启动检查）通过；干净检出打包后的实际 0.2.0 ZIP 连续通过 `stage_web_clipper` 和 `prepare(..., component='web-clipper')`，包含身份、入口及候选校验和复核。该包仅为本地验证产物。
- `corepack pnpm check:release` 通过。根 `corepack pnpm test` 为 9 通过、4 因 Windows 无法通过 `execFileSync` 执行无扩展名 Changesets 脚本而失败；与上次已确认的环境限制相同，根测试需通过 Linux CI 验证。

## 未覆盖范围与后续建议

本次验证不向 GitHub 创建正式 Release、不替换已安装扩展；通过检查不等于正式版本已发布。
