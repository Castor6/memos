#!/usr/bin/env python3
"""Build one tested OCI artifact and publish independently to either registry."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import zipfile

SOURCE = 'https://github.com/Castor6/memos'
GH_REPO = 'Castor6/memos'
DIRECTORY = Path('build/candidate')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def output(*args):
    return run(*args, capture_output=True, timeout=90).stdout.strip()


def version_tuple(value):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('Invalid release version')
    return tuple(map(int, value.split('.')))


def repositories():
    values = {'acr': os.environ['ACR_IMAGE'], 'ghcr': os.environ.get('GHCR_IMAGE', 'ghcr.io/castor6/memos')}
    for value in values.values():
        if not re.fullmatch(r'[a-z0-9.-]+/[a-z0-9_./-]+', value):
            raise ValueError('Invalid registry repository')
    return values


def login(channel):
    repo = repositories()[channel]
    password = os.environ['ACR_PASSWORD' if channel == 'acr' else 'GH_TOKEN']
    username = os.environ['ACR_USERNAME'] if channel == 'acr' else os.environ['GITHUB_ACTOR']
    run('skopeo', 'login', '--username', username, '--password-stdin', repo.split('/')[0], input=password + '\n', timeout=90)


def remote(image):
    result = subprocess.run(['skopeo', 'inspect', 'docker://' + image], capture_output=True, text=True, timeout=90)
    if result.returncode == 0:
        return json.loads(result.stdout)
    if re.search(r'manifest unknown|no such manifest|name unknown', result.stderr, re.I):
        return None
    raise RuntimeError('Cannot establish registry tag state: ' + result.stderr.strip())


def exists(image):
    return remote(image) is not None


def verify(info, version, commit, digest=None):
    labels = info.get('Labels') or {}
    if any(labels.get('org.opencontainers.image.' + key) != value for key, value in
           (('source', SOURCE), ('version', version), ('revision', commit))):
        raise RuntimeError('Image release identity mismatch')
    if info.get('Architecture') != 'amd64' or info.get('Os') != 'linux':
        raise RuntimeError('Image platform mismatch')
    if digest and info.get('Digest') != digest:
        raise RuntimeError('Image digest mismatch')


def copy(source, destination):
    for attempt in range(3):
        try:
            run('skopeo', 'copy', '--preserve-digests', source, destination, timeout=300)
            return
        except (subprocess.SubprocessError, OSError):
            if attempt == 2:
                raise
            time.sleep(5)


def release_identity(version):
    version_tuple(version)
    release = json.loads(output('gh', 'api', f'repos/{GH_REPO}/releases/tags/castor-v{version}'))
    if release.get('draft') is not False or release.get('prerelease') is not False or release.get('tag_name') != 'castor-v' + version:
        raise RuntimeError('Expected a published formal release')
    with tempfile.TemporaryDirectory() as temp:
        run('gh', 'release', 'download', 'castor-v' + version, '--repo', GH_REPO,
            '--pattern', 'release.json', '--pattern', 'image-digest.txt', '--pattern', 'SHA256SUMS', '--dir', temp, timeout=90)
        checksums = {}
        for line in (Path(temp) / 'SHA256SUMS').read_text().splitlines():
            match = re.fullmatch(r'([a-f0-9]{64})  ([^/\\]+)', line)
            if not match or match[2] in checksums:
                raise RuntimeError('Invalid release checksum manifest')
            checksums[match[2]] = match[1]
        for name in ('release.json', 'image-digest.txt'):
            if checksums.get(name) != hashlib.sha256((Path(temp) / name).read_bytes()).hexdigest():
                raise RuntimeError('Release asset checksum mismatch: ' + name)
        identity = json.loads((Path(temp) / 'release.json').read_text())
        digest = (Path(temp) / 'image-digest.txt').read_text().strip()
    if (identity.get('version') != version or identity.get('tag') != 'castor-v' + version
            or not re.fullmatch(r'[a-f0-9]{40}', identity.get('commit', ''))
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest)):
        raise RuntimeError('Invalid immutable release metadata')
    # Bind release metadata to its immutable Git tag, including annotated tags.
    ref = json.loads(output('gh', 'api', f'repos/{GH_REPO}/git/ref/tags/castor-v{version}'))['object']
    for _ in range(10):
        if ref['type'] != 'tag':
            break
        ref = json.loads(output('gh', 'api', f'repos/{GH_REPO}/git/tags/{ref["sha"]}'))['object']
    if ref['type'] != 'commit' or ref['sha'] != identity['commit']:
        raise RuntimeError('Release metadata and Git tag disagree')
    return {'version': version, 'commit': identity['commit'], 'digest': digest}


def require_latest(version):
    pages = json.loads(output('gh', 'api', '--paginate', '--slurp', f'repos/{GH_REPO}/releases?per_page=100'))
    versions = []
    for release in (item for page in pages for item in page):
        match = re.fullmatch(r'castor-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))', release.get('tag_name', ''))
        if match and release.get('draft') is False and release.get('prerelease') is False:
            versions.append(version_tuple(match[1]))
    if not versions or version_tuple(version) != max(versions):
        raise RuntimeError('Only the latest formal release may advance stable during transfer')


def find_source(identity):
    errors = []
    for channel in ('ghcr', 'acr'):
        image = repositories()[channel] + '@' + identity['digest']
        try:
            login(channel)
            info = remote(image)
            if info is None:
                raise RuntimeError('Immutable baseline is absent')
            verify(info, identity['version'], identity['commit'], identity['digest'])
            # Copy now so transfer failures also fall back to the other registry.
            copy('docker://' + image, 'oci-archive:' + str(DIRECTORY / 'baseline.oci.tar'))
            return DIRECTORY / 'baseline.oci.tar'
        except (RuntimeError, subprocess.SubprocessError, OSError) as error:
            errors.append(f'{channel}: {error}')
    raise RuntimeError('No verified previous release available: ' + '; '.join(errors))


def recover_published(version, commit):
    """Recover a tested version whose registry upload preceded GitHub publication."""
    for channel in ('ghcr', 'acr'):
        try:
            login(channel)
            image = repositories()[channel] + ':castor-v' + version
            info = remote(image)
        except (RuntimeError, subprocess.SubprocessError, OSError):
            continue
        if info is None:
            continue
        # An identity conflict must never be hidden by trying another source.
        verify(info, version, commit)
        identity = {'version': version, 'commit': commit, 'digest': info['Digest']}
        archive = find_source(identity)
        archive.replace(DIRECTORY / 'image.oci.tar')
        return identity
    return None


RECEIPT_CONTEXT = 'memos/registry-candidate'


def candidate_receipt(commit):
    pages = json.loads(output('gh', 'api', '--paginate', '--slurp',
                              f'repos/{GH_REPO}/commits/{commit}/statuses?per_page=100'))
    for status in (item for page in pages for item in page):
        if status.get('context') == RECEIPT_CONTEXT:
            if status.get('state') != 'success' or status.get('creator', {}).get('login') != 'github-actions[bot]':
                raise RuntimeError('Candidate receipt has an unexpected issuer or state')
            return status
    return None


def restore_receipt(receipt, version, commit):
    match = re.fullmatch(re.escape(f'https://github.com/{GH_REPO}/actions/runs/') + r'(\d+)/artifacts/(\d+)', receipt.get('target_url', ''))
    digest_match = re.fullmatch(re.escape(version) + r' (sha256:[a-f0-9]{64})', receipt.get('description', ''))
    if not match or not digest_match:
        raise RuntimeError('Candidate receipt identity is invalid')
    run_id, artifact_id = match.groups()
    base = 'repos/' + GH_REPO
    artifact = json.loads(output('gh', 'api', f'{base}/actions/artifacts/{artifact_id}'))
    expected_name = re.escape(f'memos-{version}-{commit}') + r'(?:-attempt-[1-9]\d*)?'
    if (artifact.get('expired') or not re.fullmatch(expected_name, artifact.get('name', ''))
            or str(artifact.get('workflow_run', {}).get('id')) != run_id):
        raise RuntimeError('Recorded candidate artifact unavailable or mismatched; refusing to rebuild')
    workflow = json.loads(output('gh', 'api', f'{base}/actions/runs/{run_id}'))
    if (workflow.get('repository', {}).get('full_name') != GH_REPO
            or workflow.get('path', '').split('@')[0] != '.github/workflows/release-candidate.yml'
            or workflow.get('event') not in ('pull_request', 'workflow_dispatch')):
        raise RuntimeError('Candidate artifact came from an untrusted workflow')
    job_pages = json.loads(output('gh', 'api', '--paginate', '--slurp',
                                 f'{base}/actions/runs/{run_id}/jobs?filter=all&per_page=100'))
    jobs = (job for page in job_pages for job in page['jobs'])
    if not any(job.get('name') == 'source' and job.get('conclusion') == 'success' for job in jobs):
        raise RuntimeError('Candidate run did not validate its version PR')
    archive = subprocess.run(['gh', 'api', f'{base}/actions/artifacts/{artifact_id}/zip'], check=True, capture_output=True, timeout=300).stdout
    if artifact.get('digest') and artifact['digest'] != 'sha256:' + hashlib.sha256(archive).hexdigest():
        raise RuntimeError('Candidate artifact checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as contents:
        names = contents.namelist()
        if any(names.count(name) != 1 for name in ('image.json', 'image.oci.tar')):
            raise RuntimeError('Candidate artifact image files missing or duplicated')
        for name in ('image.json', 'image.oci.tar'):
            (DIRECTORY / name).write_bytes(contents.read(name))
    identity = json.loads((DIRECTORY / 'image.json').read_text())
    if any(identity.get(key) != value for key, value in
           {'version': version, 'commit': commit, 'digest': digest_match[1]}.items()):
        raise RuntimeError('Candidate artifact contradicts durable receipt')
    info = json.loads(output('skopeo', 'inspect', 'oci-archive:' + str(DIRECTORY / 'image.oci.tar')))
    verify(info, version, commit, digest_match[1])
    return identity


def record_receipt():
    identity = json.loads((DIRECTORY / 'image.json').read_text())
    version, commit, digest = identity['version'], identity['commit'], identity['digest']
    version_tuple(version)
    if commit != os.environ['RELEASE_COMMIT'] or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise RuntimeError('Invalid candidate receipt identity')
    artifact_id, run_id = os.environ['CANDIDATE_ARTIFACT_ID'], os.environ['GITHUB_RUN_ID']
    if not artifact_id.isdigit() or not run_id.isdigit():
        raise RuntimeError('Invalid artifact or workflow run ID')
    previous = candidate_receipt(commit)
    description = version + ' ' + digest
    if previous and previous.get('description') != description:
        raise RuntimeError('Refusing to replace a conflicting durable candidate receipt')
    run('gh', 'api', f'repos/{GH_REPO}/statuses/{commit}', '--method', 'POST', '--input', '-',
        input=json.dumps({'state': 'success', 'context': RECEIPT_CONTEXT, 'description': description,
                          'target_url': f'https://github.com/{GH_REPO}/actions/runs/{run_id}/artifacts/{artifact_id}'}),
        capture_output=True, timeout=90)


def prepare():
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    version = json.loads(Path('package.json').read_text())['version']
    version_tuple(version)
    commit = os.environ['RELEASE_COMMIT']
    if version == '0.0.0' or not re.fullmatch(r'[a-f0-9]{40}', commit) or output('git', 'rev-parse', 'HEAD') != commit:
        raise RuntimeError('Invalid approved release checkout')
    # Reuse an already published version on retry; never rebuild its immutable content.
    existing = subprocess.run(['gh', 'api', f'repos/{GH_REPO}/releases/tags/castor-v{version}'], capture_output=True, text=True, timeout=90)
    state = json.loads(existing.stdout) if existing.returncode == 0 else None
    if state is not None and state.get('prerelease'):
        raise RuntimeError('Existing version is a prerelease')
    if state is not None and not state.get('draft'):
        identity = release_identity(version)
        if identity['commit'] != commit:
            raise RuntimeError('Existing version belongs to another commit')
        archive = find_source(identity)
        archive.replace(DIRECTORY / 'image.oci.tar')
    else:
        if state is None and '(HTTP 404)' not in existing.stderr:
            raise RuntimeError('Cannot establish existing release state')
        receipt = candidate_receipt(commit)
        identity = restore_receipt(receipt, version, commit) if receipt else recover_published(version, commit)
        if identity is None:
            previous = json.loads(output('git', 'show', 'HEAD^:package.json'))['version']
            baseline = find_source(release_identity(previous))
            run('skopeo', 'copy', 'oci-archive:' + str(baseline), 'docker-daemon:memos-baseline:tested', timeout=300)
            candidate = 'memos-candidate:tested'
            run('docker', 'build', '--platform', 'linux/amd64', '-f', 'scripts/Dockerfile',
                '--build-arg', 'VERSION=' + version, '--build-arg', 'COMMIT=' + commit,
                '--label', 'org.opencontainers.image.source=' + SOURCE,
                '--label', 'org.opencontainers.image.version=' + version,
                '--label', 'org.opencontainers.image.revision=' + commit, '-t', candidate, '.')
            run('bash', 'scripts/release_smoke_test.sh', '--candidate-image', candidate, '--previous-image', 'memos-baseline:tested')
            run('skopeo', 'copy', 'docker-daemon:' + candidate, 'oci-archive:' + str(DIRECTORY / 'image.oci.tar'), timeout=300)
            raw = subprocess.run(['skopeo', 'inspect', '--raw', 'oci-archive:' + str(DIRECTORY / 'image.oci.tar')], check=True, capture_output=True).stdout
            identity = {'version': version, 'commit': commit, 'digest': 'sha256:' + hashlib.sha256(raw).hexdigest()}
    (DIRECTORY / 'baseline.oci.tar').unlink(missing_ok=True)
    (DIRECTORY / 'image.json').write_text(json.dumps({**identity, 'image': repositories()['ghcr'] + '@' + identity['digest']}, indent=2) + '\n')


def publish(channel, identity, archive, advance=True):
    login(channel)
    repo = repositories()[channel]
    version, commit, digest = identity['version'], identity['commit'], identity['digest']
    info = json.loads(output('skopeo', 'inspect', 'oci-archive:' + str(archive)))
    verify(info, version, commit, digest)
    # Inspect all immutable tags before writing anything.
    tags = ('castor-v' + version, 'sha-' + commit)
    for tag in tags:
        current = remote(repo + ':' + tag)
        if current is not None:
            verify(current, version, commit, digest)
    stable = remote(repo + ':stable') if advance else None
    move_stable = advance
    if stable:
        labels = stable.get('Labels') or {}
        stable_version = labels.get('org.opencontainers.image.version', '')
        if labels.get('org.opencontainers.image.source') != SOURCE:
            raise RuntimeError('Unexpected stable image source')
        if version_tuple(stable_version) > version_tuple(version):
            move_stable = False
        elif stable_version == version:
            verify(stable, version, commit, digest)
    for tag in tags:
        copy('oci-archive:' + str(archive), 'docker://' + repo + ':' + tag)
        verify(remote(repo + ':' + tag) or {}, version, commit, digest)
    if move_stable:
        copy('oci-archive:' + str(archive), 'docker://' + repo + ':stable')
        verify(remote(repo + ':stable') or {}, version, commit, digest)
    result = {**identity, 'image': repo + '@' + digest, 'channel': channel, 'stableAdvanced': move_stable}
    Path('build/result').mkdir(parents=True, exist_ok=True)
    Path('build/result/image.json').write_text(json.dumps(result, indent=2) + '\n')
    with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a') as stream:
        stream.write(f'{channel}: published {version} `{digest}`; stable advanced: {move_stable}\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('prepare', 'publish', 'transfer', 'receipt'))
    parser.add_argument('--channel', choices=('acr', 'ghcr'))
    parser.add_argument('--version')
    parser.add_argument('--advance-stable', action='store_true')
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare()
    elif args.command == 'receipt':
        record_receipt()
    elif args.command == 'publish':
        if not args.channel:
            parser.error('--channel is required')
        publish(args.channel, json.loads((DIRECTORY / 'image.json').read_text()), DIRECTORY / 'image.oci.tar')
    else:
        if not args.channel or not args.version:
            parser.error('--channel and --version are required')
        DIRECTORY.mkdir(parents=True, exist_ok=True)
        identity = release_identity(args.version)
        if args.advance_stable:
            require_latest(args.version)
        archive = find_source(identity)
        publish(args.channel, identity, archive, advance=args.advance_stable)


if __name__ == '__main__':
    main()
