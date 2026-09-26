# AGENTS.md

Repository instructions for AI coding agents. Keep this file short, concrete, and tied to commands that actually work in this
repo. If a fact here conflicts with source files or CI config, trust the source file and update this guide.

## Project Snapshot

Memos is a self-hosted note-taking app.

- Backend: Go 1.26.2, Echo v5, Connect RPC, gRPC-Gateway, Protocol Buffers.
- Frontend: React 19, TypeScript 7, Vite 8, Tailwind CSS v4, React Query v5.
- Storage: SQLite, MySQL, PostgreSQL.
- Generated API outputs: `proto/gen/` for Go/OpenAPI, `web/src/types/proto/` for TypeScript.

## Working Rules

- Read relevant code before editing; prefer local patterns over new abstractions.
- 开始新会话的提交工作前运行 `./scripts/install-git-hooks.sh`；已有自定义钩子时保留并检查其是否接入 `git diff --cached --check`。所有代码、文档及任务记录更新完成并暂存后，必须执行 `git diff --cached --check`；推送前执行 `git diff --check origin/main...HEAD` 检查完整 PR 差异。修正后重新暂存，不使用 `--no-verify` 绕过检查。
- Keep diffs scoped. Do not do repo-wide cleanup, dependency churn, or generated-file rewrites unless the task requires it.
- Do not hand-edit generated proto outputs. Change `.proto` files, then run `buf generate`.
- Add migrations for all database drivers when schema changes, and update each driver's `LATEST.sql`.
- Add public API endpoints to `server/router/api/v1/acl_config.go`.
- Ask before adding heavy dependencies, changing auth/token behavior, or altering Docker/release workflows.

## Personal Fork Workflow

- Communicate in Chinese. Keep task records in Chinese and update them as work progresses.
- Use focused branches and PRs targeting `Castor6/memos:main` for changes, including documentation and upstream imports. `validate` is the required CI check. See `docs/release.md` for CI, Changesets and publishing; actual deployment status is in `docs/tasks/TASK-20260916-automated-deployment.md`. Ordinary merges must not trigger production deployment.
- Add a new `.changeset/*.md` for shipped behavior changes using root `corepack pnpm changeset`. Use patch/minor/major and a Chinese user-facing summary. Changeset 只选择变化的组件：应用 `memos-personal`、扩展 `memos-web-clipper`，两者变化才同时选择；扩展独立版本/日志位于 `extensions/web-clipper/release/`，仅应用更新不升级扩展，反向亦然；扩展用 `web-clipper-v*` 独立 Release，仅扩展变化不运行镜像发布。Only the generated version PR updates release package versions and their `CHANGELOG.md`; upstream history lives in `docs/upstream/CHANGELOG.md`. Version PR merges publish one smoke-tested OCI artifact independently to ACR and GHCR only when the Memos version changes; server pull updates use `scripts/deploy/` with backup and recovery. Keep deployment credentials and host details out of this repository.
- 按需检索历史：直接按文件名、任务编号、标题、模块或关键词搜索 `docs/tasks/`，只打开相关任务和必要链接；`docs/tasks/INDEX.md` 仅提供固定检索说明，新任务不登记总索引，不在启动时读取全部历史。
- 涉及线上排查、部署或服务器维护时，先读取仓库根目录的 `LOCAL_OPS.md`（若存在），按其中的路径查阅私有维护说明，不做全局目录搜索。该文件仅保存在本机，使用 `.git/info/exclude` 排除，不提交私有路径或凭据；本机缺少该文件时向用户确认维护入口。
- `docs/README.md` is a navigation entry, not a mandatory reading list. Read `docs/development.md` when running or verifying locally; read deployment documentation only for deployment/upstream work.
- 实质工作使用 `docs/tasks/TEMPLATE.md` 创建或续接任务，先记目标和验收标准，收尾记录带日期的实现、实际验证与未覆盖范围；相关小修可共用记录。
- 单个任务文件由一个会话负责维护，记录维护会话或工作分支；同一任务交接后续写原文件，其他会话独立开展的工作另建任务并互链，不共同更新大任务进度表。多会话代码修改使用独立 worktree。
- Task 只记录目标、关键决定、实现、实际验证与未覆盖范围，不重复 Git 提交流水或 PR 状态，不逐次记录推送、等待 CI、索引冲突等操作。必要证据可附日期与链接；后续进展查 PR、Actions、Release 或私有运维记录。不提交自动生成的任务总目录。
- Promote durable decisions into this guide or the relevant module documentation. Keep task details, logs and screenshots out of this file; search archived task records only when relevant.
- Default UI verification to the Codex in-app browser with local disposable data: desktop 1440×900; the user's iPhone 15 Pro Max uses a 430px-wide layout, checked at heights 739 and 932 (see `docs/development.md`). Verify no persistent left sidebar on mobile. Restore viewport overrides afterward. Use the regular Chrome profile only for a problem specific to it.
- Narrow viewport checks do not establish iPhone/Safari, software keyboard, touch or PWA behavior; record any required real-device checks explicitly.

