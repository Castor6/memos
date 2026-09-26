"""Validate explicit channel selection and digest-preserving transfer guards."""
import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from registry_channel import credentials

spec = importlib.util.spec_from_file_location('transfer_image', Path(__file__).with_name('transfer-image.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SOURCE = 'Castor6/memos'


def image(version='1.2.0', digest='a' * 64):
    return {'Digest': 'sha256:' + digest, 'Architecture': 'amd64', 'Os': 'linux', 'Labels': {
        'org.opencontainers.image.source': 'https://github.com/' + SOURCE,
        'org.opencontainers.image.version': version,
        'org.opencontainers.image.revision': 'b' * 40}}


class ChannelTests(unittest.TestCase):
    def test_ghcr_default_ignores_existing_acr_settings(self):
        with patch.dict(os.environ, {'GITHUB_ACTOR': 'Castor6', 'GH_TOKEN': 'test',
                                     'ACR_REGISTRY': 'broken', 'ACR_PASSWORD': 'unused'}, clear=True):
            self.assertEqual(credentials(SOURCE), ('ghcr.io', 'ghcr.io/castor6/memos', 'Castor6', 'test'))

    def test_acr_requires_explicit_selection_and_its_credentials(self):
        with patch.dict(os.environ, {'IMAGE_CHANNEL': 'acr', 'GH_TOKEN': 'not-acr'}, clear=True):
            with self.assertRaisesRegex(ValueError, 'ACR_REGISTRY'):
                credentials(SOURCE)

    def test_unknown_channel_fails(self):
        with self.assertRaises(ValueError):
            credentials(SOURCE, 'automatic')


class TransferTests(unittest.TestCase):
    def test_network_and_auth_errors_are_not_missing_images(self):
        for error in ['unauthorized', 'timeout', 'denied', 'manifest unknown']:
            with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', error)):
                if error == 'manifest unknown':
                    self.assertIsNone(module.inspect('x', missing=True))
                else:
                    with self.assertRaises(RuntimeError):
                        module.inspect('x', missing=True)

    def test_immutable_conflict_and_stable_downgrade_fail(self):
        for previous, stable in [(image(digest='c' * 64), False), (image('1.3.0', 'c' * 64), True),
                                 (image(digest='c' * 64), True)]:
            with self.assertRaises(RuntimeError):
                module.guard(previous, image(), SOURCE, stable)
        module.guard(image('1.1.0', 'c' * 64), image(), SOURCE, True)
        module.guard(image(), image(), SOURCE)

    def test_wrong_source_or_architecture_fails(self):
        candidate = image()
        candidate['Architecture'] = 'arm64'
        with self.assertRaises(RuntimeError):
            module.identity(candidate, SOURCE)

    def test_transfer_verifies_release_before_writing_and_stable_last(self):
        events = []
        def inspect(ref, missing=False):
            return None if missing else image()
        def run(*args, **kwargs):
            events.append(args)
            return ''
        with patch.object(module, 'inspect', side_effect=inspect), patch.object(module, 'run', side_effect=run), \
                patch.object(module, 'verify_release', side_effect=lambda *a: events.append(('verified',))):
            module.transfer(SOURCE, 'origin/image', 'target/image', 'castor-v')
        self.assertEqual(events[0], ('verified',))
        self.assertEqual([e[-1] for e in events[1:]], ['docker://target/image:castor-v1.2.0',
                         'docker://target/image:sha-' + 'b' * 40, 'docker://target/image:stable'])
        self.assertTrue(all('--preserve-digests' in e for e in events[1:]))

    def test_unverified_release_never_copies(self):
        with patch.object(module, 'inspect', return_value=image()), \
                patch.object(module, 'verify_release', side_effect=RuntimeError('not published')), \
                patch.object(module, 'run') as run:
            with self.assertRaises(RuntimeError):
                module.transfer(SOURCE, 'origin/image', 'target/image', 'castor-v')
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
