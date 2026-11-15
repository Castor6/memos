# TASK-20261114-image-preview-and-paste-links：图片预览截断、毛玻璃背景与粘贴自动链接

- 记录日期：2026-11-14（事实截至本次工作，不表示实时进度）
- 模块与关键词：PreviewImageDialog、Dialog、PWA、毛玻璃、Tiptap Link、autolink、marked GFM
- 维护归属：分支 `fix/image-preview-and-paste-links`
- 代码基线：`7d1195bb7`

## 背景与目标

- 电脑 PWA 点击图片预览时，图片上下像被截断；手机 PWA 正常。
- 图片放大预览四周不再用黑色填充。
- 编辑器中粘贴或输入 `example.com`、`foo.md` 这类“像链接”的文本时，会被自动转成链接，保存为 `[example.com](http://example.com)`。期望保持原文，只有 `http://`、`https://` 开头的网址自动成为链接。

## 验收标准

- [x] 桌面宽度下，竖图预览完整显示在顶栏和缩放工具条之间，不被裁切或遮挡。
- [x] 预览背景使用跟随主题的半透明毛玻璃，浅色和深色主题下控件都清晰可见。
- [x] 编辑器只对 http/https 网址自动生成链接；裸域名、文件名、`www.` 主机名、邮箱保持原文。
- [x] 加载已有内容时，`www.example.com`、`a@b.com` 不会被改写成 Markdown 链接。

## 讨论结论

- 背景方案：用户在三个选项（毛玻璃、主题纯色、浅一些的暗色遮罩）中选择“毛玻璃半透明”，跟随当前主题。
- 本环境没有 ImageGen，用户同意跳过设计预览，实现后交付真实截图；并要求 AGENTS.md 改为“没有该工具时不强制设计预览流程”。

## 实现结果

- 截断原因（已测量证实）：`DialogContent` 默认尺寸变体带有 `p-4 sm:p-6`。预览组件传入的 `p-0` 经 tailwind-merge 合并后只去掉了 `p-4`，桌面宽度下 `sm:p-6` 仍然生效，容器四周多出 24px 内边距；图片高度却仍按 `100vh-7rem` 计算。1280×720 下图片高 608px，容器只有 560px，上下各被 `overflow-hidden` 裁掉 24px，底部缩放条还压住了图片。手机宽度低于 `sm` 断点，因此不受影响。
- `web/src/components/PreviewImageDialog.tsx`：
  - 预览层改为 `!inset-0 !h-full !w-full !p-0`，不再依赖 `100vh`。
  - 图片改为 `max-h-full max-w-full`，以容器为准限制尺寸。
  - 桌面底部留白从 `pb-8` 调为 `pb-20`，给缩放条留出位置。
  - video / motion 的 `max-h` 同步改为 `dvh` 并按新留白计算。
  - 背景改为 `bg-background/80 backdrop-blur-xl`；顶栏渐变、按钮、缩放条和翻页按钮改用主题色（`background`、`foreground`、`muted-foreground`、`border`）。
- `web/src/components/ui/dialog.tsx`：`DialogContent` 新增可选 `overlayClassName`。预览传入 `bg-transparent`，避免默认的 `bg-foreground/50` 遮罩把浅色主题压暗。
- `web/src/components/MemoEditor/Editor/markdown-parser.ts`、`index.tsx`：
  - Tiptap Link 设置 `shouldAutoLink: isHttpUrl`，输入自动链接和“选中文字粘贴 URL”两条路径都受它约束。
  - 编辑器改用独立的 `Marked` 实例（覆盖 `url` tokenizer：http(s) 交给默认规则，其他不识别为链接），通过 `Markdown.configure({ marked })` 注入，不改动全局 marked 单例。
  - 为此将已在依赖树中的 `marked@^17.0.6` 加为 web 直接依赖，锁文件只新增 importer 条目。
- AGENTS.md：前端样式流程补充“没有 ImageGen 时不强制第 2、3 步，第 4 步仍需完成”。
- Changeset：`memos-personal` patch。

## 验证事实与边界

- 2026-11-14，本机 Node 24.22.3（官方压缩包，SHA256 已校验，安装在 `~/.local/node`）。本机没有 Go。
- `pnpm lint`、`pnpm build` 通过。
- 新增测试：
  - `tests/editor.test.tsx` 覆盖输入和粘贴时只链接 http(s)，以及加载 `www.example.com a@b.com foo.md` 后 round-trip 不变。修复前该用例输出 `[www.example.com](http://www.example.com) [a@b.com](mailto:a@b.com) foo.md`。
  - `tests/preview-image-dialog.test.tsx` 覆盖图片尺寸类和背景类。
- 页面验证：没有后端，用临时 Vite 测试页渲染真实的 `PreviewImageDialog`（以及 git 基线中的旧版组件作对比），通过 geckodriver 控制 headless Firefox 截图并测量元素位置。测试页已删除，截图保存在忽略目录 `tmp/screenshots/TASK-20261114/`。
  - 1280×720：旧版图片 y=80→688，容器 y=104→664（上下各裁 24px）；新版图片与容器同为 y=80→640，缩放条从 y=654 开始，不重叠。
  - 1440×900 浅色和深色主题、手机布局浅色和深色主题：图片完整显示，不与缩放条重叠，没有常驻侧栏。
  - `backdrop-filter: blur(24px)` 的计算样式已生效，但 headless Firefox 截图不渲染模糊，截图中背景显示为清晰的半透明。

## 未覆盖范围与后续建议

- Firefox 窗口最小宽度约 500px，手机截图实际为 500px 宽（仍低于 `sm` 断点、使用手机布局），没有做到 430px。
- 没有在真实的桌面 PWA（standalone 窗口）、Chrome、Safari 和 iPhone 真机上复核毛玻璃效果和预览显示，需要在设备上确认。
- 编辑器链接行为只在 jsdom 单元测试中用真实 Tiptap 验证，没有在完整运行的应用中手动粘贴验证。
- 阅读视图（remark-gfm）仍会把 `www.`、邮箱显示为可点击链接，只影响展示、不改写原文，本次没有改动。
