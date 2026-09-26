# Memos 自动部署

发布由 GitHub Actions 构建、验证并上传镜像；部署由现有服务器主动拉取、备份并启动新镜像。普通 PR 只更新 main，合并 `Version Packages` PR 才发布。具体上线状态以 [任务记录](tasks/TASK-20260916-automated-deployment.md) 为准。

## 运行条件

- Linux amd64、Docker Compose、Python 3、GNU tar、SQLite 数据库，服务名为 `memos`。
- 应用目录包含 `compose.yaml` 和 `data/memos_prod.db`，附件保留在 `data/` 内。
- 使用深圳免费 ACR 个人版私有仓库。该产品按官方约定限开发测试、无 SLA，用户已选择此限制；镜像拉取失败不停止旧服务。
- 发布凭据放在 GitHub Secrets；服务器应使用仅允许拉取目标仓库的 RAM 用户。实际主机、密钥和密码仅在私有运维目录保存。

## 安装与首次运行

1. 将 `scripts/deploy/memos-update.py` 安装为 `/usr/local/lib/memos-update/memos-update.py`，由 root 管理。
2. 用 `config.example.json` 创建 `/etc/memos-update/config.json`，填入实际仓库和健康检查地址，目录权限 700、文件 600。配置 `ca_file` 为验证 HTTPS 的 CA 证书，不能跳过 TLS 验证。
3. 创建 `/var/lib/memos-update`（755），将 `maintenance.nginx.conf` 安装到 Nginx snippets，并在 Memos 的 HTTPS `server` 中 include；先 `nginx -t` 再 reload。
4. 使用只读拉取账号和 `docker login --password-stdin` 配置 root 的 Registry 登录，Docker 配置文件权限 600。不将密码放进参数、日志或仓库。
5. 安装同目录的 systemd service/timer，执行 `systemctl daemon-reload`。先执行 `python3 /usr/local/lib/memos-update/memos-update.py --dry-run`，只拉取和验证，不停机。
6. 首次手动执行 service，核对健康、登录、笔记、附件和备份后，再执行 `systemctl enable --now memos-update.timer`。此后约每 5 分钟检查一次。

## 更新与故障处理

更新器先拉取 `stable`，核对来源标签、个人版本、提交、平台和仓库摘要。相同摘要不操作，已部署后禁止降低版本或替换同版本摘要，之前失败的摘要不会自动反复尝试。

准备更新时，Nginx 暂时返回带 `X-Memos-Maintenance: 1` 的 503。脚本确认该入口生效后停止应用，对 SQLite 做完整性检查，记录用户/笔记/附件数量及附件哈希，备份应用和配置并比较归档。备份空间不足或备份失败会恢复旧应用，不切换镜像。

新镜像通过 Compose overlay 按摘要启动。只有版本、提交、初始化状态、前端入口和原数据检查通过，才记录部署结果并结束维护。失败则停止候选版本，校验归档哈希，恢复升级前数据库、附件和 Compose，再启动原镜像。失败候选数据保留在备份目录，便于排查。

查看状态：

```bash
systemctl status memos-update.service memos-update.timer
journalctl -u memos-update.service -n 100 --no-pager
cat /var/lib/memos-update/deployed.json
```

若自动恢复也失败，`pending.json` 与维护标记会保留，后续更新拒绝继续，避免对未知数据状态重复操作。先停止 timer，查看 pending 指向的归档和 `manifest.json`，核对 SHA-256，再在临时目录解包检查。保留当前失败目录，将备份的整个应用目录恢复到原路径，以备份的 Compose/overlay 启动；验证旧版本和原数据后才能移走 pending 和维护标记。不能只降级镜像而继续使用已迁移的数据，也不能通过直接删除标记跳过恢复。查明并修复失败原因后，可显式运行 `--retry`。

成功升级后自动清理过期升级备份和配套镜像，规则见下节；更新前空间检查不足时仍会拒绝更新，不提前清理恢复点以腾空间。备份在同一服务器，不能覆盖主机或磁盘损坏；异地备份、告警、证书续签不在本次实现范围。

## 验证范围

单元测试覆盖拉取、维护入口、停止、备份和健康检查失败，以及恢复失败保留维护状态。Linux 测试还使用真实 GNU tar、SQLite 与二进制附件验证恢复和权限、拒绝损坏归档。容器安装/升级冒烟测试使用独立临时数据，不访问生产数据。生产功能验证与定时器是否启用应单独记录。

