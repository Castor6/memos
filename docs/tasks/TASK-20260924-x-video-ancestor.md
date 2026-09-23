# TASK-20260924-x-video-ancestor：视频上文误拦截与在线预览评估

- 记录日期：2026-09-24
- 模块与关键词：Web Clipper、X、Pick up、placementTracking、视频嵌入
- 维护归属：当前排查会话，工作分支 `fix/x-capture-video-ancestor`
- 关联任务：[扩展兼容与实现记录](TASK-20260922-web-clipper-compatibility.md)

## 背景与目标

用户在本人回复详情页执行 Pick up，页面已显示带视频的上文，但扩展停止提取。只读检查真实 DOM：上文的 `placementTracking` 节点包裹视频播放器，没有 `promotedIndicator`；旧广告判断因此误拦截整帖。

用户明确要求移除广告拦截，并评估不下载视频、在 Memos 中在线预览的可行性；视频预览本轮只评估。

## 验收标准

- [x] 去除 X 帖子提取中的广告判断，保留对话区域、断层与帖子顺序检查。
- [x] 回归覆盖带 placementTracking 的视频上文、当前帖及明确广告标记不再拦截的行为。
- [x] 完成扩展检查，记录视频在线预览所需改动与限制。

## 讨论结论

取消广告过滤是用户选择的行为调整，不代表帖子详情页一定没有广告；未来若夹有符合当前对话顺序条件的推广帖，它也可能被提取。

用户在评估后决定视频不再提取；本次仅交付广告拦截修复，保持视频只保留原帖链接，不新增媒体地址提取或在线播放器。下方嵌入方案仅记录评估结论，不作为后续实施要求。

## 实现结果

删除 `isAdvertisement` 及当前帖、上文中的两处调用；更新中断提示，保留 `hasGap`、解析结果和 ID 顺序约束。补充 3 个视频跟踪容器用例，并将原广告拦截测试改为不再过滤的预期。README 说明新的提取范围；根 Changesets CLI 生成仅针对 `memos-web-clipper` 的 patch 记录。

视频在线预览评估：

- [X 官方帮助](https://help.x.com/en/using-x/how-to-embed-a-post)确认嵌入帖子可以播放视频；[X Publish](https://publish.x.com/)提供嵌入入口。因此保存帖子 URL/ID、用官方嵌入播放具备可行性，不需要把视频作为附件上传至 Memos。
- 现有提取已经保存每条帖子的稳定 URL/ID；`MemoMarkdownRenderer.tsx` 将普通链接交给 Link，`LinkMetadataCard.tsx` 仅展示文字，`constants.ts` 的可信 iframe 列表没有 X。当前粘贴原帖链接或官方含 script 的嵌入代码不会自动获得播放器。
- 建议增加由应用控制的 X 嵌入组件，严格识别 X 帖子 URL/ID，点击后加载官方播放器，并保留原文与跳转链接。不要放开任意笔记脚本。可先用已有帖子链接作为入口，不以媒体直链抓取或新增数据库字段作为前置条件；只对视频显示按钮时再设计媒体类型标记。
- 视频流由浏览器向 X 获取，不由 Memos 下载归档或中转；依赖访问者的网络及 X 的可用性。官方说明受保护帖子不能嵌入；删除、转私密或封禁后媒体不再加载。当前可读取的临时 blob/流地址不适合作为长期保存契约。
- 本轮为文档和代码层面的可行性评估，没有实现播放器或验证这条视频在 Memos 中实际播放。官方 oEmbed 样本请求被网页工具拒绝访问，不能据此断言样本播放成功或失败。

## 验证事实与边界

2026-09-24：

- Chrome 当前页面只读 DOM 核实：上文内跟踪容器包含视频，没有 promotedIndicator；本人回复无此容器。没有将真实 DOM、账号数据或截图写入仓库。
- `corepack pnpm --config.verify-deps-before-run=false lint` 通过；同参数 `test` 共 37 个文件、433 项通过，定向 X 测试 27 项通过。
- 本机 PATH 中裸 `pnpm` 为 12.4.1，Corepack 主命令为模块固定 11.10.0，嵌套脚本版本检查冲突。因此 `corepack pnpm build` 未直接成功；不修改依赖或锁文件，执行其等价步骤 `node scripts/validate-locales.mjs && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build && node scripts/check-worker.mjs`，全部通过。
- `python3 -m unittest discover -s scripts -p 'test_package*.py'` 24 项，23 项通过、1 项跳过。

## 未覆盖范围与后续建议

尚未替换或重载用户浏览器中的已安装扩展，没有写入线上笔记；修复后真实页面提取与 iPhone 播放均需后续验证。没有改 Memos 前端、服务端或部署配置。
