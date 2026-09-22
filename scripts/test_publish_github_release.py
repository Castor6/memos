import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import textwrap
import unittest
from unittest.mock import patch
import subprocess
import zipfile

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
        self.extension_name = 'memos-web-clipper-chromium-v0.2.1.zip'
        self.write_extension()
        (self.source / 'release.json').write_text(json.dumps({
            'version': '0.2.1', 'tag': 'castor-v0.2.1', 'commit': COMMIT,
            'webClipper': {'version': '0.2.1', 'file': self.extension_name},
        }))
        self.write_checksums()
        (self.source / 'image.json').write_text(json.dumps({'image': 'private.example/personal/memos@sha256:' + 'b' * 64,
                                                          'version': '0.2.1', 'commit': COMMIT}))
        self.client = FakeGitHub()

    def write_extension(self, *, version='0.2.1', commit=COMMIT, manifest_version='0.2.1'):
        with zipfile.ZipFile(self.source / self.extension_name, 'w') as archive:
            archive.writestr('manifest.json', json.dumps({
                'manifest_version': 3, 'version': manifest_version, 'key': 'public-key',
                'background': {'service_worker': 'background.js'}, 'action': {'default_popup': 'popup.html'},
            }))
            archive.writestr('castor-release.json', json.dumps({'version': version, 'tag': 'castor-v' + version, 'commit': commit}))
            archive.writestr('background.js', 'console.log("extension");')
            archive.writestr('popup.html', '<!doctype html><title>Web Clipper</title>')

    def write_checksums(self):
        names = sorted(p for p in self.source.iterdir() if p.name not in ('SHA256SUMS', 'image.json'))
        (self.source / 'SHA256SUMS').write_text(''.join(m.digest(p)[7:] + '  ' + p.name + '\n' for p in names))

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
        self.assertEqual(len(list(self.output.iterdir())), 8)
        self.assertIn(self.extension_name, body)
        self.assertEqual((self.source / self.extension_name).read_bytes(), (self.output / self.extension_name).read_bytes())
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

    def test_web_clipper_metadata_is_required_and_cannot_choose_an_arbitrary_file(self):
        path = self.source / 'release.json'
        release = json.loads(path.read_text())
        for metadata in (None, {'version': '0.2.1', 'file': '../private.zip'},
                         {'version': '0.2.0', 'file': self.extension_name}):
            with self.subTest(metadata=metadata):
                release['webClipper'] = metadata
                path.write_text(json.dumps(release))
                self.write_checksums()
                with self.assertRaisesRegex(RuntimeError, 'clipper metadata mismatch'):
                    self.prepare()
        self.assertEqual(self.client.mutations, [])

    def test_missing_or_corrupt_web_clipper_is_rejected(self):
        path = self.source / self.extension_name
        for data in (None, b'corrupt'):
            with self.subTest(data=data):
                if data is None:
                    path.unlink()
                else:
                    path.write_bytes(data)
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    self.prepare()

    def test_web_clipper_internal_identity_and_manifest_must_match(self):
        for override in ({'version': '0.2.0'}, {'commit': 'e' * 40}, {'manifest_version': '0.2.0'}):
            with self.subTest(override=override):
                self.write_extension(**override)
                self.write_checksums()
                with self.assertRaisesRegex(RuntimeError, '(identity|manifest) mismatch'):
                    self.prepare()
        self.assertEqual(self.client.mutations, [])

    def test_non_zip_candidate_is_rejected_even_with_matching_checksum(self):
        (self.source / self.extension_name).write_bytes(b'not an archive')
        self.write_checksums()
        with self.assertRaisesRegex(RuntimeError, 'Invalid web clipper archive'):
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

    def test_web_clipper_upload_interruption_resumes_without_duplicate_assets(self):
        identity = self.prepare()
        self.client.fail_upload = self.extension_name
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            self.publish(identity)
        self.assertTrue(self.client.releases[0]['draft'])
        self.client.fail_upload = None
        self.publish(identity)
        self.assertFalse(self.client.releases[0]['draft'])
        uploads = [entry for entry in self.client.mutations if entry == ('upload', self.extension_name)]
        self.assertEqual(len(uploads), 1)

    def test_web_clipper_published_bytes_cannot_be_overwritten(self):
        identity = self.prepare()
        self.publish(identity)
        self.client.assets[self.extension_name]['digest'] = 'sha256:' + 'f' * 64
        before = self.client.mutations[:]
        with self.assertRaisesRegex(RuntimeError, 'asset differs'):
            self.publish(identity)
        self.assertEqual(self.client.mutations, before)

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


class ReleaseWorkflowTests(unittest.TestCase):
    def test_extension_is_packaged_before_embedding_the_main_frontend(self):
        root = Path(__file__).parents[1]
        workflow = (root / '.github/workflows/release-candidate.yml').read_text(encoding='utf-8')
        package_step = workflow.index('run: python3 extensions/web-clipper/scripts/package-release.py')
        web_release = workflow.index('          pnpm release')
        self.assertLess(package_step, web_release)
        self.assertIn('version: 11.0.1', workflow[package_step:web_release])
        self.assertIn('extensions/web-clipper/', (root / '.dockerignore').read_text().splitlines())

    def test_candidate_metadata_preserves_old_releases_and_identifies_new_extension(self):
        workflow = (Path(__file__).parents[1] / '.github/workflows/release-candidate.yml').read_text(encoding='utf-8')
        scripts = re.findall(r"^          node --input-type=module <<'JS'\n(.*?)^          JS$", workflow, re.M | re.S)
        self.assertEqual(len(scripts), 2)
        for has_extension in (False, True):
            with self.subTest(has_extension=has_extension), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'package.json').write_text(json.dumps({'version': '0.2.1'}))
                (root / 'build/candidate').mkdir(parents=True)
                if has_extension:
                    package_script = root / 'extensions/web-clipper/scripts/package-release.py'
                    package_script.parent.mkdir(parents=True)
                    package_script.touch()
                env = {**os.environ, 'GITHUB_OUTPUT': str(root / 'outputs'), 'RELEASE_COMMIT': COMMIT}
                subprocess.run(['node', '--input-type=module'], input=textwrap.dedent(scripts[0]),
                               cwd=root, env=env, text=True, check=True, capture_output=True)
                values = dict(line.split('=', 1) for line in (root / 'outputs').read_text().splitlines())
                self.assertEqual(values['version'], '0.2.1')
                self.assertEqual(values['web_clipper'], str(has_extension).lower())
                env.update(RELEASE_VERSION=values['version'], WEB_CLIPPER=values['web_clipper'])
                subprocess.run(['node', '--input-type=module'], input=textwrap.dedent(scripts[1]),
                               cwd=root, env=env, text=True, check=True, capture_output=True)
                metadata = json.loads((root / 'build/candidate/release.json').read_text())
                self.assertEqual(metadata['commit'], COMMIT)
                self.assertEqual(metadata['tag'], 'castor-v0.2.1')
                if has_extension:
                    self.assertEqual(metadata['webClipper'], {
                        'version': '0.2.1', 'file': 'memos-web-clipper-chromium-v0.2.1.zip',
                    })
                else:
                    self.assertNotIn('webClipper', metadata)


if __name__ == '__main__':
    unittest.main()
