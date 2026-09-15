#!/usr/bin/env python3
"""Local-only Memos development lifecycle; Python standard library, macOS/Linux."""

import argparse
import base64
import contextlib
import fcntl
import http.cookiejar
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / "tmp/local-dev"
DATA = LOCAL / "data"
BASE = "http://127.0.0.1:8081"
PREVIEW = "http://127.0.0.1:3001"
USERNAME = "local-dev"
PASSWORD = "local-dev-only-2026"
# This credential belongs only to disposable loopback test data.
OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)


def run(args, cwd=ROOT, env=None):
    print("+ " + " ".join(map(str, args)), flush=True)
    subprocess.run(args, cwd=cwd, env=env, check=True)


def pnpm(*args):
    # Corepack reads web/package.json's pinned packageManager, without a global install.
    run(["corepack", "pnpm", *args], cwd=ROOT / "web")


def local_env():
    return {k: v for k, v in os.environ.items() if not k.startswith("MEMOS_") and k not in ("DRIVER", "DSN")}


@contextlib.contextmanager
def lifecycle_lock():
    LOCAL.mkdir(parents=True, exist_ok=True)
    with (LOCAL / "lifecycle.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Local development is running. Stop it with Ctrl-C before starting or resetting.") from None
        yield


def require_free_ports():
    for port in (8081, 3001):
        with socket.socket() as sock:
            # Recently stopped HTTP connections may still be in TIME_WAIT.
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                raise RuntimeError(f"Port {port} is occupied. Stop its owner before continuing.") from None


def api(method, path, body=None, token=""):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method
    )
    with OPENER.open(request, timeout=10) as response:
        return json.load(response)


