import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publish_image", Path(__file__).with_name("publish-image.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RegistryTests(unittest.TestCase):
    def test_only_missing_manifest_allows_new_version(self):
        for error in ("manifest unknown", "no such manifest: registry/repo:tag"):
            with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", error)):
                self.assertFalse(module.exists("registry/repo:tag"))

    def test_auth_and_network_errors_cannot_overwrite_version(self):
        for error in ("unauthorized: authentication required", "denied", "TLS handshake timeout", "connection refused"):
            with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", error)):
                with self.assertRaisesRegex(RuntimeError, "Cannot establish"):
                    module.exists("registry/repo:tag")

    def test_numeric_release_order(self):
        self.assertGreater(module.version_tuple("0.10.0"), module.version_tuple("0.9.1"))
        for version in ("01.0.0", "v1.2.3", "1.2.3-rc.1", ""):
            with self.assertRaises(ValueError):
                module.version_tuple(version)


if __name__ == "__main__":
    unittest.main()
