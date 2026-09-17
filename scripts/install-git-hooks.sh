#!/usr/bin/env bash
# Install the shared local hook without replacing unrelated user hooks.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
if [[ -n "$(git config --get core.hooksPath || true)" ]]; then
  echo '检测到自定义 core.hooksPath；请在现有 pre-commit 中接入 git diff --cached --check，未修改配置。' >&2
  exit 1
fi
hook_path="$(git rev-parse --git-path hooks)/pre-commit"
if [[ -e "$hook_path" || -L "$hook_path" ]]; then
  if [[ -L "$hook_path" ]] || ! head -n 2 "$hook_path" | tail -n 1 | grep -qx '# memos-managed-whitespace-hook'; then
    echo '检测到已有自定义 pre-commit；请在其中接入 git diff --cached --check，未覆盖文件。' >&2
    exit 1
  fi
fi
mkdir -p "$(dirname "$hook_path")"
cp .githooks/pre-commit "$hook_path"
chmod +x "$hook_path"
echo '已安装提交前空白检查（当前仓库及其 worktree 共享）。'