## 内置微信客服模块

- 2026-09-19 用户选择将微信客服能力以 Go 模块内置到定制 Memos，随同一应用、镜像和版本发布；主开发位置为 `~/Code/memos`，主任务见 `docs/tasks/TASK-20260919-wechat-kf-integration.md`。
- `~/Code/wechat-kf-memos`（远端 `Castor6/wechat-kf-memos`）保留旧 Python 实现和测试，作为历史参照及必要回退入口；产品规则和开通记录已归档到 `docs/wechat-kf/legacy`；不是另一个需要永久同步开发的产品。新增内置能力及 Task 归入 Memos。
- 维护协议兼容时读取 `docs/wechat-kf-integration.md` 和归档规则，必要时参照旧项目代码，按行为等价维护，不能因内置化遗漏白名单、幂等、重试、回执窗口或未知发送状态。迁移前若 Memos 变更影响仍在运行的旧服务，检查并完成必要兼容适配。
- 内置剪藏复用 Memos 的笔记、标签、空间、附件和权限业务逻辑；协议处理与后台任务保持模块边界。状态通过 Memos store 与三驱动迁移管理，不绕过权限/校验直接插入笔记，不再以 Memos PAT 请求自身 HTTP API。
- 旧队列、游标、去重和回执状态必须可迁移、可验证；切换前保留旧服务及私有备份，避免两个消费者同时处理。运行迁移、停旧服务和仓库归档分别记录实际结果，不能由文档或 PR 合并推定已完成。
- 本机路径中的 `~` 指当前用户主目录。跨仓库操作先检查工作区并保留已有改动；迁移期配套提交/PR 互引，长期维护与发布在 Memos 内完成。

## Commands

Run from the repository root unless a command starts with `cd`.

```bash
# Personal local environment (see docs/development.md)
./scripts/dev.sh setup             # Node 24 / pinned pnpm / Go dependencies
./scripts/dev.sh start             # Local SQLite + fixtures, front/back; Ctrl-C stops both
./scripts/dev.sh reset             # Stop first; archive test data, reseed on next start
./scripts/dev.sh check frontend    # lint + unit tests + production build
./scripts/dev.sh check backend     # server/internal race tests + SQLite store tests

# CI / personal version tooling (Node 24; run from root)
corepack pnpm install --frozen-lockfile
corepack pnpm test                 # CI routing, aggregate gate, release guard tests
corepack pnpm check:release origin/main
corepack pnpm changeset            # Add release note and relative version bump
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -shellcheck=""

# Backend
go run ./cmd/memos --port 8081    # Start backend dev server
go test ./...                      # Run all Go tests
go test -v ./store/...             # Store tests, including DB drivers via TestContainers
go test -v -race ./server/...      # Server tests with race detector
go test -v -race ./internal/...    # Internal package tests with race detector
go test -v -run TestFoo ./pkg/...  # Run matching Go tests
go mod tidy -go=1.26.2             # Match CI tidy check
golangci-lint run                  # Go lint, config: .golangci.yaml
golangci-lint run --fix            # Auto-fix lint, including goimports

# Frontend
cd web && pnpm install             # Install dependencies
cd web && pnpm dev                 # Dev server on :3001, proxying API to :8081
cd web && pnpm lint                # Type check + Biome lint
cd web && pnpm test                # Vitest unit tests
cd web && pnpm build               # Production build
cd web && pnpm release             # Build SPA into server/router/frontend/dist

# Protocol Buffers
cd proto && buf generate           # Regenerate Go + TypeScript + OpenAPI
cd proto && buf lint               # Lint proto files
cd proto && buf format -w          # Format proto files
```

## Code Map

