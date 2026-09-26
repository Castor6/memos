import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sqlite3
import subprocess
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memos_update", Path(__file__).with_name("memos-update.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeUpdater(module.Updater):
    def __init__(self, root):
        super().__init__({"app_dir": str(root / "app"), "state_dir": str(root / "state"),
                          "backup_dir": str(root / "backups"), "image_repository": "registry.example/personal/memos"})
        self.app.mkdir()
        self.events = []
        self.failure = None
        self.release = {"version": "0.1.0", "commit": "a" * 40, "image": self.repo + "@sha256:" + "b" * 64}

    def candidate(self):
        self.events.append("pull")
        if self.failure == "pull":
            raise RuntimeError("pull failed")
        return self.release

    def profile(self):
        return {"version": "0.30.0", "commit": "c" * 40, "needsSetup": False}

    def compose(self, *args):
        self.events.append(args[0])
        if self.failure == "stop" and args[0] == "stop":
            raise RuntimeError("stop timed out")
        return "container-id"

    def verify_maintenance(self):
        self.events.append("maintenance")
        if self.failure == "maintenance":
            raise RuntimeError("gate failed")

    def data_snapshot(self):
        return {"counts": {"user": 1, "memo": 5, "attachment": 2}, "files": {"data/image.png": "hash"}}

    def make_backup(self):
        self.events.append("backup")
        if self.failure == "backup":
            raise RuntimeError("backup failed")
        self.backup = self.backups / "test.tar"

    def wait_healthy(self, version, commit):
        self.events.append("health:" + version)
        if self.failure in ("health", "restore") and version == "0.1.0":
            raise RuntimeError("new version failed")

    def restore(self):
        self.events.append("restore")
        if self.failure == "restore":
            raise RuntimeError("restore failed")
        self.overlay.unlink()


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.updater = FakeUpdater(Path(self.temp.name))

    def test_pull_failure_never_stops_live_service(self):
        self.updater.failure = "pull"
        with self.assertRaises(RuntimeError):
            self.updater.update()
        self.assertEqual(self.updater.events, ["pull"])
        self.assertFalse(self.updater.marker.exists())

    def test_maintenance_must_be_observable_before_stop(self):
        self.updater.failure = "maintenance"
        with self.assertRaises(RuntimeError):
            self.updater.update()
        self.assertNotIn("stop", self.updater.events)
        self.assertFalse(self.updater.marker.exists())

    def test_backup_failure_restarts_old_without_switching(self):
        self.updater.failure = "backup"
        with self.assertRaises(RuntimeError):
            self.updater.update()
        self.assertEqual(self.updater.events[-2:], ["up", "health:0.30.0"])
        self.assertFalse(self.updater.overlay.exists())

    def test_partial_stop_failure_restarts_old(self):
        self.updater.failure = "stop"
        with self.assertRaisesRegex(RuntimeError, "stop timed out"):
            self.updater.update()
        self.assertEqual(self.updater.events[-2:], ["up", "health:0.30.0"])
        self.assertFalse(self.updater.marker.exists())

    def test_failed_upgrade_restores_data_before_old_image_starts(self):
        self.updater.failure = "health"
        with self.assertRaises(RuntimeError):
            self.updater.update()
        self.assertEqual(self.updater.events[-4:], ["stop", "restore", "up", "health:0.30.0"])
        self.assertFalse(self.updater.marker.exists())
        self.assertFalse((self.updater.state / "deployed.json").exists())
        self.assertEqual(self.updater.read_state("failed.json"), self.updater.release)
        with self.assertRaisesRegex(RuntimeError, "previously failed"):
            self.updater.update()

    def test_failed_recovery_keeps_gate_and_journal(self):
        self.updater.failure = "restore"
        with self.assertRaises(RuntimeError):
            self.updater.update()
        self.assertTrue(self.updater.marker.exists())
        self.assertTrue(self.updater.pending.exists())
        with self.assertRaisesRegex(RuntimeError, "Unfinished deployment"):
            self.updater.update()

    def test_success_pins_digest_and_same_release_is_noop(self):
        self.updater.update()
        overlay = json.loads(self.updater.overlay.read_text())
        self.assertEqual(overlay["services"]["memos"]["image"], self.updater.release["image"])
        self.assertFalse(self.updater.marker.exists())
        self.assertLess(self.updater.events.index("backup"), self.updater.events.index("up"))
        self.updater.events.clear()
        self.updater.update()
        self.assertEqual(self.updater.events, ["pull"])

    def test_cleanup_only_after_success_and_never_rolls_back(self):
        def cleanup():
            self.assertFalse(self.updater.marker.exists())
            self.assertFalse(self.updater.pending.exists())
            self.assertEqual(self.updater.read_state("deployed.json")["image"], self.updater.release["image"])
            raise OSError("cleanup disk error")
        with patch.object(self.updater, "cleanup", side_effect=cleanup) as clean:
            self.updater.update()
            clean.assert_called_once()
            self.assertNotIn("restore", self.updater.events)
            self.updater.update()
            clean.assert_called_once()

    def test_failure_never_runs_cleanup(self):
        self.updater.failure = "health"
        with patch.object(self.updater, "cleanup") as clean:
            with self.assertRaises(RuntimeError):
                self.updater.update()
            clean.assert_not_called()

    def test_dry_run_does_not_write_or_stop(self):
        self.updater.update(dry_run=True)
        self.assertFalse(self.updater.pending.exists())
        self.assertNotIn("stop", self.updater.events)

    def test_downgrade_and_retagged_version_are_rejected(self):
        for version in ("0.1.0", "0.2.0"):
            module.write_json(self.updater.state / "deployed.json", {"version": version, "image": "other-digest"})
            with self.assertRaisesRegex(RuntimeError, "downgrade or replace"):
                self.updater.update()
        self.assertNotIn("stop", self.updater.events)

    def test_missing_data_blocks_success(self):
        self.updater.snapshot = self.updater.data_snapshot()
        self.updater.snapshot["counts"]["memo"] += 1
        with self.assertRaisesRegex(RuntimeError, "count decreased"):
            self.updater.verify_data()
        self.updater.snapshot = self.updater.data_snapshot()
        self.updater.snapshot["files"]["data/missing.png"] = "hash"
        with self.assertRaisesRegex(RuntimeError, "missing or changed"):
            self.updater.verify_data()


