# 本地开发与验证

面向个人 Fork 的 macOS/Linux 开发环境。入口为 `scripts/dev.sh`，辅助程序只使用 Python 标准库。

## 第一次准备

需要 Git、Go、Python 3.9+、Node 24 和 Corepack。项目用 `.node-version` 指定 Node 24，用 `web/package.json` 固定 pnpm；Go 按 `go.mod` 的工具链要求运行。

```bash
./scripts/dev.sh setup
```

当前 Node 不是 24 且本机已有 fnm 时，`setup` 会安装/选择 Node 24；选择只作用于该命令，不修改全局默认版本。其他电脑也可自行准备 Node 24 与 Corepack 后运行。Corepack 按项目要求调用 pnpm，前端依赖使用 `--frozen-lockfile` 安装；服务器 PDF 排版组件通过 `npm ci --ignore-scripts` 安装到 `scripts/pdf/node_modules`。

## 提交前空白检查

`setup` 会安装仓库维护的 pre-commit 钩子；已准备好的环境可单独运行：

```bash
./scripts/install-git-hooks.sh
```

安装到本机 Git hooks 目录，当前仓库及其 worktree 共享；新克隆需要重新安装。重复安装会更新本仓库维护的钩子，遇到自定义 `core.hooksPath` 或已有自定义 pre-commit 时停止且不覆盖，请在自己的钩子中接入 `git diff --cached --check`。

钩子只检查暂存区，不修改文件、不自动暂存。报错后修正对应内容，重新 `git add` 再提交；部分暂存时，工作区已修正不代表暂存区已修正。`.editorconfig` 为支持它的编辑器提供末尾换行与行尾空白设置，Markdown 保留双空格换行；它不能保证删除文件末尾的额外空行，最终由 Git 检查兜底。

代码、文档、任务记录全部更新后执行 `git diff --cached --check`，推送前执行 `git diff --check origin/main...HEAD`，覆盖此前提交引入的空白问题。CI 门禁保持不变。

## 启动与停止

```bash
./scripts/dev.sh start
```

- 页面：<http://127.0.0.1:3001>；API：`http://127.0.0.1:8081`。
- 前后端只监听 `127.0.0.1`；端口被占用时直接报错，不自动改端口或终止其他进程。
- 本地账号：`local-dev`；密码：`local-dev-only-2026`。这是公开、可丢弃测试环境的固定凭据。
- 独立数据：`tmp/local-dev/data/`。首次启动通过现有 API 创建账号、中文偏好、4 条私有笔记和 1 张图片，覆盖标签、Markdown、长文本和附件。
- 后续启动复用测试数据，保留手动编辑；不会重复添加样例。初始化中断时按固定资源 ID 续跑。
- 日志：`tmp/local-dev/logs/backend.log` 与 `frontend.log`；每次启动覆盖日志，排查时先留存相关片段。
- 在运行终端按 **Ctrl-C** 停止两个服务。前端热更新；修改 Go 代码后停止并重新启动，启动时会重新构建后端。
- 重置数据库后，浏览器原会话会失效，使用同一个测试账号重新登录即可。
- 启动命令移除继承的 `MEMOS_*` 环境变量，并显式指定本地数据目录、SQLite 和私有实例配置。

## 重置测试数据

停止服务后执行：

```bash
./scripts/dev.sh reset
./scripts/dev.sh start
```

`reset` 把测试数据目录移到 `tmp/local-dev/data-before-reset-*`，下次启动重新初始化。运行中重置会被锁拒绝。该命令没有自定义数据路径参数，不接受线上目录；旧测试数据不会直接删除。

`tmp/` 已被 Git 忽略，里面的数据库、附件、日志、构建产物、截图与重置前数据均留在本机。共享源码后，需要在另一台电脑重新执行 setup/start。

## 自动检查

```bash
./scripts/dev.sh check frontend  # TypeScript/Biome、Vitest、前端构建
./scripts/dev.sh check backend   # PDF 排版测试、server/internal race tests、SQLite store tests
./scripts/dev.sh check           # 上述两组检查及 git diff --check
```

迭代中先执行改动范围内的最小检查，结束前遵循 `AGENTS.md` 的 Change Routing。
这里的后端入口覆盖本地 SQLite；数据库结构/驱动改动仍需运行 `go test -v ./store/...` 检查全部驱动，需要 Docker/TestContainers。
发布前的容器与升级检查沿用 `scripts/release_smoke_test.sh`，应明确指定实际线上版本作为升级来源。本地页面检查不代表镜像或线上版本已经验证。