还可在具备 Docker、nginx、openssl 的 Linux 主机上，以 root 执行 `python3 scripts/deploy/integration-test.py`。先准备官方 `ghcr.io/usememos/memos:0.30.0` 镜像。该演练创建独立 Compose 项目、临时数据和仅监听 loopback 的 HTTPS Nginx，验证成功更新，再故意损坏测试附件并触发健康检查失败，核对恢复后的数据库、附件和登录。它不重载系统 Nginx，不访问生产应用；结束时清理自己的容器、临时镜像和目录。

## 备份与镜像保留

备份仍为未压缩的完整 tar。每次成功升级、退出维护后执行清理；无新版本、升级失败、恢复期间均不清理。保留最近 3 次备份与最近 30 天的备份（满足任一个条件即保留），还保留当前部署的恢复点、失败或未完成升级的备份。配置 `backup_keep_count`、`backup_keep_days` 可以增大，但不能低于 3 和 30。

`retention.json` 记录备份创建时间、升级结果、归档哈希及备份对应的旧镜像完整 ID。自动恢复时校验元数据与镜像 ID，并为恢复的数据生成按 ID 启动的 Compose overlay，避免 stable 移动后旧仓库摘要引用失效。未知文件、缺失/无效元数据、符号链接等异常会阻止清理或保护该备份；过期归档哈希不匹配时也保留。旧版备份没有这些元数据，需维护者核对归档、原镜像和升级记录后补充，不能仅按目录名假定升级成功。

只考虑被清理备份关联的镜像，按 ID 删除，不运行全局 prune、不加 force。保留当前部署镜像、任何保留备份的配套镜像、所有运行或停止容器引用的镜像；范围限配置的 Memos 仓库、历史官方 Memos 仓库，以及被备份明确记录且仍带本 fork 来源标签的无标签旧镜像。未纳入备份记录的镜像不自动删除。

清理与升级使用同一 `update.lock`。先记录待清理镜像 ID，再删除备份，重新检查引用后删除镜像；失败的镜像删除可在以后成功升级时重试。`cleanup-last.json` 记录计划、实际删除结果和异常，journal 记录每次删除。清理失败不会回滚已成功升级的应用。

只预览当前规则，不拉取、不升级、不删除：

```bash
python3 /usr/local/lib/memos-update/memos-update.py --cleanup-dry-run
```

宿主机更新器不会随应用镜像升级，修改此脚本后需备份旧脚本、持同一部署锁安装新版并执行预览验证；无需重启应用。历史 Blinko 备份及其它备份目录不在清理范围内。此保留策略不能替代异地备份，也不保证永久保存每一个历史版本。

## 发布渠道与按需转仓

`IMAGE_CHANNEL` 仓库变量选择 `ghcr`（默认）或 `acr`；每次仅发布所选仓库，不双发、不因网络失败自动改渠道。GHCR 使用 Actions 的 `GITHUB_TOKEN` 和 `packages: write`，生产匿名拉取需将对应包设为公开；ACR 继续使用原有 Variables/Secrets，备用期间保留但不使用。

新版本继续执行安装与升级验证。已有正式版本转仓使用 `Transfer Release Image` 工作流：在 main 上选择目标渠道，读取另一渠道的 stable，核对正式 GitHub Release 的版本、提交、摘要与校验文件，再使用 skopeo 保持摘要复制版本标签、提交标签，最后更新目标 stable。目标若已有更新版本或不同内容则拒绝覆盖；转仓不构建应用、不重复升级测试、不补齐历史版本，也不修改公开 Release 附件。

切换顺序：先停止新的版本发布操作，运行转仓工作流并验证成功，再验证服务器可拉取目标 stable；之后修改仓库变量 `IMAGE_CHANNEL`，备份服务器更新器配置，在部署锁下将 `image_repository` 改为目标仓库。`retained_image_repositories` 列出旧仓库，仅用于校验现有容器和保护/清理历史镜像，绝不自动拉取它。先执行 dry-run、再恢复 timer，确认当前版本、容器及恢复点不变。GitHub 不保存服务器 SSH 私钥；服务器配置通过现有私有运维连接调整。

两个仓库相同摘要且版本、提交一致时不重启。失败摘要也不能因更换仓库而自动重试；不同摘要的同版本、降级继续拒绝。切换后，下一版本的升级测试可使用刚转入目标仓库的版本，不要求更早历史镜像。仓库不可用只影响检查/拉取，不停止已有应用。宿主机更新器需单独安装，镜像发布不能代替安装。
