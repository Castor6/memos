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

    def write_extension(self, *, version='0.2.1', commit=COMMIT, manifest_version='0.2.1', tag='castor-v0.2.1',
                        editor=False, include_entry=True):
        with zipfile.ZipFile(self.source / self.extension_name, 'w') as archive:
            archive.writestr('manifest.json', json.dumps({
                'manifest_version': 3, 'version': manifest_version, 'key': 'public-key',
                'background': {'service_worker': 'background.js'}, 'action': {} if editor else {'default_popup': 'popup.html'},
            }))
            archive.writestr('castor-release.json', json.dumps({'version': version, 'tag': tag, 'commit': commit}))
            archive.writestr('background.js', 'console.log("extension");')
            if include_entry:
                archive.writestr('src/popup/index.html' if editor else 'popup.html', '<!doctype html><title>Web Clipper</title>')

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

    def test_independent_extension_version_is_preserved(self):
        (self.source / self.extension_name).unlink()
        self.extension_name = 'memos-web-clipper-chromium-v0.1.3.zip'
        self.write_extension(version='0.1.3', manifest_version='0.1.3')
        path = self.source / 'release.json'
        release = json.loads(path.read_text())
        release['webClipper'] = {'version': '0.1.3', 'file': self.extension_name}
        path.write_text(json.dumps(release))
        self.write_checksums()
        version, tag, body = self.prepare()
        self.assertEqual((version, tag), ('0.2.1', 'castor-v0.2.1'))
        self.assertIn(self.extension_name, body)
        self.assertEqual(json.loads((self.output / 'release.json').read_text())['webClipper']['version'], '0.1.3')

    def test_memos_release_no_longer_requires_or_bundles_extension(self):
        path = self.source / 'release.json'
        release = json.loads(path.read_text())
        release.pop('webClipper')
        release['component'] = 'memos'
        path.write_text(json.dumps(release))
        (self.source / self.extension_name).unlink()
        self.write_checksums()
        version, tag, body = self.prepare()
        self.assertEqual((version, tag), ('0.2.1', 'castor-v0.2.1'))
        self.assertEqual(len(list(self.output.iterdir())), 7)
        self.assertNotIn('浏览器扩展', body)
        self.assertTrue((self.output / 'image-digest.txt').is_file())

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
        for override in ({'version': '0.2.0'}, {'commit': 'e' * 40}, {'manifest_version': '0.2.0'}, {'tag': 'castor-v0.2.0'}):
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

    def test_web_clipper_editor_without_popup_is_accepted(self):
        self.write_extension(editor=True)
        self.write_checksums()
        self.prepare()
        self.assertEqual((self.source / self.extension_name).read_bytes(), (self.output / self.extension_name).read_bytes())

    def test_web_clipper_missing_entry_is_rejected_for_both_interfaces(self):
        for editor in (False, True):
            with self.subTest(editor=editor):
                self.write_extension(editor=editor, include_entry=False)
                self.write_checksums()
                with self.assertRaisesRegex(RuntimeError, 'manifest mismatch'):
                    self.prepare()
        self.assertEqual(self.client.mutations, [])

    def test_editor_entry_cannot_replace_a_declared_missing_popup(self):
        self.write_extension(include_entry=False)
        with zipfile.ZipFile(self.source / self.extension_name, 'a') as archive:
            archive.writestr('src/popup/index.html', '<!doctype html><title>Editor</title>')
        self.write_checksums()
        with self.assertRaisesRegex(RuntimeError, 'manifest mismatch'):
            self.prepare()
        self.assertEqual(self.client.mutations, [])

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