def get_optional(path, token):
    try:
        return api("GET", path, token=token)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def fixture_png():
    """Create a deterministic 320x180 PNG for attachment rendering checks."""
    def chunk(kind, content):
        return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content))

    rows = b"".join(b"\0" + bytes((45, 120 + y // 3, 175)) * 320 for y in range(180))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 320, 180, 8, 2, 0, 0, 0)) + chunk(
        b"IDAT", zlib.compress(rows)
    ) + chunk(b"IEND", b"")


def seed():
    # Called only by start(), after this process acquires the lock and launches the backend.
    marker = DATA / "seed-v1.json"
    try:
        signed_in = api("POST", "/memos.api.v1.AuthService/SignIn", {"passwordCredentials": {"username": USERNAME, "password": PASSWORD}})
    except urllib.error.HTTPError as error:
        if marker.exists() or error.code != 400:
            raise
        api("POST", "/api/v1/users", {"username": USERNAME, "password": PASSWORD, "displayName": "本地测试"})
        signed_in = api("POST", "/memos.api.v1.AuthService/SignIn", {"passwordCredentials": {"username": USERNAME, "password": PASSWORD}})
    token = signed_in["accessToken"]
    try:
        if marker.exists():
            print("Reusing existing local test data.", flush=True)
            return
        user_name = signed_in["user"]["name"]
        settings = api("PATCH", f"/api/v1/{user_name}/settings/GENERAL?updateMask=locale,memo_visibility", {
            "generalSetting": {"locale": "zh-Hans", "memoVisibility": "PRIVATE"}
        }, token)
        if settings.get("generalSetting", {}).get("locale") != "zh-Hans" or settings.get("generalSetting", {}).get("memoVisibility") != "PRIVATE":
            raise RuntimeError("Test user preferences were not saved.")
        samples = {
            "local-welcome": "本地测试环境 👋\n\n这里是虚构测试数据，可通过开发命令重置。\n\n#本地测试 #收件箱",
            "local-markdown": "# Markdown 与任务列表\n\n- [ ] 测试编辑和保存\n- [x] 测试中文与 emoji ✅\n\n**粗体**、*斜体*、`code`\n\n#本地测试/编辑器",
            "local-long": "长文本与窄屏换行\n\n" + "\n\n".join(
                f"第 {i} 段：这是一段用于验证滚动、折叠与编辑体验的中文测试内容。" * 3 for i in range(1, 13)
            ) + "\n\n#本地测试/长文本",
            "local-image": "图片附件验证：检查加载、比例和点击预览。\n\n#本地测试/图片",
        }
        for memo_id, content in samples.items():
            if get_optional("/api/v1/memos/" + memo_id, token) is None:
                api("POST", "/api/v1/memos?memoId=" + memo_id, {"content": content, "visibility": "PRIVATE"}, token)
        if get_optional("/api/v1/attachments/local-fixture", token) is None:
            api("POST", "/api/v1/attachments?attachmentId=local-fixture", {
                "filename": "local-fixture.png", "type": "image/png",
                "content": base64.b64encode(fixture_png()).decode(), "memo": "memos/local-image"
            }, token)
        for memo_id, content in samples.items():
            if api("GET", "/api/v1/memos/" + memo_id, token=token)["content"] != content:
                raise RuntimeError("Fixture readback mismatch: " + memo_id)
        attachment = api("GET", "/api/v1/attachments/local-fixture", token=token)
        if attachment.get("memo") != "memos/local-image":
            raise RuntimeError("Fixture attachment is not associated with its memo.")
        marker.write_text(json.dumps({"version": 1, "memos": list(samples)}, indent=2) + "\n")
        print("Seeded and read back 4 private memos and 1 image attachment.", flush=True)
    finally:
        api("POST", "/memos.api.v1.AuthService/SignOut", {}, token)


def wait_ready(url, processes):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            raise RuntimeError("A development process exited; inspect tmp/local-dev/logs/.")
        try:
            with OPENER.open(url, timeout=2) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(0.25)
    raise RuntimeError("Startup timed out; inspect tmp/local-dev/logs/.")


def start():
    with lifecycle_lock():
        require_free_ports()
        DATA.mkdir(exist_ok=True)
        (LOCAL / "bin").mkdir(exist_ok=True)
        (LOCAL / "logs").mkdir(exist_ok=True)
        vite = ROOT / "web/node_modules/vite/bin/vite.js"
        if not vite.exists():
            raise RuntimeError("Run ./scripts/dev.sh setup first.")
        binary = LOCAL / "bin/memos"
        run(["go", "build", "-o", str(binary), "./cmd/memos"])
        processes = []
        with contextlib.ExitStack() as stack:
            try:
                backend_log = stack.enter_context((LOCAL / "logs/backend.log").open("w"))
                processes.append(subprocess.Popen([
                    str(binary), "--addr", "127.0.0.1", "--port", "8081", "--driver", "sqlite",
                    "--data", str(DATA), "--dsn", str(DATA / "memos_prod.db"), "--instance-url", "", "--demo=false"
                ], cwd=ROOT, env=local_env(), stdout=backend_log, stderr=subprocess.STDOUT, start_new_session=True))
                wait_ready(BASE + "/api/v1/instance/profile", processes)
                seed()
                frontend_log = stack.enter_context((LOCAL / "logs/frontend.log").open("w"))
                frontend_env = local_env() | {"DEV_PROXY_SERVER": BASE}
                processes.append(subprocess.Popen([
                    "node", str(vite), "--host", "127.0.0.1", "--port", "3001", "--strictPort"
                ], cwd=ROOT / "web", env=frontend_env, stdout=frontend_log, stderr=subprocess.STDOUT, start_new_session=True))
                wait_ready(PREVIEW, processes)
                print(f"\nReady: {PREVIEW}\nTest login: {USERNAME} / {PASSWORD}\nLogs: {LOCAL / 'logs'}\nCtrl-C stops both services.\n", flush=True)
                while all(process.poll() is None for process in processes):
                    time.sleep(0.5)
                raise RuntimeError("A development process exited; inspect tmp/local-dev/logs/.")
            finally:
                for process in reversed(processes):
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGTERM)
                for process in processes:
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        with contextlib.suppress(ProcessLookupError):
                            os.killpg(process.pid, signal.SIGKILL)
                        process.wait()


def reset():
    # Reset by moving the exact test directory; no arbitrary path or recursive deletion.
    with lifecycle_lock():
        require_free_ports()
        if DATA.is_symlink():
            raise RuntimeError("Refusing to reset a symlinked data directory.")
        if DATA.exists():
            archive = LOCAL / ("data-before-reset-" + time.strftime("%Y%m%d-%H%M%S") + "-" + str(time.time_ns()))
            DATA.rename(archive)
            print("Previous test data retained at " + str(archive))
        print("Next start will create fresh test data.")


def setup():
    run(["node", "--version"])
    run(["go", "version"])
    pnpm("install", "--frozen-lockfile")
    run(["go", "mod", "download"])


def check(surface):
    if surface in ("frontend", "all"):
        pnpm("lint")
        pnpm("test")
        pnpm("build")
    if surface in ("backend", "all"):
        run(["go", "test", "-race", "./server/...", "./internal/..."], env=local_env())
        run(["go", "test", "./store/..."], env=local_env() | {"DRIVER": "sqlite"})
    run(["git", "diff", "--check"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "start", "reset", "check", "help"), nargs="?", default="help")
    parser.add_argument("surface", choices=("frontend", "backend", "all"), nargs="?", default="all")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if args.command == "help":
        parser.print_help()
    elif args.command == "check":
        check(args.surface)
    else:
        {"setup": setup, "start": start, "reset": reset}[args.command]()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nLocal development stopped.")
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
