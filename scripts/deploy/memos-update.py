#!/usr/bin/env python3
"""Pull a tested release, back up stopped SQLite data, and update one Compose service."""

import argparse
import fcntl
import hashlib
import json
import math
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
        retained = config.get("retained_image_repositories", [])
        if not isinstance(retained, list) or len(retained) > 2:
            raise ValueError("Expected at most two retained repositories")
        self.repositories = [self.repo, *retained]
        if len(set(self.repositories)) != len(self.repositories) or any(
                not isinstance(repo, str) or not re.fullmatch(r"[a-z0-9.-]+/[a-z0-9_./-]+", repo)
                for repo in self.repositories):
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
        # Only the explicitly selected channel is contacted; no automatic failover.
        repository = self.repo
        for attempt in range(3):
            try:
                self.run("docker", "pull", repository + ":stable", timeout=300)
                break
            except (subprocess.SubprocessError, OSError):
                if attempt == 2:
                    raise
                time.sleep(5)
        info = json.loads(self.run("docker", "image", "inspect", repository + ":stable"))[0]
        labels = info["Config"].get("Labels") or {}
        version = labels.get("org.opencontainers.image.version", "")
        commit = labels.get("org.opencontainers.image.revision", "")
        version_tuple(version)
        if labels.get("org.opencontainers.image.source") != "https://github.com/Castor6/memos" or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise RuntimeError("Unexpected release source or commit")
        if info.get("Architecture") != "amd64" or info.get("Os") != "linux":
            raise RuntimeError("This deployment supports Linux amd64 only")
        digests = [value for value in info.get("RepoDigests", []) if value.startswith(repository + "@sha256:")]
        if len(digests) != 1 or not re.fullmatch(re.escape(repository) + r"@sha256:[0-9a-f]{64}", digests[0]):
            raise RuntimeError("Expected one registry digest")
        return {"image": digests[0], "version": version, "commit": commit, "image_id": info["Id"]}

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
        previous_image = self.previous_image_id()
        write_json(directory / "retention.json", {"schema": 1, "created_at": time.time(),
                   "previous_image_id": previous_image, "archive_sha256": sha256(archive), "status": "pending"})
        self.backup = archive

    def previous_image_id(self):
        container = self.compose("ps", "-a", "-q", "memos")
        return json.loads(self.run("docker", "inspect", container))[0]["Image"]

    def verify_image_id(self, image):
        if json.loads(self.run("docker", "image", "inspect", image))[0]["Id"] != image:
            raise RuntimeError("Recovery image ID mismatch")

    def finish_backup(self, status):
        try:
            if self.backup and (self.backup.parent / "retention.json").is_file():
                path = self.backup.parent / "retention.json"
                record = json.loads(path.read_text())
                record["status"] = status
                write_json(path, record)
        except (OSError, ValueError) as error:
            # Leave incomplete metadata protected; it must not prevent recovery.
            print("Backup status could not be recorded: " + str(error), file=sys.stderr)

    def retention_plan(self, now=None):
        if self.pending.exists() or self.marker.exists():
            raise RuntimeError("Unfinished deployment; cleanup refused")
        now = time.time() if now is None else now
        keep_count = self.config.get("backup_keep_count", 3)
        keep_days = self.config.get("backup_keep_days", 30)
        if type(keep_count) is not int or keep_count < 3 or type(keep_days) is not int or keep_days < 30:
            raise RuntimeError("Retention must keep at least 3 backups and 30 days")
        deployed = self.read_state("deployed.json")
        if not deployed.get("image") or not deployed.get("backup"):
            raise RuntimeError("No successful deployment record; cleanup refused")
        records = []
        for directory in self.backups.iterdir():
            if directory.is_symlink() or not directory.is_dir() or not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9]+", directory.name):
                raise RuntimeError("Unknown backup entry; cleanup refused: " + directory.name)
            for name in ("before-update.tar", "manifest.json", "retention.json"):
                path = directory / name
                if path.is_symlink() or not path.is_file():
                    raise RuntimeError("Incomplete/legacy backup; cleanup refused: " + directory.name)
            record = json.loads((directory / "retention.json").read_text())
            manifest = json.loads((directory / "manifest.json").read_text())
            if (record.get("schema") != 1 or record.get("status") not in ("pending", "failed", "success")
                    or type(record.get("created_at")) not in (int, float) or not math.isfinite(record["created_at"])
                    or record["created_at"] <= 0
                    or not re.fullmatch(r"sha256:[0-9a-f]{64}", record.get("previous_image_id", ""))
                    or not re.fullmatch(r"[0-9a-f]{64}", manifest.get("sha256", ""))
                    or record.get("archive_sha256") != manifest["sha256"]):
                raise RuntimeError("Invalid backup metadata; cleanup refused: " + directory.name)
            records.append((directory, record, manifest))
        records.sort(key=lambda entry: (entry[1]["created_at"], entry[0].name), reverse=True)
        keep, remove, protected = [], [], set()
        for index, (directory, record, manifest) in enumerate(records):
            reasons = []
            if index < keep_count:
                reasons.append("latest backups")
            if record["created_at"] >= now - keep_days * 86400:
                reasons.append("within retention days")
            if record["status"] != "success":
                reasons.append("failed or unfinished upgrade")
            if str(directory / "before-update.tar") == deployed["backup"]:
                reasons.append("current recovery point")
            if set(path.name for path in directory.iterdir()) != {"before-update.tar", "manifest.json", "retention.json"}:
                reasons.append("extra recovery or unknown files")
            if not reasons and sha256(directory / "before-update.tar") != manifest["sha256"]:
                reasons.append("archive checksum mismatch")
            item = {"directory": str(directory), "image_id": record["previous_image_id"], "reasons": reasons}
            if reasons:
                keep.append(item)
                protected.add(record["previous_image_id"])
            else:
                remove.append(item)
        if not any(str(d / "before-update.tar") == deployed["backup"] for d, _, _ in records):
            raise RuntimeError("Current recovery point is missing; cleanup refused")
        # Inspect every container, including stopped containers. Never force-remove an image.
        container_ids = self.run("docker", "ps", "-aq").split()
        if container_ids:
            protected.update(item["Image"] for item in json.loads(self.run("docker", "inspect", *container_ids)))
        current = json.loads(self.run("docker", "image", "inspect", deployed["image"]))[0]["Id"]
        protected.add(current)
        retired = self.read_state("retired-images.json").get("images", [])
        if not isinstance(retired, list) or any(not isinstance(i, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", i) for i in retired):
            raise RuntimeError("Invalid retired image journal")
        candidates = set(retired) | {item["image_id"] for item in remove}
        image_ids = sorted(set(self.run("docker", "image", "ls", "-aq", "--no-trunc").split()))
        inventory = json.loads(self.run("docker", "image", "inspect", *image_ids)) if image_ids else []
        images = []
        for info in inventory:
            if info["Id"] not in candidates or info["Id"] in protected:
                continue
            digests = info.get("RepoDigests") or []
            # Only the configured repository and the two historical upstream repositories.
            repos = (*self.repositories, "ghcr.io/usememos/memos", "neosmemo/memos")
            source = (info.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.source")
            if source != "https://github.com/Castor6/memos" and not any(d.startswith(repo + "@sha256:") for d in digests for repo in repos):
                continue
            images.append(info["Id"])
        return {"keep_backups": keep, "remove_backups": remove, "remove_images": images,
                "protected_images": sorted(protected), "retired_images": sorted(candidates),
                "policy": {"keep_count": keep_count, "keep_days": keep_days}}

    def cleanup(self, dry_run=False):
        plan = self.retention_plan()
        if dry_run:
            print(json.dumps(plan, indent=2))
            return plan
        report = {"started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "plan": plan,
                  "deleted_backups": [], "deleted_images": []}
        try:
            # Persist image IDs before deleting their last backup reference, so failed
            # image deletions can be retried after a later successful upgrade.
            write_json(self.state / "retired-images.json", {"images": plan["retired_images"]})
            for item in plan["remove_backups"]:
                shutil.rmtree(item["directory"])
                report["deleted_backups"].append(item["directory"])
                print("Cleanup removed backup: " + item["directory"], flush=True)
            # Re-evaluate references after backup deletion, before touching images.
            for image in self.retention_plan()["remove_images"]:
                self.run("docker", "image", "rm", image)
                report["deleted_images"].append(image)
                print("Cleanup removed image: " + image, flush=True)
            remaining = set(plan["retired_images"]) - set(report["deleted_images"])
            write_json(self.state / "retired-images.json", {"images": sorted(remaining)})
        except Exception as error:
            report["error"] = str(error)
            raise
        finally:
            write_json(self.state / "cleanup-last.json", report)
        print("Cleanup completed: " + str(len(report["deleted_backups"])) + " backups, "
              + str(len(report["deleted_images"])) + " images", flush=True)
        return report

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
        # A moved stable tag can leave the previous image without RepoDigests.
        # Recover with the recorded local immutable ID, not the vanished registry alias.
        retention = self.backup.parent / "retention.json"
        if retention.exists():
            record = json.loads(retention.read_text())
            image = record.get("previous_image_id", "")
            if record.get("archive_sha256") != manifest["sha256"] or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
                raise RuntimeError("Invalid recovery image metadata")
            self.verify_image_id(image)
            write_json(restored / "deployment-image.json", {"services": {"memos": {"image": image, "pull_policy": "never"}}})
        # Keep the failed candidate's data for inspection. Never overwrite it.
        self.app.rename(self.backup.parent / "failed-application")
        restored.rename(self.app)

    def update(self, dry_run=False, retry=False):
        if self.pending.exists() or self.marker.exists():
            raise RuntimeError("Unfinished deployment; inspect pending.json and recover before retrying")
        candidate = self.candidate()
        deployed = self.read_state("deployed.json")
        if (candidate["image"].split("@")[-1] == deployed.get("image", "").split("@")[-1]
                and all(candidate[k] == deployed.get(k) for k in ("version", "commit"))):
            print("Already running the published digest")
            return
        if deployed and version_tuple(candidate["version"]) <= version_tuple(deployed["version"]):
            raise RuntimeError("Release channel would downgrade or replace an existing version")
        if not retry and self.read_state("failed.json").get("image", "").split("@")[-1] == candidate["image"].split("@")[-1]:
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
            self.finish_backup("failed")
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
        self.finish_backup("success")
        self.pending.unlink()
        self.marker.unlink()
        print("Deployment healthy; maintenance ended; backup: " + str(self.backup), flush=True)
        try:
            self.cleanup()
        except Exception as error:
            # Cleanup is not part of the deployment transaction. Never roll back
            # healthy application data because maintenance cleanup failed.
            print("Cleanup skipped/failed; deployment remains healthy: " + str(error), file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/memos-update/config.json")
    parser.add_argument("--dry-run", action="store_true", help="Download and validate only, without stopping the app")
    parser.add_argument("--cleanup-dry-run", action="store_true", help="Preview retention under the update lock; no pull, update or deletion")
    parser.add_argument("--retry", action="store_true", help="Retry a previously failed digest after investigation")
    args = parser.parse_args()
    if args.cleanup_dry_run and (args.dry_run or args.retry):
        parser.error("--cleanup-dry-run cannot be combined with update options")
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
        if args.cleanup_dry_run:
            updater.cleanup(dry_run=True)
        else:
            updater.update(args.dry_run, args.retry)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Deployment failed: " + str(error), file=sys.stderr)
        sys.exit(1)
