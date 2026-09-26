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

class PublicationTests(unittest.TestCase):
    def identity(self):
        return {'version': '0.9.0', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64}

    def info(self, version='0.9.0', digest=None):
        return {'Labels': {'org.opencontainers.image.source': module.SOURCE,
                           'org.opencontainers.image.version': version,
                           'org.opencontainers.image.revision': 'a' * 40},
                'Architecture': 'amd64', 'Os': 'linux', 'Digest': digest or self.identity()['digest']}

    def test_same_version_other_content_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
            module.verify(self.info(digest='sha256:' + 'c' * 64), '0.9.0', 'a' * 40, self.identity()['digest'])

    def test_platform_and_commit_are_checked(self):
        for field, value in [('Architecture', 'arm64'), ('Os', 'windows')]:
            info = self.info(); info[field] = value
            with self.assertRaisesRegex(RuntimeError, 'platform mismatch'):
                module.verify(info, '0.9.0', 'a' * 40)
        with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
            module.verify(self.info(), '0.9.0', 'c' * 40)

    def test_baseline_fallback_includes_download_errors(self):
        with patch.object(module, 'repositories', return_value={'ghcr': 'ghcr.io/a/b', 'acr': 'acr.io/a/b'}), \
             patch.object(module, 'login'), patch.object(module, 'remote', return_value=self.info()), \
             patch.object(module, 'copy', side_effect=[RuntimeError('network'), None]) as copying:
            module.find_source(self.identity())
            self.assertEqual(copying.call_count, 2)
            self.assertIn('acr.io', copying.call_args.args[0])

    def test_missing_baselines_fail_closed(self):
        with patch.object(module, 'repositories', return_value={'ghcr': 'ghcr.io/a/b', 'acr': 'acr.io/a/b'}), \
             patch.object(module, 'login'), patch.object(module, 'remote', return_value=None), patch.object(module, 'copy') as copying:
            with self.assertRaisesRegex(RuntimeError, 'No verified previous release'):
                module.find_source(self.identity())
            copying.assert_not_called()

    def test_newer_stable_not_overwritten(self):
        import tempfile
        import os
        import json
        with tempfile.TemporaryDirectory() as tmp, patch.object(module, 'repositories', return_value={'ghcr': 'ghcr.io/a/b'}), \
             patch.object(module, 'login'), patch.object(module, 'output', return_value=json.dumps(self.info())), \
             patch.object(module, 'remote', side_effect=[None, None, self.info('0.10.0'), self.info(), self.info()]), \
             patch.object(module, 'copy') as copying:
            cwd = os.getcwd()
            try:
                os.chdir(tmp)
                module.publish('ghcr', self.identity(), Path('image.tar'))
            finally:
                os.chdir(cwd)
            self.assertEqual(copying.call_count, 2)
            self.assertFalse(any(':stable' in call.args[1] for call in copying.call_args_list))


class SummaryTests(unittest.TestCase):
    def test_partial_and_total_results(self):
        summary_spec = importlib.util.spec_from_file_location('summary', Path(__file__).with_name('publication-summary.py'))
        summary = importlib.util.module_from_spec(summary_spec); summary_spec.loader.exec_module(summary)
        candidate = {'version': '0.9.0', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64}
        for channels in ([], ['acr'], ['ghcr'], ['acr', 'ghcr']):
            results = [{**candidate, 'channel': c} for c in channels]
            self.assertEqual(set(summary.summarize(candidate, results)), set(channels))
        with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
            summary.summarize(candidate, [{**candidate, 'channel': 'acr', 'digest': 'different'}])