class IndependentClipperTests(unittest.TestCase):
    write_extension = ReleaseTests.write_extension

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        metadata = self.root / 'extensions/web-clipper/release'
        metadata.mkdir(parents=True)
        (metadata / 'package.json').write_text(json.dumps({'version': '0.1.0'}))
        (metadata / 'CHANGELOG.md').write_text('# Changelog\n\n## 0.1.0\n\n- 扩展独立发布。\n')
        (self.root / 'LICENSE').write_text('MIT')
        self.source = self.root / 'candidate'
        self.source.mkdir()
        self.output = self.root / 'public'
        self.output.mkdir()
        self.extension_name = 'memos-web-clipper-chromium-v0.1.0.zip'
        self.write_extension(version='0.1.0', manifest_version='0.1.0', tag='web-clipper-v0.1.0', editor=True)
        m.stage_web_clipper(self.root, self.source, COMMIT)
        self.client = FakeGitHub()

    def prepare(self):
        return m.prepare(self.source, self.output, COMMIT, 'web-clipper')

    def publish(self):
        return m.publish(self.client, self.output, COMMIT, *self.prepare(), component='web-clipper')

    def test_extension_can_publish_without_any_memos_metadata_or_image(self):
        version, tag, body = self.prepare()
        self.assertEqual((version, tag), ('0.1.0', 'web-clipper-v0.1.0'))
        self.assertIn('扩展独立发布', body)
        self.assertNotIn('镜像', body)
        self.assertEqual({p.name for p in self.output.iterdir()}, {
            self.extension_name, 'CHANGELOG.md', 'LICENSE', 'release.json', 'SHA256SUMS',
        })
        self.publish()
        self.assertFalse(self.client.releases[0]['draft'])
        self.assertEqual(self.client.releases[0]['make_latest'], 'false')
        before = self.client.mutations[:]
        self.publish()
        self.assertEqual(self.client.mutations, before)

    def test_interrupted_upload_resumes_without_promoting_over_memos(self):
        self.client.fail_upload = self.extension_name
        with self.assertRaisesRegex(RuntimeError, 'interrupted'):
            self.publish()
        self.assertTrue(self.client.releases[0]['draft'])
        self.client.releases.append({'tag_name': 'castor-v0.8.2', 'draft': False, 'prerelease': False})
        self.client.fail_upload = None
        self.publish()
        self.assertEqual(self.client.releases[0]['make_latest'], 'false')
        self.assertEqual(len(self.client.releases), 2)

    def test_conflicting_tag_or_asset_cannot_be_overwritten(self):
        self.client.ref = {'object': {'type': 'commit', 'sha': 'b' * 40}}
        with self.assertRaisesRegex(RuntimeError, 'different commit'):
            self.publish()
        self.client.ref = None
        self.publish()
        self.client.assets[self.extension_name]['digest'] = 'sha256:' + 'c' * 64
        with self.assertRaisesRegex(RuntimeError, 'asset differs'):
            self.publish()

    def test_wrong_component_or_corrupt_zip_is_rejected_before_publication(self):
        with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
            m.prepare(self.source, self.output, COMMIT)
        (self.source / self.extension_name).write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
            self.publish()
        self.assertEqual(self.client.mutations, [])

    def test_staging_rejects_foreign_commit_and_mismatched_changelog(self):
        with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
            m.stage_web_clipper(self.root, self.source, 'b' * 40)
        (self.root / 'extensions/web-clipper/release/CHANGELOG.md').write_text('# Changelog\n\n## 0.2.0\n\nWrong version\n')
        with self.assertRaisesRegex(RuntimeError, 'changelog section'):
            m.stage_web_clipper(self.root, self.source, COMMIT)


