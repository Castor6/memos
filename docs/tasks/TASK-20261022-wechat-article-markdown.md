# TASK-20261022-wechat-article-markdown：公众号文章转 Markdown 回传方案

- 记录日期：2026-10-22
- 模块与关键词：微信客服、公众号卡片、正文提取、Markdown、文件回传
- 维护归属：当前会话；后续修正分支 `fix/wechat-markdown-source`（初始实现分支为 `feat/wechat-article-markdown`）
- 调查基线：`main` 的 `b8f7aea00`；文档使用独立 worktree。
- 关联文档：[内置微信客服](../wechat-kf-integration.md)、[内置主任务](TASK-20260919-wechat-kf-integration.md)、[公众号链接预览](TASK-20260919-wechat-link-preview.md)

## 用户需求与本轮范围

用户最初要求先讨论公众号文章卡片转 Markdown 的方案；后续确认成功直接回传 MD、失败说明原因，并批准参考解析规则、以纯 Go 实现。下文按时间保留调研与选择过程，最终实施范围和验证见文末。

## 现有代码事实

- `internal/wechatkf/message.go` 的 `link` 分支只拼接标题、描述和 URL，没有公众号正文抓取或封面下载。
- `internal/wechatkf/processor.go` 复用稳定来源 ID 创建私人笔记，成功结果为「链接保存成功」。客户端 `internal/wechatkf/client.go` 仅有文本发送和素材下载，没有素材上传、文件发送。
- `internal/httpgetter/html_meta.go` 已有公众号专用请求头、网络地址与重定向校验，但只提取预览元信息；当前读取上限不能直接视为完整正文抓取能力。
- 浏览器扩展 `extensions/web-clipper/src/lib/article.ts` 和 `format.ts` 使用 DOM、Defuddle、Turndown 提取及转换正文，可参考转换规则与测试，但不能直接在现有 Go 后台调用。
- 当前回复队列保存文本内容；回传文件需要持久化文件引用和发送状态，并延续白名单、重复消息去重、回复窗口及未知发送结果不盲目重发的规则。若修改结构，需同步三驱动迁移和新装 SQL。

## 建议方案（未确认）

1. 第一版只处理单独转发、指向 `mp.weixin.qq.com` 的公众号文章卡片。纯文本网址、聊天记录里的嵌套卡片及其他站点暂沿现有行为，具体范围由后续讨论决定。
2. 在内置 Go 模块中增加受限抓取、正文识别和 HTML 转 Markdown 的处理步骤，输出原文内容，不默认使用大模型摘要或改写。保留标题、可获取的作者/公众号/日期、来源链接、段落、标题层级、列表、引用、表格与代码块；不虚构缺失信息。
3. 建议 Memos 保留卡片并关联同一份 Markdown 文件，以便以后下载；是否改为将全文直接存入笔记正文，留待用户选择。
4. 转换成功后排队上传文件素材并发送 `文章标题.md`，用文件替代该次普通成功文字回执；文件回传是否独立于现有回执开关，需要在实施前确定。
5. 第一版 Markdown 图片建议保持原位置的来源链接。单个 Markdown 文件不能保证图片离线可用；若需要离线图片，可另行讨论 Markdown 加图片目录的 ZIP。不要把 Memos 私有附件地址或访问凭据直接放进可转发文件。
6. 正文抓取失败时保留原卡片，说明「链接已保存，正文转换失败」及适合展示的原因；不将摘要或验证码页面作为完整文章发送。文件生成成功但回传失败应单独记录，避免重建笔记或重新抓取。

## 验证事实与待核验项

2026-10-22 对上述基线进行了只读代码调查。本轮没有实现功能、运行应用测试、访问生产配置或向微信发送消息。

官方文档检索/打开没有取得正文；浏览器访问 `kf.weixin.qq.com` 被站点安全策略拦截，未继续尝试绕过。不能据此声称当前官方文件类型、大小或后缀规则已核验。实施前需验证临时素材上传和文件消息接口，尤其是 `.md` 后缀、MIME、中文文件名以及 iPhone 微信接收/保存表现；若平台拒绝 `.md`，再与用户讨论 ZIP 等回退形式。

