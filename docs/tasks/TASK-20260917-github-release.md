# TASK-20260917-github-release：版本 PR 自动生成 GitHub Release

- 模块与关键词：GitHub Release、版本 PR、发布附件、标签
- 记录日期：2026-09-17（历史事实，不表示实时进度）

## 背景与目标

用户希望合并 Version Packages 后自动生成 GitHub Release。现有流程仅发布测试通过的镜像并保留 30 天 Actions artifacts。

## 验收标准

- [x] 只有可信版本 PR 的镜像测试、发布和产物归档成功后，才运行 Release 发布任务。
- [x] castor-v版本号指向确定的版本 PR 合并提交，更新说明取该版本 CHANGELOG。
- [x] Linux amd64/arm64 二进制、版本元数据、完整日志、许可证、镜像摘要和 SHA256SUMS 上传校验完成后再公开。
- [x] 重试不重复创建、不覆盖已发布附件，不移动冲突标签，不将旧版本标记为最新。
- [x] 只有最终 Release job 获得 contents:write，普通 PR 和构建任务保持只读。
- [x] 不在公开附件暴露私有 Registry 地址；Release 成功不等同于服务器部署成功。

## 验证结果

2026-09-17：13 项镜像/Release 发布测试通过（其中 10 项覆盖公开附件校验、版本说明提取、发布回执、草稿恢复、幂等重试、冲突标签、附件拒绝覆盖、旧版本不降级 Latest、认证/网络错误处理）；根目录 7 项测试、Actionlint、git diff --check 通过。另下载实际 0.2.0 发布运行的构建产物，完整执行公开附件准备：原校验清单、版本/提交、镜像回执均通过，得到预期 7 个附件，未调用发布 API。GitHub CI 运行见 [PR #13](https://github.com/Castor6/memos/pull/13)。本次未发布历史版本，也未验证真实 Release 首发。
