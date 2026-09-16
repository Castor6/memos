#!/usr/bin/env python3
"""Exercise real Compose switching and Nginx maintenance using disposable data only.

Run as root on Linux with Docker, nginx, openssl and the official 0.30.0 image.
The test starts a separate nginx master on loopback; it never reloads system nginx.
"""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.request
import uuid

spec = importlib.util.spec_from_file_location("memos_update", Path(__file__).with_name("memos-update.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Run as root on a Linux test host")
    for tool in ("docker", "nginx", "openssl"):
        if not shutil.which(tool):
            raise RuntimeError(tool + " is required")
    root = Path(tempfile.mkdtemp(prefix="memos-deploy-integration-"))
    root.chmod(0o755)
    project = "memos-integration-" + uuid.uuid4().hex[:10]
    bad_image = project + ":bad"
    old_image = "ghcr.io/usememos/memos:0.30.0"
    nginx = None
    updater = None
    try:
        run("docker", "image", "inspect", old_image)
        app = root / "app"
        (app / "data").mkdir(parents=True)
        backend_port, public_port = free_port(), free_port()
        (app / "compose.yaml").write_text(json.dumps({"name": project, "services": {"memos": {
            "image": old_image, "pull_policy": "never", "mem_limit": "192m",
            "ports": [f"127.0.0.1:{backend_port}:5230"], "volumes": ["./data:/var/opt/memos"]}}}))
        run("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
            "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"))
        updater = module.Updater({"app_dir": str(app), "state_dir": str(root / "state"),
                                  "backup_dir": str(root / "backups"), "image_repository": "registry.example/test/memos",
                                  "profile_url": f"http://127.0.0.1:{backend_port}/api/v1/instance/profile",
                                  "public_health_url": f"https://127.0.0.1:{public_port}/healthz",
                                  "ca_file": str(root / "cert.pem"), "health_attempts": 5})
        maintenance = Path(__file__).with_name("maintenance.nginx.conf").read_text().replace(
            "/var/lib/memos-update/maintenance", str(updater.marker))
        (root / "nginx.conf").write_text(f"""pid {root}/nginx.pid;
error_log {root}/nginx-error.log;
events {{ worker_connections 64; }}
http {{ access_log off; server {{ listen 127.0.0.1:{public_port} ssl;
ssl_certificate {root}/cert.pem; ssl_certificate_key {root}/key.pem;
{maintenance}
location / {{ proxy_pass http://127.0.0.1:{backend_port}; }}
}} }}
""")
        nginx = subprocess.Popen(["nginx", "-p", str(root), "-c", str(root / "nginx.conf"), "-g", "daemon off;"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        updater.compose("up", "-d", "memos")
        for attempt in range(30):
            try:
                old = updater.profile()
                break
            except OSError:
                if attempt == 29:
                    raise
                time.sleep(1)
        base = updater.config["profile_url"].split("/api/")[0]

        def api(path, payload, token=None):
            headers = {"Content-Type": "application/json"}
            if token:
                headers["Authorization"] = "Bearer " + token
            request = urllib.request.Request(base + path, data=json.dumps(payload).encode(), headers=headers)
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)

        api("/api/v1/users", {"username": "integration", "password": "disposable-test-password"})
        token = api("/api/v1/auth/signin", {"passwordCredentials": {"username": "integration", "password": "disposable-test-password"}})["accessToken"]
        api("/api/v1/memos?memoId=sentinel", {"content": "disposable integration sentinel", "visibility": "PRIVATE"}, token)
        (app / "data" / "attachment.bin").write_bytes(b"original attachment\x00\xff")
        digest = json.loads(run("docker", "image", "inspect", old_image))[0]["RepoDigests"][0]
        release = {"image": digest, "version": old["version"], "commit": old["commit"]}
        updater.candidate = lambda: release
        updater.update()
        before = updater.data_snapshot()
        context = ssl.create_default_context(cafile=str(root / "cert.pem"))
        with urllib.request.urlopen(updater.config["public_health_url"], context=context, timeout=5) as response:
            assert response.status == 200
        # A real candidate writes damaged attachment data, then fails version health.
        (root / "Dockerfile").write_text(f"FROM {old_image}\nENTRYPOINT [\"/bin/sh\", \"-c\", \"printf damaged > /var/opt/memos/attachment.bin; exec /usr/local/memos/entrypoint.sh /usr/local/memos/memos\"]\n")
        run("docker", "build", "-t", bad_image, str(root))
        release = {"image": bad_image, "version": "0.31.0", "commit": "f" * 40}
        # Use a new updater instance as the systemd service does on each run.
        updater = module.Updater(updater.config)
        updater.candidate = lambda: release
        try:
            updater.update()
        except RuntimeError as error:
            assert "health check failed" in str(error), str(error)
        else:
            raise AssertionError("Damaged candidate unexpectedly passed")
        assert updater.data_snapshot() == before
        assert not updater.marker.exists() and not updater.pending.exists()
        failed_data = updater.backup.parent / "failed-application/data/attachment.bin"
        assert failed_data.read_bytes() == b"damaged"
        api("/api/v1/auth/signin", {"passwordCredentials": {"username": "integration", "password": "disposable-test-password"}})
        with urllib.request.urlopen(updater.config["public_health_url"], context=context, timeout=5) as response:
            assert response.status == 200
        print("PASS: real Compose update, HTTPS maintenance, damaged candidate rollback, SQLite/attachment preservation and login")
    finally:
        if updater:
            updater.compose("down", "--remove-orphans")
        if nginx:
            nginx.terminate()
            nginx.wait(timeout=10)
        subprocess.run(["docker", "image", "rm", bad_image], capture_output=True)
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