公众号正文获取是独立风险：验证码、访问限制、删除、付费或特殊图文排版可能导致无法取得完整内容。已有链接预览成功的历史样例不能证明任意文章全文可抓取。后续应以用户提供的代表性文章样例验收正文、图片位置与失败回执，不能仅凭 HTTP 200 或非空文本认定转换成功。

## 2026-10-22：优先调研现成开源转换器

用户进一步明确当前目标就是文章转 Markdown，要求先找成熟开源方案直接复用。当前讨论聚焦“文章 URL → Markdown 文件”；上文关于 Memos 全文/卡片/附件留存的建议不是用户确认需求，也不是本轮选型前提。本轮没有安装转换器或开始实现。

通过 GitHub 连接器读取一手 README、源码、发布记录和开放 PR，得到以下事实：

| 候选 | 可直接使用的能力 | 维护与接入判断 |
| --- | --- | --- |
| [kepano/defuddle](https://github.com/kepano/defuddle) | Node CLI 接受 URL、HTML 文件或标准输入，可输出 Markdown；MIT；现有剪藏扩展已用浏览器版 | [0.19.5](https://github.com/kepano/defuddle/releases/tag/0.19.5) 于 2026-10-10 发布。具备近期维护证据，适合优先验证；当前站点提取器注册表没有微信专用提取器，README 仍注明持续开发，不能推定公众号转换效果。 |
| [fengxxc/wechatmp2markdown](https://github.com/fengxxc/wechatmp2markdown) | Go CLI/HTTP server，直接输入公众号 URL，输出 MD；图片可选外链、base64 或本地文件，服务模式可输出 ZIP；MIT | 最近提交和 [v1.1.11](https://github.com/fengxxc/wechatmp2markdown/releases/tag/v1.1.11) 均为 2025-03-13。适合作为公众号专用对照工具，但源码抓取缺少超时/大小限制，部分错误会 log.Fatalf，表格保留 HTML，未见标准单元测试；不建议原样嵌入常驻 Memos 服务。 |
| [jackwener/wechat-article-to-markdown](https://github.com/jackwener/wechat-article-to-markdown) | Python CLI，Camoufox 抓网页，BeautifulSoup/markdownify 提取转换，下载图片并处理微信代码块；README/pyproject 声明 MIT | 有单元测试和真实 E2E 工作流，项目元数据版本 0.1.0，无 GitHub Release。2026-10-22 查询时 [PR #12](https://github.com/jackwener/wechat-article-to-markdown/pull/12) 的新装浏览器依赖兼容修复及 [PR #13](https://github.com/jackwener/wechat-article-to-markdown/pull/13) 的多代码块串号修复仍未合并。需 Python 和浏览器运行时，不作为无需修补的首选。 |
| [JohannesKaufmann/html-to-markdown](https://github.com/JohannesKaufmann/html-to-markdown) | Go 库和 CLI，MIT，提供结构化 HTML 转 Markdown、表格插件和测试 | [v2.5.2](https://github.com/JohannesKaufmann/html-to-markdown/releases/tag/v2.5.2) 于 2026-06-07 发布。适合后续 Go 内置的转换部分，但不独立负责公众号获取、正文选取和懒加载图片。 |

[wechat-article-exporter](https://github.com/wechat-article/wechat-article-exporter) 的当前 README 明确宣布 2026-07-30 停止维护、核心上游接口关闭、公开 API 下线，故排除作为新依赖；不能因历史 star 数或 archived 字段尚为 false 而推荐。

建议先用 Defuddle 和 wechatmp2markdown 对同组真实文章比较正文完整性、标题层级、代码块、表格和图片位置，再选择接入方式。此为选型建议，不是已经通过转换验收。用户提到的 BrowserRig 说明已读取；本轮使用 GitHub 连接器完成调查，没有通过其他浏览器路径重访此前被安全策略拦截的客服文档，也没有因此扩大到生产环境操作。

## 2026-10-22：用户选择 wechatDownload，核实当前可用入口

用户指定 [qiye45/wechatDownload](https://github.com/qiye45/wechatDownload)，理由是此前使用作者网站下载转换的 MD 效果不错。此选择取代上一节优先比较 Defuddle/wechatmp2markdown 的建议；继续先讨论复用方式，没有开始 Memos 功能实现或安装下载器。

一手仓库调查发现：当前主分支只有 README、导出样例、Skill/evals 和 issue 模板，没有公开转换引擎实现，也未发现 LICENSE。不能把公开 GitHub 仓库当作可直接导入 Go 的转换库，现阶段只能评估调用现成服务/客户端。README 标明 Windows/macOS，没有可核实的 Linux 无头部署说明。

[作者接口说明](https://github.com/qiye45/wechatDownload/blob/main/skills/wechat-article-downloader/SKILL.md) 给出两条路线：

- 远程 `https://changfengbox.top/api/mcp`：单篇工具 `wechat`，参数为文章 URL 与格式配置，支持 MD；没有说明结果文件的取回结构。
- 本地客户端 `http://127.0.0.1:4545/mcp`：需打开软件并启用 MCP，单篇工具 `single_article_download`；按客户端配置生成文件到本机下载目录。公众号密钥获取流程主要用于本地批量工作，不能据此断定单篇远程调用也要求密钥。

本轮实际验证（均为 2026-10-22）：

1. 对远程 MCP 的 `initialize`、`tools/list` 只读请求均返回 HTTP 200，能列出 `wechat` 与 `wechat_collection` 及 MD 配置。可发现工具不等于下载功能可用。
2. 使用作者公开的 5.0 版本说明文章链接，仅请求 MD 格式转换；HTTP 200 的 JSON-RPC 响应只有版本和请求编号，没有 result/error、文件内容或下载地址，未取得转换产物，不能报告下载成功。没有提交用户文章、账号数据或凭据。
3. 使用 BrowserRig 新建只读会话打开[作者网站](https://changfengbox.top/wechat)，读到明确公告：“因为安全原因：公众号网页下载功能已关闭，请使用公众号客户端”。客户端链接指向上述 GitHub 仓库。完成后删除本次会话；没有修改网页设置、读取历史文件内容或操作用户下载记录。
4. GitHub [4.7 Release](https://github.com/qiye45/wechatDownload/releases/tag/4.7) 当前标题标注“已失效”；作者在 [2026-10-13 的回复](https://github.com/qiye45/wechatDownload/issues/9#issuecomment-6149722702) 中提供 5.0 说明入口。不能因 Releases 最新标签仍为 4.7 而推定它是当前可用版本。

据此，作者网站的远程转换暂不能作为已验证接入路线。若继续采用用户认可的该项目，应先验证当前桌面客户端的单篇 MD 与本地 MCP：需要一台运行客户端的 Windows/macOS 设备，并解决与 Memos 后台之间的任务及文件传输；电脑离线时不能假定仍可自动转换。5.0 的实际 MCP 能力、文件定位、成功/失败反馈及持续运行方式均未测试。未安装客户端、未部署中转、未实现微信文件回传；上述建议不代表已获得源码自托管能力。

## 2026-10-22：明确服务器独立运行，并核实源码与网站依赖

用户明确要求由部署 Memos 的服务器独立完成，不能依赖一台常开的个人电脑；这取代上一节探索桌面客户端中转的建议。用户同时询问能否参考源码集成，以及是否依赖作者网站。当前仍为方案讨论。

补充的一手证据：

- 作者在 [Discussion #75](https://github.com/qiye45/wechatDownload/discussions/75#discussioncomment-9236132) 表示近期没有开源计划，只向认识的人开放私有仓库，并在后续回复中说明使用 Qt。作者在 [2025-08 的 #386 回复](https://github.com/qiye45/wechatDownload/issues/386#issuecomment-3155680925) 和 [2025-09 的 #412 回复](https://github.com/qiye45/wechatDownload/issues/412#issuecomment-3316020456) 仍引用该说明，与本轮实际仓库目录没有转换器源码相符。可以参考公开输出样例和接口行为；若要复用原实现，需作者提供源码及相应使用授权。
- 作者在 [#464 回复](https://github.com/qiye45/wechatDownload/issues/464#issuecomment-4018877664) 解释其服务器用于软件下方公告。该证据只能确认有作者服务器通信，不能证明文章内容或 Markdown 转换必须经作者服务器处理，也不能证明服务器失联完全不影响客户端。
- [#560](https://github.com/qiye45/wechatDownload/issues/560) 是第三方针对 4.6 的网络行为报告，没有作者评论，本轮未复现；不据此宣称当前 5.0 的内容转换路径或安全状况已确认。
- [#570](https://github.com/qiye45/wechatDownload/issues/570) 报告本地 MCP 只能触发下载，不能返回文件 URL 或查询任务状态；作者回复“我看看吧”，本轮查询仍为 open。这进一步说明不能把现有本地 MCP 文档当作完整服务端转换 API。

方案判断：当前无法直接将 wechatDownload 核心转换代码内置。若要满足服务器独立运行并避免依赖作者服务，可以以用户认可的 MD 输出作为效果参照，选择有公开源码的转换库，在 Memos 后台完成公众号抓取、正文处理、Markdown 生成及微信文件回传。运行时仍需访问微信文章、图片和客服接口，但可设计为不调用 changfengbox。此为建议而非已确认实施选型；本轮没有安装客户端、抓包、复制私有源码或修改业务代码。

## 2026-10-22：重新筛选近期维护项目，并实测用户文章

用户进一步要求调研近期维护、可用且有一定热度的项目；允许源码复用或直接调用工具，目标限定为单篇公众号文章链接转 Markdown。服务器独立完成的要求仍有效。用户提供测试文章：[AI 社交的另一种生意](https://mp.weixin.qq.com/s/d-RExDOWPtsB2aT2egmRWw)，公众号为「十字路口Crossing」。本节替代此前尚未验证的候选排序，不代表用户已确认技术选型。

### 候选维护情况

以下 GitHub 数据核验于 2026-10-22；star 数只表示社区关注度，不代表公众号可用性。

| 候选 | 热度、近期维护、许可 | 服务器调用方式与判断 |
| --- | --- | --- |
| [Defuddle](https://github.com/kepano/defuddle) | 9,753 stars；[0.19.5](https://github.com/kepano/defuddle/releases/tag/0.19.5)，2026-10-10；MIT | Node 库或 CLI；无需浏览器和作者云服务。通用提取不能直接视为微信适配，本次补正文节点和懒加载图片处理后效果良好。现有剪藏扩展已使用该库，但 Go 后台仍需新增 Node 调用边界。 |
| [wechat-article-parser](https://github.com/huanjuedadehen/wechat-article-parser) | 11 stars；[v0.0.16](https://github.com/huanjuedadehen/wechat-article-parser/releases/tag/v0.0.16)，2026-10-21；MIT | Python 库 `parse` / `parse_async`，返回正文 MD 和文章元信息；httpx、BeautifulSoup、markdownify，无浏览器或作者服务。专用且轻量，本次开箱实测通过，但社区小，不能称为成熟热门项目。 |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | 约 8.6 万 stars；[v0.9.5](https://github.com/unclecode/crawl4ai/releases/tag/v0.9.5)，2026-10-14，最近 push 10-21；Apache-2.0 | Python / CLI / Docker REST，可自托管；普通 MD 转换无需 LLM。依赖浏览器及较多运行包；本次样文抓取未通过。 |
| [Jina Reader](https://github.com/jina-ai/reader) | 12,184 stars；最近 push 2026-05-22；Apache-2.0 | 托管 URL API，也有自托管镜像。本次匿名托管请求受 IP 信誉限制，返回 401；未测试有密钥或自托管版本。 |
| [Firecrawl](https://github.com/firecrawl/firecrawl) | 约 19.4 万 stars；最近 push 2026-10-22；核心 AGPL-3.0，SDK MIT | 托管 `/v2/scrape`，也可多服务自托管。本次匿名试用返回 403，提示当前网络需 API key；未测试有密钥或自托管版本。 |

同时检查了 [WeRSS](https://github.com/rachelos/we-mp-rss)（约 5 千 stars，10-20 有 push）与 [MagicMD](https://github.com/didilili/MagicMD)（16 stars，8 月有更新）。前者重点是公众号订阅、授权和数据库管理，现有导出路径围绕已收录文章，未核实为任意 URL 一步转 MD；后者提供专用 SDK，但默认使用 Camoufox，热度小且本轮未做实测。两者不优先于已通过样文测试的轻量路线。

### 实测方式及结果

本轮只在当前 Windows 工作站执行临时对照测试，未访问生产服务器。Python 工具使用 `uv --no-project --with` 的隔离缓存；Defuddle 使用 `npx --yes defuddle@0.19.5`。没有修改 Memos 依赖、应用代码或 Docker 配置，没有启动常驻服务、注册第三方账号或创建 API key。所有脚本、原始页面及结果保存在主工作区忽略目录 `tmp/wechat-md-research/`，不提交正文与图片链接快照。

直接普通 HTTP 请求取得真实文章 HTML，正文节点为 `#js_content`。源正文有 6 个图片节点；从正文节点提取了 64 段至少 40 个字母/数字/汉字的文字块，去除标点和空白后对照转换结果。此核对可发现长段漏失，不证明所有格式、短文本或链接均正确。

| 测试 | 实际结果 |
| --- | --- |
| Defuddle 直接解析 URL | 输出 8,880 字符，64 段长文本全部命中，但只有 5 个 Markdown 图片，混入「微信扫一扫」「轻点两下取消赞」等页面控件。默认调用不足以作为本需求的完成状态。 |
| Defuddle 加公众号正文预处理 | 使用同次抓取的 HTML，选取 `#js_content`，把图片 `data-src` 复制为 `src` 后转换；输出 8,808 字符、6 个图片引用，64 段全部命中，未出现检查的 5 类页面控件文本。此为临时实验适配，尚未集成。 |
| wechat-article-parser 0.0.16 | 直接 `parse(url)`，约 1.47 秒取得正文，标题与公众号正确，输出 8,651 字符、6 个图片引用，64 段全部命中，未出现检查的页面控件文本。 |
| Crawl4AI 0.9.5 | 复用已有 Chromium，首次结果为空；唯一一次普通等待调整后落到微信验证页，正文不存在，输出仅 69 字符、0 张图。库的 `success=true` 只表示抓取流程完成，不能作为文章转换成功；未继续处理验证码。 |
| Jina Reader / Firecrawl 托管 API | 分别返回匿名访问 401 / 403，均没有取得 MD，不能判断带密钥版本的实际转换效果，也不能称为全面不可用。 |

上述图片结果均为 Markdown 外链引用，没有下载图片。样文不包含足够的代码块/表格场景；这两类格式、更多公众号样例与生产服务器 IP 的真实可达性仍需后续验证。测试成功不代表微信长期不返回验证页。

### 当前建议及后续边界

若把“热门、近期维护、有利于长期维护”作为首要条件，建议以 Defuddle 为转换基础，保留小范围公众号正文与懒加载图片适配；本次结果证明这条路线值得进入接入验证。若优先“专用、直接调用、最少适配”，wechat-article-parser 是已经跑通的备选，但要接受小项目的维护风险。两条路线均可由部署服务器独立调用，不依赖作者网站，也不需要常开个人电脑；仍需访问微信文章本身。

无论选择哪个转换器，均需单独完成 Memos 后台调用、失败识别、MD 文件生成及微信素材上传/文件回传。现有客服模块仍只有链接保存和文字回执，本轮没有实现或部署上述功能。未选择新的项目依赖、未修改镜像流程；后续如实施新增运行时或重依赖，按仓库规则先讨论具体接入方案。

## 2026-10-22：确认产品行为，评估避免 Python 运行时

用户选择 wechat-article-parser 路线，并确认「转发公众号文章卡片，转换成功直接发 MD，失败说明原因」。随后用户询问新增运行时的占用，并提出能否参考原项目实现在 Go 中完成，而不依赖 Python。当前功能分支为 `feat/wechat-article-markdown`，替代此前讨论分支名称。

镜像检查确认：现有 Python 文件用于本地开发、测试、发布或服务器维护；`scripts/Dockerfile` 的生产阶段基于 Node Alpine，包含 Memos Go 二进制和 PDF 排版组件，没有安装 Python。仓库存在 Python 源文件不等于运行镜像提供解释器。按仓库规则提出的镜像新增 Python 确认尚未获同意；用户的占用问题不是批准，尚未修改 Docker 或业务代码。

直接使用原库需要 Python。2026-10-22 查询 Alpine 3.23 x86_64 的 [python3 包](https://pkgs.alpinelinux.org/package/v3.23/main/x86_64/python3)，压缩包 7.7 MiB、安装 22.9 MiB；包含其余运行库和解析器后，曾给出镜像解压增量约 30–50 MB、下载增量约 10–20 MB 的粗估，未经容器实际构建确认。使用短时进程可避免常驻 Python 服务，但文章转换期间的峰值内存尚未测量。

纯 Go 路线可行：[原项目 v0.0.16](https://github.com/huanjuedadehen/wechat-article-parser/blob/v0.0.16/LICENSE) 为 MIT，可参考公众号模板识别、正文提取、懒加载图片、代码换行和错误分类规则；移植实质代码时需保留版权和许可。可用 [html-to-markdown v2.5.2](https://github.com/JohannesKaufmann/html-to-markdown/tree/v2.5.2) 等 Go 库承担通用 Markdown 转换，不必从头实现整个 Markdown 引擎。该方式不再直接运行 wechat-article-parser，输出也不能保证逐字节一致，需以用户样文及代码块、表格、自定义排版等构造样例核对。

后续接入设计要点：保留原卡片私人笔记，成功仅排一个文件结果；公众号转换结果与普通成功回执开关应分别处理，避免用户关闭普通回执后收不到所请求的文件。结果文件或其内容应先持久化，素材上传与用户可见发送分阶段处理；上传失败可以重试，真正发送结果不确定仍记为 unknown，不盲目重发。确定性的验证码、删除、无可用正文等失败应及时说明，不沿普通保存错误重试 12 次。

补充读取 [官方上传临时素材](https://developer.work.weixin.qq.com/document/path/90253) 和 [客服发送消息](https://developer.work.weixin.qq.com/document/path/94677)：普通文件上传为 `/cgi-bin/media/upload?type=file` 的 multipart `media` 字段，文件大于 5 字节且不超过 20 MB，素材有效期 3 天；客服文件消息使用 `msgtype=file` 与 `file.media_id`，继续受 48 小时/5 条限制。未找到普通文件的明确后缀白名单，不能据此认定真实微信一定接受 `.md`；中文文件名、后缀和手机接收仍需实际验收。本轮仅读取官方另一域名的普通文档，未重访此前被安全策略阻止的域名。

## 2026-10-22：批准纯 Go 实现及实施结果

用户以「可以」批准不引入 Python、参考原项目规则的纯 Go 路线，取代直接运行 Python 包的设想。未修改 Docker、发布流程、认证或令牌行为。新增 `html-to-markdown/v2 v2.5.2` 及其 DOM 依赖；`x/net`、`x/crypto`、`x/sys`、`x/text` 随最低版本要求小范围升级。公众号规则参考来源与 MIT 许可保存在 `internal/wechatarticle/THIRD_PARTY_NOTICES.md`。

实施范围：

- 只处理单独转发、指向微信文章路径的顶层卡片；保留原卡片 PRIVATE 笔记，不把全文额外存为笔记或附件。成功回传一个含标题、来源和正文的 `.md`，图片保留外链。普通网站、文本网址及聊天记录内卡片沿用现有处理。
- `internal/wechatarticle` 识别正文、恢复懒加载图片、处理代码换行和语言、转换列表/引用/表格。只支持取得可用正文 DOM 的模板，没有完整移植 Python 库中仅靠脚本数据的轮播/全屏模板；不支持时明确失败。
- `internal/httpgetter` 限定微信主机、HTTPS 重定向和安全拨号，拒绝内网目标；请求限时 25 秒，网页原始及解码体各限 8 MiB，正文节点/深度有界，MD 限 1 MiB。验证码、删除、付费预览、空正文及不支持模板返回脱敏中文原因。
- `internal/wechatkf` 与 runner 增加临时素材上传和文件发送。生成结果先随任务完成状态持久化；素材上传与可见发送分阶段，上传不占回复额度，上传重试不重新转换。文件或失败原因作为必要结果，关闭普通保存回执仍会发送。
- SQLite/MySQL/PostgreSQL 同步新增回复类型、文件名、正文和必要标记；新装与迁移兼容旧文本回执。`preparing` 中断可重新上传，`sending` 中断或网络结果未知保留 `unknown`，不盲目重发。终态清除队列正文。
- 明确上传/发送失败重试耗尽后尝试回复原因；异步文件投递失败保留原 `delivery_failed`，按原消息 ID 去重生成一次必要文字通知，文字通知失败不递归。既有白名单、游标、幂等、租约和 48 小时/5 条窗口保持有效，窗口不足时无法保证即时回传。

### 实施验证

基线仍为 `b8f7aea00`，验证对象为本功能工作区；使用构造消息和临时 SQLite，不读取生产配置或调用真实微信发送。

- 用户样文复用此前普通 HTTP 抓取的 HTML，经 Go 转换产生 19,974 字节正文，64/64 段较长文字和 6/6 个图片引用命中，检查的 5 类页面控件噪声均未出现。产物在本地忽略目录 `tmp/wechat-md-research/go-reference.md`，不提交第三方文章全文。此核对不等于全部短文本和格式均逐字节相同。
- 转换器、HTTP 获取器、微信核心及 runner 包测试通过；覆盖已知失败原因、危险链接、付费/验证页、图片、表格管道符、代码块、文件名、关闭普通回执后的文件/原因、上传重试、发送未知不重复，以及保留唯一私人笔记。
- SQLite 微信存储/迁移测试通过，覆盖新旧回复、重启恢复、额度、正文清理、异步失败通知去重和授权匹配；更新两个既有历史迁移测试的建库夹具，以移除当前新增列后再重放历史迁移。
- 独立审查复现代码块行号可能混入代码正文，按同一复现片段修复并补回归检查。其余已审查关键状态和网络边界未发现实质问题。
- Windows 本机无 CGO/C 编译器，`go test -race ./internal/... ./server/...` 无法启动；无 Docker，MySQL/PostgreSQL 容器测试跳过。全量非 race 检查还遇到 Windows 符号链接权限、SQLite 文件清理占用及旧测试失败；`TestReadLegacySnapshot` 的同样失败和 `TestCacheEviction` 的不稳定在干净 main 基线均复现，未修改无关测试。不能据此宣称全量通过。Linux race、三驱动及容器升级由 PR 的对应 CI 检查验证。
- `go mod tidy -go=1.26.2` 在临时 modfile 成功，输出与本次依赖文件规范换行后相同。使用 CI 同版 golangci-lint v2.11.3 检查并修复新增命名、断言及分支规则问题；现有三个附件文件的 goimports 提示对应内容与 main 完全相同，不纳入本次修改。
- 已调用根 `corepack pnpm changeset --empty`，CLI 在 worktree 写入时被 EPERM 阻止，随后按其生成名称补写 `.changeset/salty-ears-start.md`，只选择 `memos-personal` minor。根依赖安装和发布规则测试同受 Windows 临时目录权限影响；CI 路由单测通过，发布校验在 PR 检查中执行。

真实微信 `.md`/中文文件名投递、手机保存，以及生产服务器 IP 获取文章的结果未在本次本地验证中取得。普通 PR 和本地测试不能推定功能已部署或微信端已验收。

## 2026-10-22：补齐角标和参考编号的格式对照

用户指出 Go 产物中 `Table for Six\[1]` 和文末 `\[1]Table for Six` 比原 Python 产物多出反斜杠，偏好原项目的直接编号形式。此前只核对正文长段和图片，没有逐项验收这些格式细节；该遗漏不能以渲染后看起来相同代替源 Markdown 可读性要求。

对两份原产物逐行比较确认：共 11 处编号（正文 6 个角标、文末 5 个条目）被 Go 通用库保守转义。源角标是嵌套 `span` 的 `sup`，参考条目是段落开头的相邻 `span`；内容没有缺失。其余差异限于公众号链接编码、图片查询参数和末尾换行，规范这些差异后全文逐字符一致。

在 `internal/wechatarticle/references.go` 使用项目已有 Goldmark 识别普通文本中的数字编号，只移除冗余转义；跳过代码、链接和图片标签，保留相邻 Markdown 语法所需的转义。改写前后 GFM 渲染结果必须相同，否则保留原文，避免把参考条目或普通文字意外转换成链接。处理受现有 1 MiB 输出上限约束，没有增加依赖或修改镜像。

本地转换器、微信核心及 runner 测试通过，新回归覆盖嵌套角标、重复编号、文末相邻节点、代码、链接、图片、引用定义和跨行链接语法。修正样文为 19,963 字节，仅比此前 Go 结果少 11 个反斜杠，其余字节完全一致；11 个编号的数量和顺序与 Python 相同，规范已知 URL/图片参数/尾换行后全文逐字符一致。产物保存在忽略目录 `tmp/wechat-md-research/go-citations-fixed.md`。修复继续归入 [PR #87](https://github.com/Castor6/memos/pull/87)。

## 2026-10-22：去掉回传文件额外添加的来源链接

用户反馈已验证微信客服的 MD 文件发送正常，并要求文件仅保留文章原内容，不要标题下方额外添加的来源链接。该要求替代上文初始实现中「标题、来源和正文」的文件格式；原文章标题、正文已有的链接与图片仍需保留。用户反馈证明此次文件发送成功，不扩展为全部文章、设备或手机保存流程已验收。

主工作区已切至 `main` 并快进拉取到 `7970b644`。本次在独立 worktree 的 `fix/wechat-markdown-source` 分支修改 `internal/wechatkf/article.go`，只去掉文件封装时拼接的「来源」行，标题后直接接转换后的正文。正文转换、卡片笔记保存和文件投递流程不变；不改写已经生成或发送的文件。

验收要求：文件内容为文章标题与原文正文；正文内原有「来源」文字、链接和图片保留；Memos 中原卡片笔记仍包含链接。调整现有处理器测试，以完整文件内容断言覆盖这些要求，并同步模块文档与应用 patch 发布说明。

本次验证（2026-10-22，基于 `7970b644` 的修正工作区）：

- `go test -race ./internal/wechatkf ./internal/wechatarticle ./server/runner/wechatkf` 通过，覆盖文件内容、文章转换和文件投递流程。
- `go test -v -race ./internal/...` 全部通过。
- 使用 Node 24 执行根 `corepack pnpm install --frozen-lockfile`、`corepack pnpm changeset --empty` 并补充仅 `memos-personal` 的 patch 说明；`corepack pnpm check:release origin/main` 通过，差异空白检查通过。
- 本次使用构造消息及临时数据验证，没有向真实微信发送消息或执行部署；新格式在包含本修正的版本发布后生效。
