# TASK-20260926-registry-source-switch：Memos 受控切换镜像来源

- 记录日期：2026-09-26
- 模块与关键词：部署更新器、ACR、GHCR、镜像来源、恢复
- 维护归属：memos-dual-registry 工作分支的更新器实施会话
- 关联任务：`TASK-20260916-automated-deployment.md`

## 背景与目标

当前服务器更新器仅从配置中的单个仓库拉取 `stable`。用户需要在网页控制入口触发服务器本机命令，在 ACR 与 GHCR 之间手动选择来源，同时保持原有备份、健康检查及恢复事务。

## 验收标准

- [x] 目标来源先拉取并验证；错误、降级、同版本不同内容、失败过的版本和未完成事务不会修改配置。
- [x] 同内容跨仓切换不停止应用或备份数据；更高版本仅选择来源，后续仍由定时器执行升级。
- [x] 配置修改前生成私有备份并原子写入；状态命令不拉取镜像。
- [x] 镜像清理识别两个仓库，并保守保留归属不明镜像。

## 实现结果

更新器支持 `image_repositories`、`retained_image_repositories`，新增 `--switch-channel acr|ghcr`、`--status`。切换使用既有部署锁，以实际运行容器的镜像 ID、版本和提交与候选比较。已部署记录及恢复镜像身份保持原样，配置备份写入状态目录。部署说明与公开配置模板已同步。

## 验证事实与边界

2026-09-26 在独立 worktree 运行 `python3 -m unittest scripts/deploy/test_memos_update.py`，共 20 项，18 项通过、2 项因本机缺少 Linux 工具跳过；包含同内容不重启、网络失败、降级、失败版本、pending、锁占用、配置写入失败及状态只读检查。`git diff --check` 通过。本轮未在生产服务器执行真实切源；现场安装与验证须另行记录。

同日将更新器及对应测试复制到服务器 `/var/tmp` 的独立临时目录，在该目录运行 `python3 -m unittest -v test_memos_update test_sayseed_update`：两项目共 51 项全部通过，Memos 20 项无跳过。测试脚本经审查不会调用生产 Docker 或路径，临时目录在测试后删除；未修改生产配置、镜像或应用。

## 未覆盖范围与后续建议

云助手命令预设、GHCR 当前 `stable` 的就绪状态以及生产切源演练由私有运维流程确认。目标仓库内容虽可通过本地镜像 ID 验证，本地单元测试不能代替实际 Registry 与 Docker 行为。
