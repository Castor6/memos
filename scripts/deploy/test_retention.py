import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("memos_update", Path(__file__).with_name("memos-update.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def image_id(n):
    return "sha256:" + f"{n:064x}"


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.u = m.Updater({"app_dir": str(self.root / "app"), "state_dir": str(self.root / "state"),
                            "backup_dir": str(self.root / "backups"), "image_repository": "registry.example/personal/memos"})
        self.now = 2000000000
        self.containers = [image_id(99)]
        self.images = {image_id(n): self.u.repo for n in range(1, 100)}
        self.commands = []
        self.fail_remove = False
        self.u.run = self.run_command
        for n in range(1, 6):
            self.backup(n, 100 - n)
        m.write_json(self.u.state / "deployed.json", {"image": "current", "backup": str(self.directory(5) / "before-update.tar")})

    def directory(self, n):
        return self.u.backups / f"20260101-0000{n:02d}-1"

    def backup(self, n, age, status="success", image=None):
        p = self.directory(n)
        p.mkdir(exist_ok=True)
        (p / "before-update.tar").write_bytes(b"backup")
        digest = m.sha256(p / "before-update.tar")
        m.write_json(p / "manifest.json", {"sha256": digest})
        m.write_json(p / "retention.json", {"schema": 1, "created_at": self.now - age * 86400,
                     "status": status, "archive_sha256": digest, "previous_image_id": image or image_id(n)})
        return p

    def run_command(self, *args, **kwargs):
        self.commands.append(args)
        if args[:3] == ("docker", "ps", "-aq"):
            return " ".join(str(n) for n in range(len(self.containers)))
        if args[:2] == ("docker", "inspect"):
            return json.dumps([{"Image": i} for i in self.containers])
        if args[:3] == ("docker", "image", "ls"):
            return " ".join(self.images)
        if args[:3] == ("docker", "image", "inspect"):
            if args[3:] == ("current",):
                return json.dumps([{"Id": image_id(99)}])
            return json.dumps([{"Id": i, "RepoDigests": [self.images[i] + "@" + i],
                                "Config": {"Labels": {"org.opencontainers.image.source":
                                    "https://github.com/Castor6/memos"}}} for i in args[3:]])
        if args[:3] == ("docker", "image", "rm"):
            if self.fail_remove:
                raise RuntimeError("image busy")
            del self.images[args[3]]
            return "deleted"
        raise AssertionError(args)

    def plan(self):
        return self.u.retention_plan(now=self.now)

    def test_union_of_latest_three_and_thirty_days(self):
        self.assertEqual(len(self.plan()["remove_backups"]), 2)
        self.backup(5, 1)
        self.backup(4, 2)
        self.backup(3, 3)
        self.backup(1, 30)  # Fourth newest: only the inclusive age rule protects it.
        self.backup(2, 30 + 1 / 86400)
        self.assertEqual([x["directory"] for x in self.plan()["remove_backups"]], [str(self.directory(2))])

    def test_fewer_than_three_old_backups_never_deleted(self):
        import shutil
        for n in (1, 2, 3):
            shutil.rmtree(self.directory(n))
        self.assertEqual(self.plan()["remove_backups"], [])

    def test_failed_pending_and_extra_files_protected(self):
        for status in ("failed", "pending"):
            self.backup(1, 99, status=status)
            self.assertNotIn(image_id(1), self.plan()["remove_images"])
        self.backup(1, 99)
        (self.directory(1) / "failed-application").mkdir()
        self.assertNotIn(image_id(1), self.plan()["remove_images"])

    def test_current_recovery_point_always_kept(self):
        m.write_json(self.u.state / "deployed.json", {"image": "current", "backup": str(self.directory(1) / "before-update.tar")})
        self.assertNotIn(image_id(1), self.plan()["remove_images"])

    def test_shared_current_and_stopped_container_images_kept(self):
        self.backup(5, 95, image=image_id(1))
        self.containers.append(image_id(2))
        self.assertEqual(self.plan()["remove_images"], [])
        self.containers = []
        self.backup(1, 99, image=image_id(99))
        self.assertNotIn(image_id(99), self.plan()["remove_images"])

    def test_only_recorded_memos_images_can_be_removed(self):
        self.images[image_id(1)] = "unrelated/service"
        self.assertEqual(self.plan()["remove_images"], [image_id(2)])
        self.assertNotIn(image_id(50), self.plan()["remove_images"])

    def test_retained_registry_image_can_be_removed_but_unknown_alias_is_kept(self):
        ghcr = "ghcr.io/castor6/memos"
        self.u.retained_repositories.add(ghcr)
        self.images[image_id(2)] = ghcr
        self.assertEqual(self.plan()["remove_images"], [image_id(1), image_id(2)])
        original = self.u.run
        def docker(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:3] == ("docker", "image", "inspect") and args[3:] != ("current",):
                items = json.loads(result)
                for item in items:
                    if item["Id"] == image_id(2):
                        item["RepoDigests"].append("unknown.example/other@" + image_id(2))
                return json.dumps(items)
            return result
        self.u.run = docker
        self.assertEqual(self.plan()["remove_images"], [image_id(1)])

    def test_recorded_dangling_personal_image_is_still_owned(self):
        original = self.u.run
        def docker(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:3] == ("docker", "image", "inspect") and args[3:] != ("current",):
                items = json.loads(result)
                for item in items:
                    if item["Id"] == image_id(1):
                        item["RepoDigests"] = []
                        item["Config"] = {"Labels": {"org.opencontainers.image.source": "https://github.com/Castor6/memos"}}
                return json.dumps(items)
            return result
        self.u.run = docker
        self.assertIn(image_id(1), self.plan()["remove_images"])

    def test_legacy_corrupt_or_symlink_metadata_aborts(self):
        p = self.directory(1) / "retention.json"
        p.unlink()
        with self.assertRaisesRegex(RuntimeError, "Incomplete/legacy"):
            self.plan()
        p.symlink_to(self.directory(2) / "retention.json")
        with self.assertRaisesRegex(RuntimeError, "Incomplete/legacy"):
            self.plan()
        p.unlink()
        p.write_text('{}')
        with self.assertRaisesRegex(RuntimeError, "Invalid backup"):
            self.plan()

    def test_symlink_backup_directory_refused(self):
        (self.u.backups / "20260101-000006-1").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "Unknown backup"):
            self.plan()

    def test_pending_marker_and_invalid_policy_refused(self):
        for p in (self.u.pending, self.u.marker):
            p.touch()
            with self.assertRaisesRegex(RuntimeError, "Unfinished"):
                self.plan()
            p.unlink()
        self.u.config["backup_keep_count"] = 0
        with self.assertRaisesRegex(RuntimeError, "at least"):
            self.plan()

    def test_corrupt_expired_archive_is_preserved(self):
        (self.directory(1) / "before-update.tar").write_bytes(b"corrupt")
        self.assertNotIn(image_id(1), self.plan()["remove_images"])

    def test_dry_run_does_not_write_or_delete(self):
        before = sorted(str(p) for p in self.root.rglob("*"))
        with patch.object(m.time, "time", return_value=self.now):
            self.u.cleanup(dry_run=True)
        self.assertEqual(before, sorted(str(p) for p in self.root.rglob("*")))
        self.assertFalse(any(c[:3] == ("docker", "image", "rm") for c in self.commands))

    def test_real_backup_deletion_and_image_failure_retry(self):
        self.fail_remove = True
        with patch.object(m.time, "time", return_value=self.now):
            with self.assertRaisesRegex(RuntimeError, "image busy"):
                self.u.cleanup()
            self.assertFalse(self.directory(1).exists())
            self.assertFalse(self.directory(2).exists())
            self.assertEqual(len(self.u.read_state("retired-images.json")["images"]), 2)
            self.assertIn("error", self.u.read_state("cleanup-last.json"))
            self.fail_remove = False
            report = self.u.cleanup()
        self.assertEqual(set(report["deleted_images"]), {image_id(1), image_id(2)})
        self.assertEqual(len(list(self.u.backups.iterdir())), 3)

    def test_backup_deletion_failure_does_not_delete_images(self):
        with patch.object(m.time, "time", return_value=self.now), patch.object(m.shutil, "rmtree", side_effect=OSError("denied")):
            with self.assertRaises(OSError):
                self.u.cleanup()
        self.assertFalse(any(c[:3] == ("docker", "image", "rm") for c in self.commands))
        self.assertTrue(self.directory(1).exists())


if __name__ == "__main__":
    unittest.main()