class ReleaseWorkflowTests(unittest.TestCase):
    def test_extension_is_packaged_before_embedding_the_main_frontend(self):
        root = Path(__file__).parents[1]
        workflow = (root / '.github/workflows/release-candidate.yml').read_text(encoding='utf-8')
        package_step = workflow.index('run: python3 extensions/web-clipper/scripts/package-release.py')
        web_release = workflow.index('          pnpm release')
        self.assertLess(package_step, web_release)
        self.assertIn('version: 11.0.1', workflow[package_step:web_release])
        self.assertIn('extensions/web-clipper/', (root / '.dockerignore').read_text().splitlines())

    def test_release_routing_and_candidate_metadata_for_each_component_and_legacy(self):
        workflow = (Path(__file__).parents[1] / '.github/workflows/release-candidate.yml').read_text(encoding='utf-8')
        scripts = re.findall(r"^          node --input-type=module <<'JS'\n(.*?)^          JS$", workflow, re.M | re.S)
        self.assertEqual(len(scripts), 2)
        cases = [
            # independent metadata, legacy extension, Memos changed, extension changed
            (False, False, True, False), (False, True, True, False),
            (True, False, True, False), (True, False, False, True), (True, False, True, True),
        ]
        for independent, legacy, memos_changed, clipper_changed in cases:
            with self.subTest(case=(independent, legacy, memos_changed, clipper_changed)), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                def git(*args):
                    return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True)
                git('init', '-q')
                git('config', 'user.name', 'Release Test')
                git('config', 'user.email', 'release-test@example.invalid')
                (root / 'package.json').write_text(json.dumps({'version': '0.2.0'}))
                if legacy:
                    package_script = root / 'extensions/web-clipper/scripts/package-release.py'
                    package_script.parent.mkdir(parents=True)
                    package_script.touch()
                version_file = root / 'extensions/web-clipper/release/package.json'
                if independent:
                    version_file.parent.mkdir(parents=True)
                    version_file.write_text(json.dumps({'version': '0.1.2'}))
                git('add', '.'); git('commit', '-qm', 'base')
                if memos_changed:
                    (root / 'package.json').write_text(json.dumps({'version': '0.2.1'}))
                if clipper_changed:
                    version_file.write_text(json.dumps({'version': '0.1.3'}))
                git('add', '.'); git('commit', '-qm', 'versions')
                (root / 'build/candidate').mkdir(parents=True)
                env = {**os.environ, 'GITHUB_OUTPUT': str(root / 'outputs'), 'RELEASE_COMMIT': COMMIT}
                subprocess.run(['node', '--input-type=module'], input=textwrap.dedent(scripts[0]),
                               cwd=root, env=env, text=True, check=True, capture_output=True)
                values = dict(line.split('=', 1) for line in (root / 'outputs').read_text().splitlines())
                self.assertEqual(values['memos'], str(memos_changed).lower())
                self.assertEqual(values['web_clipper'], str(clipper_changed).lower())
                self.assertEqual(values['legacy_web_clipper'], str(legacy).lower())
                if not memos_changed:
                    continue
                env.update(RELEASE_VERSION=values['memos_version'], WEB_CLIPPER=values['legacy_web_clipper'],
                           WEB_CLIPPER_VERSION=values['clipper_version'], INDEPENDENT_RELEASE=values['independent'])
                subprocess.run(['node', '--input-type=module'], input=textwrap.dedent(scripts[1]),
                               cwd=root, env=env, text=True, check=True, capture_output=True)
                metadata = json.loads((root / 'build/candidate/release.json').read_text())
                self.assertEqual(metadata['commit'], COMMIT)
                self.assertEqual(metadata['tag'], 'castor-v0.2.1')
                if legacy:
                    self.assertEqual(metadata['webClipper'], {
                        'version': '0.2.1', 'file': 'memos-web-clipper-chromium-v0.2.1.zip',
                    })
                else:
                    self.assertNotIn('webClipper', metadata)
                self.assertEqual(metadata.get('component'), 'memos' if independent else None)

    def test_only_memos_lane_can_access_image_publishing_and_registry_credentials(self):
        workflow = (Path(__file__).parents[1] / '.github/workflows/release-candidate.yml').read_text()
        jobs = dict(re.findall(r'^  ([a-z-]+):\n(.*?)(?=^  [a-z-]+:|\Z)', workflow, re.M | re.S))
        self.assertIn("if: needs.plan.outputs.memos == 'true'", jobs['candidate'])
        self.assertIn("if: needs.plan.outputs.web_clipper == 'true'", jobs['clipper-candidate'])
        self.assertIn('needs: [source, candidate]', jobs['github-release'])
        self.assertIn('needs: [source, plan, clipper-candidate]', jobs['clipper-release'])
        for job in ('source', 'plan', 'clipper-candidate', 'clipper-release'):
            self.assertNotRegex(jobs[job], r'ACR_|publish-image|setup-go|pnpm release|release_smoke_test')
        self.assertIn('python3 scripts/publish-image.py', jobs['candidate'])
        self.assertIn('RELEASE_COMPONENT: web-clipper', jobs['clipper-release'])
        self.assertIn('contents: write', jobs['clipper-release'])
        self.assertNotIn('contents: write', jobs['clipper-candidate'])


if __name__ == '__main__':
    unittest.main()