@unittest.skipUnless("GNU tar" in subprocess.run(["tar", "--version"], capture_output=True, text=True).stdout,
                     "Deployment backup requires Linux GNU tar")
class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.updater = module.Updater({"app_dir": str(root / "app"), "state_dir": str(root / "state"),
                                       "backup_dir": str(root / "backups"), "image_repository": "registry.example/personal/memos"})
        app = self.updater.app
        (app / "data").mkdir(parents=True)
        (app / "compose.yaml").write_text("services: {}\n")
        (app / "data" / "attachment.bin").write_bytes(b"before-update\x00\xff")
        (app / "data" / "attachment.bin").chmod(0o640)
        with sqlite3.connect(app / "data" / "memos_prod.db") as db:
            for table in ("user", "memo", "attachment"):
                db.execute(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, content TEXT)')
                db.execute(f'INSERT INTO "{table}" VALUES (1, ?)', ("sentinel",))
        self.updater.snapshot = self.updater.data_snapshot()
        self.updater.previous_image_id = lambda: "sha256:" + "a" * 64
        self.updater.verify_image_id = lambda image: None
        self.updater.make_backup()

    def test_real_archive_restores_database_files_and_permissions(self):
        app = self.updater.app
        (app / "data" / "attachment.bin").write_bytes(b"changed")
        with sqlite3.connect(app / "data" / "memos_prod.db") as db:
            db.execute("DELETE FROM memo")
        self.updater.restore()
        self.assertEqual(self.updater.data_snapshot(), self.updater.snapshot)
        self.assertEqual(json.loads(self.updater.overlay.read_text())["services"]["memos"]["image"], "sha256:" + "a" * 64)
        self.assertEqual((app / "data" / "attachment.bin").stat().st_mode & 0o777, 0o640)
        self.assertEqual((self.updater.backup.parent / "failed-application/data/attachment.bin").read_bytes(), b"changed")

    def test_corrupt_archive_does_not_replace_application(self):
        with self.updater.backup.open("ab") as stream:
            stream.write(b"corrupt")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            self.updater.restore()
        self.assertEqual(self.updater.data_snapshot(), self.updater.snapshot)


if __name__ == "__main__":
    unittest.main()
