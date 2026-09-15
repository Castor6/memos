#!/usr/bin/env bash
# Local development entry point. Keep Node selection scoped to this process.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-help}" in
  setup|start|check)
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    if [[ "$node_major" != "$(cat "$repo_root/.node-version")" ]]; then
      if ! command -v fnm >/dev/null; then
        echo 'Install/select Node 24, or install fnm, then retry.' >&2
        exit 1
      fi
      if [[ "${1:-}" == setup ]]; then
        fnm install "$(cat "$repo_root/.node-version")"
      fi
      exec fnm exec --using "$(cat "$repo_root/.node-version")" python3 "$repo_root/scripts/dev.py" "$@"
    fi
    ;;
esac
exec python3 "$repo_root/scripts/dev.py" "$@"