| Path | Purpose |
| --- | --- |
| `cmd/memos/main.go` | Cobra/Viper CLI setup and server startup |
| `server/server.go` | Echo HTTP server and background runner wiring |
| `server/auth/` | JWT access tokens, refresh tokens, PAT handling |
| `server/router/api/v1/` | Connect/gRPC-Gateway services, ACL config, SSE hub |
| `server/router/frontend/` | Static SPA serving |
| `server/router/fileserver/` | Native HTTP file serving, thumbnails, range requests |
| `server/runner/` | Background memo processing and S3 presign refresh |
| `store/` | Store facade, cache, migrations, driver interface |
| `store/db/{sqlite,mysql,postgres}/` | Database-specific drivers and SQL |
| `proto/api/v1/` | Public API service definitions |
| `proto/store/` | Internal storage proto messages |
| `internal/` | App-private packages: scheduler, cron, email, CEL filter, markdown, idp, S3 |
| `web/src/connect.ts` | Connect RPC clients, auth interceptor, access-token refresh |
| `web/src/auth-state.ts` | Token storage and BroadcastChannel cross-tab sync |
| `web/src/hooks/` | React Query hooks for server state |
| `web/src/contexts/` | React context for client/UI state |
| `web/src/components/` | Radix/Tailwind UI components and feature components |
| `web/src/themes/` | CSS themes using OKLch color tokens |

## Change Routing

| Change | Update | Verify |
| --- | --- | --- |
| Go service or router behavior | Service code under `server/`, tests near package | `go test -v -race ./server/...` |
| Store or migration behavior | `store/`, all three DB driver migrations, `LATEST.sql` | `go test -v ./store/...` |
| Internal package logic | Relevant `internal/` package tests | `go test -v -race ./internal/...` |
| Frontend behavior | Components/hooks/contexts under `web/src/` | `cd web && pnpm lint && pnpm test` |
| Frontend production output | Vite config or release-sensitive UI | `cd web && pnpm build` or `pnpm release` |
| CI or version tooling | `.github/`, root metadata, `scripts/ci*` and `scripts/release-check*` | Root `corepack pnpm test`, `check:release`, Actionlint; verify affected GitHub jobs |
| Browser extension | `extensions/web-clipper/` (independent pnpm 11.10.0) | Extension lint/test/build, Python packaging tests and `package:release`; see module AGENTS.md |
| Proto API | `.proto` source plus generated outputs | `cd proto && buf generate && buf lint` |
| Public unauthenticated route | `server/router/api/v1/acl_config.go` | Targeted server test or manual route check |

## Go Conventions

- Wrap errors with `errors.Wrap(err, "context")` from `github.com/pkg/errors`; do not use `fmt.Errorf`.
- Return service errors with `status.Errorf(codes.X, "message")`.
- Keep imports grouped as stdlib, third-party, then `github.com/usememos/memos`; goimports is run by golangci-lint.
- Add doc comments for exported identifiers; godot enforces exported comment punctuation.
- Avoid package-level mutable state unless the surrounding package already uses that pattern.

## Frontend Conventions

- Use `@/` for absolute imports.
- Follow Biome formatting: 2-space indent, double quotes, semicolons, 140-character line width.
- Put server data in React Query hooks under `web/src/hooks/`; keep UI-only state in contexts or component state.
- Use Tailwind CSS v4 utilities, `cn()` for class merging, and CVA for variants.
- Reuse Radix primitives and existing components before adding new UI primitives.
- Keep generated proto TypeScript under `web/src/types/proto/` out of manual edits and Biome rewrites.

## Database And Proto Rules

- Schema changes require SQLite, MySQL, and PostgreSQL migrations plus `LATEST.sql` updates.
- Fresh-install SQL and incremental migrations must stay equivalent.
- Proto field changes must preserve compatibility unless the task explicitly allows a breaking API change.
- Regenerate after proto edits and include both Go/OpenAPI and TypeScript generated outputs.

## Verification Policy

- Run the narrowest relevant checks while iterating.
- Before finishing, run the checks that match the changed surface from "Change Routing".
- For docs-only changes, `git diff --check` is sufficient unless the docs include runnable examples that should be tested.
- If a required check cannot run locally, report the reason and the exact command that remains.
- The local helper's SQLite checks do not replace all-driver store or container upgrade checks required by the changed surface.

## CI Reference

- Backend CI: Go 1.26.2, `go mod tidy -go=1.26.2`, golangci-lint v2.11.3, test groups `store`, `server`, `internal`, `other`.
- Frontend CI: Node 24, pnpm 11.0.1, `pnpm lint`, `pnpm test`, `pnpm build`.
- Web clipper CI: Node 24, pnpm 11.10.0, lint/test/build and deterministic Chromium ZIP; version PR releases include the ZIP and checksums.
- Proto CI: `buf lint` and `buf format` check.
- Docker: `scripts/Dockerfile`, Node 22.23.2 / Alpine 3.23 runtime（含服务端 PDF 排版组件）, non-root user, port 5230, multi-arch amd64/arm64/arm/v7.
