#!/usr/bin/env python3
"""Pull a tested release, back up stopped SQLite data, and update one Compose service."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request


def write_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as stream:
        os.chmod(temp, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def version_tuple(value):
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value):
        raise ValueError("Invalid personal release version")
    return tuple(map(int, value.split(".")))


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class Updater:
    def __init__(self, config):
        self.config = config
        self.app = Path(config["app_dir"]).resolve()
        self.state = Path(config["state_dir"]).resolve()
        self.backups = Path(config["backup_dir"]).resolve()
        self.overlay = self.app / "deployment-image.json"
        self.marker = self.state / "maintenance"
        self.pending = self.state / "pending.json"
        self.repo = config["image_repository"]
        if not re.fullmatch(r"[a-z0-9.-]+/[a-z0-9_./-]+", self.repo):
            raise ValueError("Invalid registry repository")
        for path in (self.app, self.state, self.backups):
            if str(path) in ("/", "/opt", "/etc", "/var", "/var/lib"):
                raise ValueError("Use dedicated application/state/backup directories")
        if any(self.app == path or self.app in path.parents for path in (self.state, self.backups)):
            raise ValueError("State and backup directories must be outside the application")
        self.state.mkdir(mode=0o755, parents=True, exist_ok=True)
        self.backups.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.backup = None
        self.snapshot = None
        self.changed = False

    def run(self, *args, timeout=180):
        result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout)
        return result.stdout.strip()

    def compose(self, *args):
        command = ["docker", "compose", "--project-directory", str(self.app), "-f", str(self.app / "compose.yaml")]
        if self.overlay.exists():
            command += ["-f", str(self.overlay)]
        return self.run(*command, *args)

    def profile(self):
        with urllib.request.urlopen(self.config["profile_url"], timeout=5) as response:
            return json.load(response)

    def wait_healthy(self, version, commit):
        for _ in range(self.config.get("health_attempts", 45)):
            try:
                profile = self.profile()
                if profile.get("version") == version and profile.get("commit") == commit and not profile.get("needsSetup"):
                    with urllib.request.urlopen(self.config["profile_url"].split("/api/")[0] + "/", timeout=5) as response:
                        if b'id="root"' in response.read():
                            return
            except (OSError, ValueError):
                pass
            time.sleep(2)
        raise RuntimeError("Application version, commit, setup state or frontend health check failed")

    def verify_maintenance(self):
        context = ssl.create_default_context(cafile=self.config["ca_file"])
        try:
            urllib.request.urlopen(self.config["public_health_url"], context=context, timeout=10).close()
        except urllib.error.HTTPError as error:
            if error.code == 503 and error.headers.get("X-Memos-Maintenance") == "1":
                return
        raise RuntimeError("Public maintenance gate is not active; refusing to stop the application")

    def read_state(self, name):
        path = self.state / name
        return json.loads(path.read_text()) if path.exists() else {}

    def candidate(self):
        # Pull happens before maintenance or stopping the old service.
        for attempt in range(3):
            try:
                self.run("docker", "pull", self.repo + ":stable", timeout=300)
                break
            except (subprocess.SubprocessError, OSError):
                if attempt == 2:
                    raise
                time.sleep(5)
        info = json.loads(self.run("docker", "image", "inspect", self.repo + ":stable"))[0]
        labels = info["Config"].get("Labels") or {}
        version = labels.get("org.opencontainers.image.version", "")
        commit = labels.get("org.opencontainers.image.revision", "")
        version_tuple(version)
        if labels.get("org.opencontainers.image.source") != "https://github.com/Castor6/memos" or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise RuntimeError("Unexpected release source or commit")
        if info.get("Architecture") != "amd64" or info.get("Os") != "linux":
            raise RuntimeError("This deployment supports Linux amd64 only")
        digests = [value for value in info.get("RepoDigests", []) if value.startswith(self.repo + "@sha256:")]
        if len(digests) != 1 or not re.fullmatch(re.escape(self.repo) + r"@sha256:[0-9a-f]{64}", digests[0]):
            raise RuntimeError("Expected one registry digest")
        return {"image": digests[0], "version": version, "commit": commit}

    def data_snapshot(self):
        database = self.app / "data" / "memos_prod.db"
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise RuntimeError("SQLite integrity check failed")
            counts = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in ("user", "memo", "attachment")}
        files = {str(path.relative_to(self.app)): sha256(path) for path in (self.app / "data").rglob("*")
                 if path.is_file() and not path.name.startswith("memos_prod.db")}
        return {"counts": counts, "files": files}

    def verify_data(self):
        after = self.data_snapshot()
        if any(after["counts"][key] < value for key, value in self.snapshot["counts"].items()):
            raise RuntimeError("User, memo or attachment count decreased")
        if any(after["files"].get(key) != value for key, value in self.snapshot["files"].items()):
            raise RuntimeError("Attachment file missing or changed")

    def make_backup(self):
        size = sum(path.stat().st_size for path in self.app.rglob("*") if path.is_file())
        if shutil.disk_usage(self.backups).free < size * 3 + 512 * 1024 * 1024:
            raise RuntimeError("Insufficient space for backup and recovery")
        directory = self.backups / (time.strftime("%Y%m%d-%H%M%S") + "-" + str(os.getpid()))
        directory.mkdir(mode=0o700)
        archive = directory / "before-update.tar"
        includes = [str(self.app).lstrip("/")]
        includes += [str(Path(path).resolve()).lstrip("/") for path in self.config.get("backup_paths", [])]
        self.run("tar", "--acls", "--xattrs", "-cpf", str(archive), "-C", "/", *includes, timeout=300)
        os.chmod(archive, 0o600)
        self.run("tar", "--compare", "-f", str(archive), "-C", "/", timeout=300)
        write_json(directory / "manifest.json", {"sha256": sha256(archive), "snapshot": self.snapshot})
        self.backup = archive

    def restore(self):
        manifest = json.loads((self.backup.parent / "manifest.json").read_text())
        if sha256(self.backup) != manifest["sha256"]:
            raise RuntimeError("Backup checksum mismatch; maintenance stays active")
        stage = self.backup.parent / "restore"
        stage.mkdir(mode=0o700)
        self.run("tar", "--acls", "--xattrs", "-xpf", str(self.backup), "-C", str(stage), timeout=300)
        restored = stage / str(self.app).lstrip("/")
        if not (restored / "compose.yaml").is_file() or not (restored / "data" / "memos_prod.db").is_file():
            raise RuntimeError("Backup lacks required application files")
        # Keep the failed candidate's data for inspection. Never overwrite it.
        self.app.rename(self.backup.parent / "failed-application")
        restored.rename(self.app)

    def update(self, dry_run=False, retry=False):
        if self.pending.exists() or self.marker.exists():
            raise RuntimeError("Unfinished deployment; inspect pending.json and recover before retrying")
        candidate = self.candidate()
        deployed = self.read_state("deployed.json")
        if candidate["image"] == deployed.get("image"):
            print("Already running the published digest")
            return
        if deployed and version_tuple(candidate["version"]) <= version_tuple(deployed["version"]):
            raise RuntimeError("Release channel would downgrade or replace an existing version")
        if not retry and self.read_state("failed.json").get("image") == candidate["image"]:
            raise RuntimeError("This digest previously failed; inspect logs and explicitly retry")
        old = self.profile()
        if old.get("needsSetup"):
            raise RuntimeError("Expected an initialized application")
        if not self.compose("ps", "--status", "running", "-q", "memos"):
            raise RuntimeError("Existing service must be running")
        print("Candidate " + candidate["version"] + " " + candidate["image"], flush=True)
        if dry_run:
            return
        write_json(self.pending, {"candidate": candidate, "previous": {key: old[key] for key in ("version", "commit")}, "phase": "prepared"})
        self.marker.touch(mode=0o644)
        os.chmod(self.marker, 0o644)
        stopped = False
        try:
            self.verify_maintenance()
            stopped = True
            self.compose("stop", "-t", "45", "memos")
            self.snapshot = self.data_snapshot()
            self.make_backup()
            write_json(self.pending, {"candidate": candidate, "backup": str(self.backup), "phase": "backed_up"})
            write_json(self.overlay, {"services": {"memos": {"image": candidate["image"], "pull_policy": "never"}}})
            self.changed = True
            self.compose("up", "-d", "--no-deps", "--pull", "never", "memos")
            self.wait_healthy(candidate["version"], candidate["commit"])
            self.verify_data()
            write_json(self.state / "deployed.json", {**candidate, "backup": str(self.backup), "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
        except Exception:
            if stopped:
                if self.changed:
                    self.compose("stop", "-t", "45", "memos")
                    self.restore()
                self.compose("up", "-d", "--no-deps", "--pull", "never", "memos")
                self.wait_healthy(old["version"], old["commit"])
            write_json(self.state / "failed.json", candidate)
            self.pending.unlink()
            self.marker.unlink()
            raise
        self.pending.unlink()
        self.marker.unlink()
        print("Deployment healthy; maintenance ended; backup: " + str(self.backup), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/memos-update/config.json")
    parser.add_argument("--dry-run", action="store_true", help="Download and validate only, without stopping the app")
    parser.add_argument("--retry", action="store_true", help="Retry a previously failed digest after investigation")
    args = parser.parse_args()
    os.umask(0o077)
    updater = Updater(json.loads(Path(args.config).read_text()))
    # nginx workers must be able to stat the marker, but state files stay private.
    os.chmod(updater.state, 0o755)
    with (updater.state / "update.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another deployment is active")
            return
        updater.update(args.dry_run, args.retry)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Deployment failed: " + str(error), file=sys.stderr)
        sys.exit(1)