## 内置浏览器验收

默认使用 Codex 内置浏览器打开本地页面，登录上述测试账号；日常验证无需连接常用 Chrome。

1. 按本次任务的验收标准操作页面，检查实际渲染、保存结果和刷新后的数据。
2. 涉及布局时检查桌面 **1440×900**，以及用户 iPhone 15 Pro Max 对应的 **430 像素宽度**：**430×739** 检查较短的浏览器可视区，**430×932** 补充全高布局。必要时再检查断点附近尺寸。
3. 检查菜单、弹窗、文字换行、水平溢出、遮挡及相关附件显示。按需保留截图到 `tmp/local-dev/evidence/`。
4. 检查相关控制台错误，并在任务记录中写明视口、操作、结果和未覆盖项。
5. 结束后恢复视口覆盖；需要用户继续查看的预览标签保留。

手机窄屏检查只证明相应尺寸下的布局和可操作行为。涉及 iPhone/Safari、真实软键盘、触摸、PWA 时另记真机验收；常用 Chrome 的插件、缓存或既有登录状态问题再使用对应浏览器。

手机默认布局：顶部在 Logo 右侧以固定 16px 间距提供笔记、待办两个图标 Tab，左上角打开原导航抽屉（含探索、附件、通知及用户菜单），右侧保留笔记筛选入口；左侧常驻导航栏及日历/标签栏隐藏，内容占据可用宽度。检查各导航的选中状态、用户菜单以及筛选抽屉的打开和关闭。当前代码的导航栏断点是 640px，日历/标签栏断点是 768px，430px 下均应隐藏。

尺寸参考 [Playwright 官方设备参数](https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json)：iPhone 15 Pro Max 的逻辑屏幕为 430×932，其浏览器视口预设为 430×739。真实网页高度会随浏览器工具栏、状态栏、安全区和使用模式变化。内置浏览器这里只调整视口，不等同于模拟 iOS、触摸或设备像素比。

交付手机布局验证时展示手机尺寸截图并标明尺寸；桌面截图单独标注，避免混淆。

## 完成标准

交付说明包含：改动结果、预览入口、实际检查及其结论、未覆盖事项、任务记录和部署状态。
当前脚本为本地开发工具，不承担云端发布、自动备份或证书维护。

## 服务器 PDF 导出

笔记菜单的「导出 → PDF」请求服务器，以已保存的完整正文生成 PDF。页面显示生成状态，完成后自动下载，不再打开预览弹窗。中文字体随服务器发布，浏览器不请求字体文件；PDF 仅嵌入用到的字形，文字保持可选择。图片按正文顺序嵌入，非图片附件和引用保留为链接，不追加旧附件区。

Go 负责权限检查、Markdown 转换和读取图片，每次调用独立 Node 进程用 pdfmake 排版。普通导出复用笔记及附件访问检查；分享导出复用有效分享授权，只能读取该笔记关联的附件。远程图片沿用外链 SSRF 限制，排版进程禁止读取其他本地文件或访问网络。任何正文图片读取失败都返回可重试错误，不生成缺图文件。

运行镜像内置 Node 22 和 `scripts/pdf`（Node 22 Alpine 官方镜像仍支持 arm/v7；本地 Node 24 也可运行）。裸二进制部署需另外安装 Node >=22.13，并将整个排版目录放到二进制旁的 `pdf/`，在该目录运行 `npm ci --omit=dev --ignore-scripts`；也可通过 `MEMOS_PDF_RENDERER` 指定 `render.mjs` 的绝对路径。目录必须包含 `fonts/` 和 `node_modules/`。本地从仓库根目录启动时自动使用 `scripts/pdf/render.mjs`。

当前限制：一次排版最多 60 秒，含队列及图片准备总计 90 秒；每张源图 16 MiB、5 千万像素，转换图片合计 32 MiB；超大图片缩至最长边 4096 像素。支持常见位图（PNG/JPEG/GIF/WebP/BMP/TIFF），动画导出静态帧；不执行脚本、不渲染网页或 SVG。相对链接优先使用实例地址，私有实例未设置地址时使用浏览器传入的页面源地址。

```bash
npm test --prefix scripts/pdf
```

前端 CI 同时运行排版单元测试；镜像新安装及升级冒烟测试实际调用导出接口检查 PDF 返回，以覆盖 Node、字体及依赖打包。
