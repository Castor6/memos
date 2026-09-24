"""Verify personal release archives against disposable Git repositories."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).with_name("package-release.py")
SPEC = importlib.util.spec_from_file_location("package_release", SCRIPT)
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)
PUBLIC_KEY = re.search(r'const CRX_KEY\s*=\s*"([^"]+)"', (SCRIPT.parents[1] / "manifest.config.ts").read_text(encoding="utf-8")).group(1)


class ReleasePackageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "memos"
        self.extension = self.root / "extensions" / "web-clipper"
        self.dist = self.extension / "dist"
        self.dist.mkdir(parents=True)
        self.output = self.root / "artifacts"
        self.git("init", "-q")
        self.git("config", "user.email", "release-test@example.invalid")
        self.git("config", "user.name", "Release Test")
        (self.root / ".gitignore").write_text("dist/\nartifacts/\nbuild/\n", encoding="utf-8")
        (self.root / "LICENSE").write_text("Copyright (c) Memos\nMIT License\n", encoding="utf-8")
        (self.root / "package.json").write_text('{"version":"2.0.0"}\n', encoding="utf-8")
        (self.extension / "package.json").write_text('{"version":"0.4.1"}\n', encoding="utf-8")
        (self.extension / "release").mkdir()
        (self.extension / "release/package.json").write_text('{"version":"1.2.3"}\n', encoding="utf-8")
        self.commit()
        self.manifest = {
            "manifest_version": 3,
            "version": "1.2.3",
            "version_name": "1.2.3 Castor (upstream 0.4.1)",
            "name": "Castor Trial",
            "key": PUBLIC_KEY,
            "update_url": "https://example.invalid/update",
            "background": {"service_worker": "service-worker-loader.js", "type": "module"},
            "action": {"default_popup": "src/popup/index.html", "default_icon": {"16": "icons/icon.png"}},
            "options_ui": {"page": "src/options/index.html"},
            "icons": {"16": "icons/icon.png"},
            "default_locale": "en",
            "content_scripts": [{"js": ["assets/content.js"], "matches": ["<all_urls>"]}],
            "web_accessible_resources": [{"resources": ["assets/*.js"], "matches": ["<all_urls>"]}],
        }
        self.write("manifest.json", json.dumps(self.manifest))
        self.write("service-worker-loader.js", "import './assets/background.js';\n")
        self.write("assets/background.js", "console.log('worker');\n")
        self.write("assets/content.js", "console.log('content');\n")
        self.write("assets/app.js", "console.log('app');\n")
        self.write("assets/app.css", "body { color: black; }\n")
        self.write("src/popup/index.html", '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">')
        self.write("src/options/index.html", '<script type="module" src="/assets/app.js"></script>')
        self.write("icons/icon.png", b"public-icon")
        self.write("_locales/en/messages.json", '{"title":{"message":"Memos"}}')

    def git(self, *arguments, root=None):
        return subprocess.check_output(["git", *arguments], cwd=root or self.root, text=True, stderr=subprocess.PIPE).strip()

    def commit(self):
        self.git("add", "--all")
        self.git("commit", "-qm", "test: prepare release fixture")

    def write(self, name, value):
        path = self.dist / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value.encode("utf-8") if isinstance(value, str) else value)

    def package(self):
        return PACKAGE.package_release(self.extension, self.output)

    def update_manifest(self, **values):
        self.manifest.update(values)
        self.write("manifest.json", json.dumps(self.manifest))

    def test_editor_entry_is_required_without_action_popup(self):
        self.update_manifest(action={"default_icon": {"16": "icons/icon.png"}})
        self.assertTrue(self.package().exists())
        (self.dist / "src/popup/index.html").unlink()
        with self.assertRaises(PACKAGE.PackageError):
            self.package()

    def assert_rejected(self, message):
        with self.assertRaisesRegex(PACKAGE.PackageError, message):
            self.package()
        self.assertFalse(self.output.exists())

    def test_archive_identity_layout_and_deterministic_bytes(self):
        original_manifest = (self.dist / "manifest.json").read_bytes()
        archive_path = self.package()
        self.assertEqual(archive_path.name, "memos-web-clipper-chromium-v1.2.3.zip")
        first = archive_path.read_bytes()
        with zipfile.ZipFile(archive_path) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.namelist(), sorted(archive.namelist()))
            self.assertIn("manifest.json", archive.namelist())
            self.assertNotIn("dist/manifest.json", archive.namelist())
            self.assertEqual(len(archive.namelist()), 12)
            self.assertEqual(archive.read("LICENSE"), b"Copyright (c) Memos\nMIT License\n")
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["version"], "1.2.3")
            self.assertEqual(manifest["version_name"], "1.2.3 Castor (upstream 0.4.1)")
            self.assertEqual(manifest["name"], "Memos Web Clipper - Castor")
            self.assertEqual(manifest["key"], PUBLIC_KEY)
            self.assertNotIn("update_url", manifest)
            identity = json.loads(archive.read("castor-release.json"))
            self.assertEqual(identity, {"version": "1.2.3", "tag": "web-clipper-v1.2.3", "commit": self.git("rev-parse", "HEAD"), "upstreamVersion": "0.4.1"})
            for entry in archive.infolist():
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(entry.external_attr >> 16, 0o100644)
                self.assertEqual(entry.create_system, 3)
        for path in self.dist.rglob("*"):
            os.utime(path, (1700000000, 1700000000))
        self.assertEqual(hashlib.sha256(first).digest(), hashlib.sha256(self.package().read_bytes()).digest())
        self.assertEqual((self.dist / "manifest.json").read_bytes(), original_manifest)
        self.assertEqual(json.loads((self.extension / "package.json").read_text())["version"], "0.4.1")

    def test_memos_only_release_keeps_extension_version(self):
        before = PACKAGE.release_identity(self.extension)
        (self.root / "package.json").write_text('{"version":"2.1.0"}\n', encoding="utf-8")
        self.commit()
        after = PACKAGE.release_identity(self.extension)
        self.assertEqual(before["version"], after["version"])
        self.assertEqual(after["tag"], before["tag"])
        with zipfile.ZipFile(self.package()) as archive:
            self.assertEqual(json.loads(archive.read("manifest.json"))["version"], "1.2.3")

    def test_worktree_checkout_is_supported(self):
        worktree = Path(self.temporary.name) / "worktree"
        self.git("worktree", "add", "--detach", str(worktree), "HEAD")
        identity = PACKAGE.release_identity(worktree / "extensions" / "web-clipper")
        self.assertEqual(identity["commit"], self.git("rev-parse", "HEAD"))
        self.git("worktree", "remove", str(worktree))

    def test_cli_explicit_output_is_relative_to_calling_directory(self):
        target = self.extension / "scripts" / SCRIPT.name
        target.parent.mkdir()
        target.write_bytes(SCRIPT.read_bytes())
        self.commit()
        result = subprocess.run([sys.executable, str(target), "--output", "build/candidate"], cwd=self.root, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / "build/candidate/memos-web-clipper-chromium-v1.2.3.zip").is_file())

    def test_cli_default_output_is_extension_artifacts(self):
        target = self.extension / "scripts" / SCRIPT.name
        target.parent.mkdir()
        target.write_bytes(SCRIPT.read_bytes())
        self.commit()
        result = subprocess.run([sys.executable, str(target)], cwd=self.root, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.extension / "artifacts/memos-web-clipper-chromium-v1.2.3.zip").is_file())

    def test_missing_build_is_rejected(self):
        (self.dist / "manifest.json").unlink()
        self.assert_rejected("manifest.json is missing")

    def test_stale_build_is_rejected(self):
        self.update_manifest(version="0.4.0")
        self.assert_rejected("version does not match")

    def test_missing_or_changed_public_key_is_rejected(self):
        for key in (None, "", "not-base64", "dGVzdA=="):
            with self.subTest(key=key):
                self.update_manifest(key=key)
                self.assert_rejected("public key")

    def test_non_mv3_manifest_is_rejected(self):
        self.update_manifest(manifest_version=2)
        self.assert_rejected("Manifest V3")

    def test_invalid_resource_definitions_are_rejected(self):
        for field in ("background", "action", "options_ui", "icons", "content_scripts", "web_accessible_resources"):
            with self.subTest(field=field):
                original = self.manifest[field]
                self.update_manifest(**{field: None})
                self.assert_rejected("invalid")
                self.update_manifest(**{field: original})

    def test_missing_worker_dependency_is_rejected(self):
        (self.dist / "assets/background.js").unlink()
        self.assert_rejected("Missing or empty packaged resource")

    def test_missing_html_dependency_is_rejected(self):
        (self.dist / "assets/app.css").unlink()
        self.assert_rejected("Missing or empty packaged resource")

    def test_empty_resource_is_rejected(self):
        self.write("assets/content.js", "")
        self.assert_rejected("Missing or empty packaged resource")

    def test_unsafe_manifest_resource_is_rejected(self):
        for resource in ("../private.js", "https://example.invalid/code.js", "//external/code.js", "assets\\content.js"):
            with self.subTest(resource=resource):
                self.update_manifest(background={"service_worker": resource})
                self.assert_rejected("resource path")

    def test_source_maps_environment_and_sensitive_files_are_rejected(self):
        for name in (".env", ".env.production", "assets/app.js.map", "assets/secrets.json", "private.key", "package.json", "notes.md"):
            with self.subTest(name=name):
                self.write(name, "secret")
                self.assert_rejected("Hidden|sensitive|Unexpected")
                (self.dist / name).unlink()

    def test_private_key_in_public_filename_is_rejected(self):
        self.write("assets/app.js", 'const key = "-----BEGIN RSA PRIVATE KEY-----";')
        self.assert_rejected("Private key")

    def test_development_build_and_source_map_references_are_rejected(self):
        for value in ("import '/@vite/client';", 'import("http://localhost:5173/src/app.ts")', "//# sourceMappingURL=app.js.map"):
            with self.subTest(value=value):
                self.write("assets/app.js", value)
                self.assert_rejected("Development build")

    def test_symlink_is_rejected(self):
        link = self.dist / "assets/linked.js"
        try:
            link.symlink_to(self.dist / "assets/app.js")
        except OSError:
            self.skipTest("This host cannot create symlinks.")
        self.assert_rejected("Symlinks")

    def test_case_colliding_paths_are_rejected(self):
        self.write("assets/App.js", "console.log('duplicate');")
        if (self.dist / "assets/App.js").samefile(self.dist / "assets/app.js"):
            self.skipTest("Case-insensitive filesystem cannot create this fixture.")
        self.assert_rejected("duplicate archive path")

    def test_dirty_tracked_source_is_rejected(self):
        (self.root / "package.json").write_text('{"version":"1.2.4"}', encoding="utf-8")
        self.assert_rejected("dirty working tree")

    def test_dirty_untracked_source_is_rejected(self):
        (self.root / "untracked.txt").write_text("uncommitted", encoding="utf-8")
        self.assert_rejected("dirty working tree")

    def test_output_inside_dist_is_rejected(self):
        with self.assertRaisesRegex(PACKAGE.PackageError, "inside dist"):
            PACKAGE.package_release(self.extension, self.dist / "artifacts")

    def test_invalid_versions_are_rejected(self):
        for version in (None, 1, "", "v1.2.3", "1.2.3-beta.1", "1.2.3+build", "01.2.3", "1.2.3.4.5", "65536.1", "0.0.0"):
            with self.subTest(version=version):
                with self.assertRaises(PACKAGE.PackageError):
                    PACKAGE.chrome_version(version)

    def test_valid_versions(self):
        for version in ("1", "1.0", "0.7.0", "65535.65535.65535.65535"):
            with self.subTest(version=version):
                self.assertEqual(PACKAGE.chrome_version(version), version)


if __name__ == "__main__":
    unittest.main()
