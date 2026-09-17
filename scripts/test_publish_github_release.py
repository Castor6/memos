import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('github_release', Path(__file__).with_name('publish-github-release.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
COMMIT = 'a' * 40


class FakeGitHub:
    def __init__(self):
        self.ref = None
        self.releases = []
        self.assets = {}
        self.mutations = []
        self.fail_upload = None

    def api(self, path, method='GET', data=None, optional=False):
        if method != 'GET':
            self.mutations.append((path, method, data))
        if path.startswith('git/ref/tags/'):
            return self.ref
        if path == 'git/refs':
            self.ref = {'object': {'type': 'commit', 'sha': data['sha']}}
            return self.ref
        if path == 'releases' and method == 'POST':
            release = dict(data, id=1, html_url='https://github.com/Castor6/memos/releases/tag/' + data['tag_name'])
            self.releases.append(release)
            return release
        if path == 'releases/1' and method == 'PATCH':
            self.releases[0].update(data)
            return self.releases[0]
        raise AssertionError((path, method))

    def listing(self, path):
        return list(self.assets.values()) if path.endswith('/assets') else self.releases[:]

    def upload(self, tag, path):
        if path.name == self.fail_upload:
            raise RuntimeError('upload interrupted')
        self.mutations.append(('upload', path.name))
        self.assets[path.name] = {'name': path.name, 'digest': m.digest(path), 'state': 'uploaded'}

    def asset_digest(self, asset):
        return asset['digest']


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.output = self.root / 'public'
        self.output.mkdir()
        for name in ('memos-linux-amd64', 'memos-linux-arm64', 'LICENSE'):
            (self.source / name).write_bytes(b'test binary\x00\xff')
        (self.source / 'CHANGELOG.md').write_text('# Changelog\n\n## 0.2.1\n\n### Patch Changes\n\n- 中文更新。\n\n## 0.2.0\n\n旧版说明\n')
        (self.source / 'release.json').write_text(json.dumps({'version': '0.2.1', 'tag': 'castor-v0.2.1', 'commit': COMMIT}))
        names = sorted(self.source.iterdir())
        (self.source / 'SHA256SUMS').write_text(''.join(m.digest(p)[7:] + '  ' + p.name + '\n' for p in names))
        (self.source / 'image.json').write_text(json.dumps({'image': 'private.example/personal/memos@sha256:' + 'b' * 64,
                                                          'version': '0.2.1', 'commit': COMMIT}))
        self.client = FakeGitHub()

    def prepare(self):
        return m.prepare(self.source, self.output, COMMIT)

    def publish(self, identity=None):
        identity = identity or self.prepare()
        return m.publish(self.client, self.output, COMMIT, *identity)

    def test_artifact_checksums_notes_and_no_private_registry(self):
        version, tag, body = self.prepare()
        self.assertEqual((version, tag), ('0.2.1', 'castor-v0.2.1'))
        self.assertIn('中文更新', body)
        self.assertNotIn('旧版说明', body)
        self.assertNotIn('private.example', body)
        self.assertFalse((self.output / 'image.json').exists())
        self.assertEqual(len(list(self.output.iterdir())), 7)
        for line in (self.output / 'SHA256SUMS').read_text().splitlines():
            checksum, name = line.split()
            self.assertEqual(m.digest(self.output / name), 'sha256:' + checksum)

    def test_identity_and_checksums_must_match_before_any_publication(self):
        with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
            m.prepare(self.source, self.output, 'c' * 40)
        (self.source / 'memos-linux-amd64').write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
            self.prepare()
        self.assertEqual(self.client.mutations, [])

    def test_image_publish_receipt_required(self):
        p = self.source / 'image.json'
        receipt = json.loads(p.read_text())
        receipt['version'] = '0.2.0'
        p.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(RuntimeError, 'image identity'):
            self.prepare()

    def test_draft_upload_verification_then_publish_and_retry_noop(self):
        identity = self.prepare()
        self.publish(identity)
        self.assertFalse(self.client.releases[0]['draft'])
        self.assertEqual(self.client.releases[0]['make_latest'], 'true')
        self.assertEqual(self.client.mutations[-1][1], 'PATCH')
        before = self.client.mutations[:]
        self.publish(identity)
        self.assertEqual(self.client.mutations, before)

    def test_upload_interruption_stays_draft_and_retry_resumes(self):
        identity = self.prepare()
        self.client.fail_upload = 'memos-linux-arm64'
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            self.publish(identity)
        self.assertTrue(self.client.releases[0]['draft'])
        self.client.fail_upload = None
        self.publish(identity)
        self.assertEqual(len(self.client.releases), 1)
        self.assertFalse(self.client.releases[0]['draft'])

    def test_tag_conflict_never_moves_tag(self):
        self.client.ref = {'object': {'type': 'commit', 'sha': 'd' * 40}}
        with self.assertRaisesRegex(RuntimeError, 'different commit'):
            self.publish()
        self.assertEqual(self.client.mutations, [])

    def test_existing_assets_never_overwritten(self):
        identity = self.prepare()
        self.publish(identity)
        self.client.assets['LICENSE']['digest'] = 'sha256:' + 'f' * 64
        before = self.client.mutations[:]
        with self.assertRaisesRegex(RuntimeError, 'asset differs'):
            self.publish(identity)
        self.assertEqual(self.client.mutations, before)

    def test_published_release_cannot_be_silently_repaired(self):
        identity = self.prepare()
        self.publish(identity)
        del self.client.assets['LICENSE']
        with self.assertRaisesRegex(RuntimeError, 'missing asset'):
            self.publish(identity)

    def test_retry_old_draft_never_promotes_over_newer_release(self):
        identity = self.prepare()
        self.client.fail_upload = 'LICENSE'
        with self.assertRaises(RuntimeError):
            self.publish(identity)
        self.client.releases.append({'tag_name': 'castor-v0.10.0', 'draft': False, 'prerelease': False})
        self.client.fail_upload = None
        self.publish(identity)
        self.assertEqual(self.client.releases[0]['make_latest'], 'false')

    def test_api_failure_is_not_treated_as_absence(self):
        client = m.GitHub('Castor6/memos')
        for error in ('gh: forbidden (HTTP 403)', 'TLS handshake timeout', 'gh: unauthorized (HTTP 401)'):
            with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', error)):
                with self.assertRaisesRegex(RuntimeError, 'request failed'):
                    client.api('git/ref/tags/castor-v0.2.1', optional=True)
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'gh: Not Found (HTTP 404)')):
            self.assertIsNone(client.api('git/ref/tags/castor-v0.2.1', optional=True))


if __name__ == '__main__':
    unittest.main()