class RecoveryTests(PublicationTests):
    def test_recovery_uses_existing_digest(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp, patch.object(module, 'DIRECTORY', Path(tmp)), \
             patch.object(module, 'login'), patch.object(module, 'repositories', return_value={'ghcr': 'ghcr.io/a/b'}), \
             patch.object(module, 'remote', return_value=self.info()):
            archive = Path(tmp) / 'baseline.oci.tar'; archive.write_bytes(b'archive')
            with patch.object(module, 'find_source', return_value=archive):
                self.assertEqual(module.recover_published('0.9.0', 'a' * 40), self.identity())
                self.assertEqual((Path(tmp) / 'image.oci.tar').read_bytes(), b'archive')

    def test_recovery_conflict_fails_instead_of_rebuild(self):
        with patch.object(module, 'login'), patch.object(module, 'repositories', return_value={'ghcr': 'ghcr.io/a/b'}), \
             patch.object(module, 'remote', return_value=self.info('0.8.0')):
            with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
                module.recover_published('0.9.0', 'a' * 40)

class FormalReleaseTests(unittest.TestCase):
    def test_release_assets_are_bound_to_checksums_and_tag(self):
        import hashlib
        import json
        release = {'draft': False, 'prerelease': False, 'tag_name': 'castor-v0.9.0'}
        identity = {'version': '0.9.0', 'tag': 'castor-v0.9.0', 'commit': 'a' * 40}
        digest = 'sha256:' + 'b' * 64
        def download(*args, **kwargs):
            directory = Path(args[args.index('--dir') + 1])
            (directory / 'release.json').write_text(json.dumps(identity))
            (directory / 'image-digest.txt').write_text(digest + '\n')
            (directory / 'SHA256SUMS').write_text(''.join(hashlib.sha256((directory / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in ('release.json', 'image-digest.txt')))
        for corrupt in (None, 'release.json', 'image-digest.txt'):
            def downloaded(*args, **kwargs):
                download(*args, **kwargs)
                if corrupt:
                    (Path(args[args.index('--dir') + 1]) / corrupt).write_text('corrupted asset')
            with patch.object(module, 'run', side_effect=downloaded), patch.object(module, 'output', side_effect=[json.dumps(release), json.dumps({'object': {'type': 'commit', 'sha': 'a' * 40}})]):
                if corrupt:
                    with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                        module.release_identity('0.9.0')
                else:
                    self.assertEqual(module.release_identity('0.9.0')['digest'], digest)

    def test_draft_and_prerelease_cannot_be_baseline(self):
        import json
        for flag in ('draft', 'prerelease'):
            release = {'draft': False, 'prerelease': False, 'tag_name': 'castor-v0.9.0', flag: True}
            with patch.object(module, 'output', return_value=json.dumps(release)), patch.object(module, 'run') as download:
                with self.assertRaisesRegex(RuntimeError, 'published formal'):
                    module.release_identity('0.9.0')
                download.assert_not_called()

    def test_only_latest_formal_release_can_advance_stable(self):
        import json
        releases = [[{'tag_name': tag, 'draft': draft, 'prerelease': pre} for tag, draft, pre in
                     [('castor-v0.9.0', False, False), ('castor-v0.8.2', False, False),
                      ('castor-v0.10.0', True, False), ('castor-v0.11.0', False, True), ('web-clipper-v1.0.0', False, False)]]]
        with patch.object(module, 'output', return_value=json.dumps(releases)):
            module.require_latest('0.9.0')
            with self.assertRaisesRegex(RuntimeError, 'latest formal'):
                module.require_latest('0.8.2')

    def test_draft_prepare_recovers_registry_without_reading_incomplete_assets(self):
        import tempfile
        import os
        import json
        identity = {'version': '0.9.0', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'RELEASE_COMMIT': 'a' * 40}), \
             patch.object(module, 'DIRECTORY', Path(tmp) / 'candidate'), \
             patch.object(module, 'output', return_value='a' * 40), \
             patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps({'draft': True, 'prerelease': False}), '')), \
             patch.object(module, 'candidate_receipt', return_value=None), \
             patch.object(module, 'recover_published', return_value=identity) as recover, \
             patch.object(module, 'release_identity') as formal, \
             patch.object(module, 'repositories', return_value={'ghcr': 'ghcr.io/a/b'}):
            previous = os.getcwd()
            try:
                os.chdir(tmp)
                Path('package.json').write_text('{"version":"0.9.0"}')
                module.prepare()
            finally:
                os.chdir(previous)
            recover.assert_called_once_with('0.9.0', 'a' * 40)
            formal.assert_not_called()

