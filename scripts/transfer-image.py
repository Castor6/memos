#!/usr/bin/env python3
"""Copy the latest published application image without rebuilding or changing its digest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from registry_channel import credentials


def run(*args, input=None):
    return subprocess.run(args, input=input, capture_output=True, text=True, check=True, timeout=600).stdout.strip()


def inspect(ref, missing=False):
    result = subprocess.run(['skopeo', 'inspect', 'docker://' + ref], capture_output=True, text=True, timeout=90)
    if result.returncode:
        if missing and re.search(r'manifest unknown|name unknown|no such manifest', result.stderr, re.I):
            return None
        raise RuntimeError('Cannot establish registry image state: ' + result.stderr.strip())
    return json.loads(result.stdout)


def version_tuple(value):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('Invalid version')
    return tuple(map(int, value.split('.')))


def identity(image, source):
    labels = image.get('Labels') or {}
    version = labels.get('org.opencontainers.image.version', '')
    commit = labels.get('org.opencontainers.image.revision', '')
    version_tuple(version)
    if (labels.get('org.opencontainers.image.source') != 'https://github.com/' + source
            or not re.fullmatch(r'[a-f0-9]{40}', commit)
            or not re.fullmatch(r'sha256:[a-f0-9]{64}', image.get('Digest', ''))
            or image.get('Architecture') != 'amd64' or image.get('Os') != 'linux'):
        raise RuntimeError('Unexpected image identity or platform')
    return version, commit


def guard(existing, candidate, source, stable=False):
    if not existing:
        return
    new_version, _ = identity(candidate, source)
    old_version, _ = identity(existing, source)
    if stable and version_tuple(old_version) < version_tuple(new_version):
        return
    if existing['Digest'] != candidate['Digest']:
        raise RuntimeError('Refusing to replace immutable image or downgrade stable')


def verify_release(source, tag, image, version, commit):
    release = json.loads(run('gh', 'api', f'repos/{source}/releases/tags/{tag}'))
    if release.get('draft') or release.get('prerelease') or release.get('tag_name') != tag:
        raise RuntimeError('Expected a published stable application release')
    with tempfile.TemporaryDirectory() as temporary:
        run('gh', 'release', 'download', tag, '--repo', source, '--dir', temporary,
            '--pattern', 'release.json', '--pattern', 'image-digest.txt', '--pattern', 'SHA256SUMS')
        root = Path(temporary)
        checksums = {line.split(maxsplit=1)[1].lstrip('*'): line.split()[0]
                     for line in (root / 'SHA256SUMS').read_text().splitlines() if line.strip()}
        for filename in ('release.json', 'image-digest.txt'):
            if hashlib.sha256((root / filename).read_bytes()).hexdigest() != checksums.get(filename):
                raise RuntimeError('Release asset checksum mismatch')
        metadata = json.loads((root / 'release.json').read_text())
        if metadata.get('version') != version or metadata.get('commit') != commit:
            raise RuntimeError('Published release identity mismatch')
        digest = (root / 'image-digest.txt').read_text().strip().split('@')[-1]
        if digest != image['Digest']:
            raise RuntimeError('Image differs from the tested published release')


def transfer(source, source_repo, destination_repo, prefix):
    # Stable is validated against public release assets before any destination writes.
    candidate = inspect(source_repo + ':stable')
    version, commit = identity(candidate, source)
    verify_release(source, prefix + version, candidate, version, commit)
    immutable = source_repo + '@' + candidate['Digest']
    refs = [destination_repo + ':' + prefix + version, destination_repo + ':sha-' + commit,
            destination_repo + ':stable']
    for ref in refs:
        guard(inspect(ref, missing=True), candidate, source, stable=ref.endswith(':stable'))
    for ref in refs:
        guard(inspect(ref, missing=True), candidate, source, stable=ref.endswith(':stable'))
        run('skopeo', 'copy', '--all', '--preserve-digests', 'docker://' + immutable, 'docker://' + ref)
        copied = inspect(ref)
        guard(copied, candidate, source)
        if copied['Digest'] != candidate['Digest']:
            raise RuntimeError('Copied digest mismatch')
    print('Transferred verified release ' + version + '; digest preserved: ' + candidate['Digest'])
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as output:
            output.write(f'Transferred version {version}; digest `{candidate["Digest"]}`.\n'
                         'Publication channel and server configuration must be switched after verifying target access.\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['ghcr', 'acr'], required=True)
    args = parser.parse_args()
    source = os.environ['GITHUB_REPOSITORY']
    if source not in ('Castor6/memos', 'Castor6/sayseed'):
        raise RuntimeError('Unexpected source repository')
    origin = 'acr' if args.target == 'ghcr' else 'ghcr'
    logins = []
    try:
        repositories = {}
        for selected in (origin, args.target):
            registry, repository, username, password = credentials(source, selected)
            run('skopeo', 'login', registry, '--username', username, '--password-stdin', input=password + '\n')
            logins.append(registry)
            repositories[selected] = repository
        transfer(source, repositories[origin], repositories[args.target], 'castor-v' if source.endswith('/memos') else 'v')
    finally:
        for registry in logins:
            run('skopeo', 'logout', registry)


if __name__ == '__main__':
    main()