class DurableReceiptTests(unittest.TestCase):
    def test_receipt_read_error_is_not_absence(self):
        with patch.object(module, 'output', side_effect=RuntimeError('network')):
            with self.assertRaisesRegex(RuntimeError, 'network'):
                module.candidate_receipt('a' * 40)

    def test_receipt_requires_actions_issuer(self):
        import json
        for issuer in ('someone', 'github-actions[bot]'):
            status = {'context': module.RECEIPT_CONTEXT, 'state': 'success', 'creator': {'login': issuer}}
            with patch.object(module, 'output', return_value=json.dumps([[status]])):
                if issuer == 'someone':
                    with self.assertRaisesRegex(RuntimeError, 'issuer'):
                        module.candidate_receipt('a' * 40)
                else:
                    self.assertEqual(module.candidate_receipt('a' * 40), status)

    def test_expired_recorded_artifact_refuses_rebuild(self):
        import json
        receipt = {'target_url': 'https://github.com/Castor6/memos/actions/runs/12/artifacts/34',
                   'description': '0.9.0 sha256:' + 'b' * 64}
        with patch.object(module, 'output', return_value=json.dumps({'expired': True})):
            with self.assertRaisesRegex(RuntimeError, 'refusing to rebuild'):
                module.restore_receipt(receipt, '0.9.0', 'a' * 40)

    def test_prepare_requires_original_artifact_after_attempt(self):
        import tempfile
        import json
        import os
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'RELEASE_COMMIT': 'a' * 40}), \
             patch.object(module, 'DIRECTORY', Path(tmp) / 'candidate'), \
             patch.object(module, 'output', return_value='a' * 40), \
             patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', '(HTTP 404)')), \
             patch.object(module, 'candidate_receipt', return_value={'description': 'recorded'}), \
             patch.object(module, 'restore_receipt', side_effect=RuntimeError('artifact expired')) as restore, \
             patch.object(module, 'recover_published') as recovery, patch.object(module, 'run') as build:
            previous = os.getcwd()
            try:
                os.chdir(tmp); Path('package.json').write_text('{"version":"0.9.0"}')
                with self.assertRaisesRegex(RuntimeError, 'artifact expired'):
                    module.prepare()
            finally:
                os.chdir(previous)
            restore.assert_called_once()
            recovery.assert_not_called()
            build.assert_not_called()

    def test_first_build_allowed_with_one_registry_unknown(self):
        import tempfile
        import os
        with patch.object(module, 'repositories', return_value={'ghcr': 'ghcr.io/a/b', 'acr': 'acr.io/a/b'}), \
             patch.object(module, 'login'), patch.object(module, 'remote', side_effect=[None, RuntimeError('ACR offline')]):
            self.assertIsNone(module.recover_published('0.9.0', 'a' * 40))
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'RELEASE_COMMIT': 'a' * 40}), \
             patch.object(module, 'DIRECTORY', Path(tmp) / 'candidate'), \
             patch.object(module, 'output', side_effect=['a' * 40, '{"version":"0.8.2"}']), \
             patch.object(module.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 1, '', '(HTTP 404)'), subprocess.CompletedProcess([], 0, b'manifest', b'')]), \
             patch.object(module, 'candidate_receipt', return_value=None), patch.object(module, 'recover_published', return_value=None), \
             patch.object(module, 'release_identity', return_value={}), patch.object(module, 'find_source', return_value=Path(tmp) / 'baseline.tar'), \
             patch.object(module, 'repositories', return_value={'ghcr': 'ghcr.io/a/b'}), patch.object(module, 'run') as build:
            previous = os.getcwd()
            try:
                os.chdir(tmp); Path('package.json').write_text('{"version":"0.9.0"}')
                module.prepare()
            finally:
                os.chdir(previous)
            self.assertEqual(sum(call.args[:2] == ('docker', 'build') for call in build.call_args_list), 1)

    def test_receipt_conflicting_digest_cannot_be_replaced(self):
        import tempfile
        import json
        import os
        with tempfile.TemporaryDirectory() as tmp, patch.object(module, 'DIRECTORY', Path(tmp)), \
             patch.dict(os.environ, {'RELEASE_COMMIT': 'a' * 40, 'CANDIDATE_ARTIFACT_ID': '34', 'GITHUB_RUN_ID': '12'}), \
             patch.object(module, 'candidate_receipt', return_value={'description': '0.9.0 sha256:' + 'c' * 64}), \
             patch.object(module, 'run') as write:
            (Path(tmp) / 'image.json').write_text(json.dumps({'version': '0.9.0', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64}))
            with self.assertRaisesRegex(RuntimeError, 'conflicting'):
                module.record_receipt()
            write.assert_not_called()

    def test_restore_verifies_workflow_metadata_and_image_digest(self):
        import tempfile
        import io
        import json
        import zipfile
        import hashlib
        identity = {'version': '0.9.0', 'commit': 'a' * 40, 'digest': 'sha256:' + 'b' * 64}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('image.json', json.dumps(identity))
            archive.writestr('image.oci.tar', b'tested OCI bytes')
        archive_bytes = buffer.getvalue()
        receipt = {'target_url': 'https://github.com/Castor6/memos/actions/runs/12/artifacts/34',
                   'description': '0.9.0 ' + identity['digest']}
        artifact = {'name': 'memos-0.9.0-' + 'a' * 40 + '-attempt-1', 'expired': False,
                    'workflow_run': {'id': 12}, 'digest': 'sha256:' + hashlib.sha256(archive_bytes).hexdigest()}
        workflow = {'repository': {'full_name': 'Castor6/memos'}, 'path': '.github/workflows/release-candidate.yml', 'event': 'workflow_dispatch'}
        jobs = [{'jobs': [{'name': 'registry', 'conclusion': 'failure'}]},
                {'jobs': [{'name': 'source', 'conclusion': 'success'}]}]
        info = {'Digest': identity['digest'], 'Architecture': 'amd64', 'Os': 'linux', 'Labels': {
            'org.opencontainers.image.source': module.SOURCE, 'org.opencontainers.image.version': '0.9.0',
            'org.opencontainers.image.revision': 'a' * 40}}
        for digest in (identity['digest'], 'sha256:' + 'c' * 64):
            with tempfile.TemporaryDirectory() as tmp, patch.object(module, 'DIRECTORY', Path(tmp)), \
                 patch.object(module, 'output', side_effect=[json.dumps(item) for item in (artifact, workflow, jobs, {**info, 'Digest': digest})]) as output, \
                 patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, archive_bytes, b'')):
                if digest == identity['digest']:
                    self.assertEqual(module.restore_receipt(receipt, '0.9.0', 'a' * 40), identity)
                    jobs_call = output.call_args_list[2].args
                    self.assertIn('--paginate', jobs_call)
                    self.assertIn('--slurp', jobs_call)
                    self.assertIn('filter=all', jobs_call[-1])
                else:
                    with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
                        module.restore_receipt(receipt, '0.9.0', 'a' * 40)
