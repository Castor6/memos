#!/usr/bin/env python3
"""Publish verified candidate artifacts as an idempotent GitHub Release."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return 'sha256:' + h.hexdigest()


def version_tuple(version):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version) or version == '0.0.0':
        raise ValueError('Invalid personal version')
    return tuple(map(int, version.split('.')))


def verify_web_clipper(path, version, tag, commit):
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or archive.testzip() is not None:
                raise RuntimeError('Invalid web clipper archive entries')
            manifest = json.loads(archive.read('manifest.json'))
            identity = json.loads(archive.read('castor-release.json'))
            if any(identity.get(key) != value for key, value in {
                'version': version, 'tag': tag, 'commit': commit,
            }.items()):
                raise RuntimeError('Web clipper release identity mismatch')
            if (manifest.get('manifest_version') != 3 or manifest.get('version') != version
                    or not manifest.get('key') or 'update_url' in manifest
                    or manifest.get('background', {}).get('service_worker') not in names
                    or manifest.get('action', {}).get('default_popup', 'src/popup/index.html') not in names):
                raise RuntimeError('Web clipper manifest mismatch')
    except (zipfile.BadZipFile, KeyError, ValueError, AttributeError) as error:
        raise RuntimeError('Invalid web clipper archive') from error


def release_notes(source, version):
    sections = re.split(r'^## ', (source / 'CHANGELOG.md').read_text(), flags=re.M)
    notes = [s.split('\n', 1)[1].strip() for s in sections[1:] if s.split('\n', 1)[0].strip() == version]
    if len(notes) != 1 or not notes[0]:
        raise RuntimeError('Expected exactly one nonempty changelog section for this version')
    return notes[0]


def write_checksums(directory):
    files = sorted(p for p in directory.iterdir() if p.name != 'SHA256SUMS')
    (directory / 'SHA256SUMS').write_text(''.join(digest(p)[7:] + '  ' + p.name + '\n' for p in files))


def copy_verified(source, destination, names):
    checksums = {}
    for line in (source / 'SHA256SUMS').read_text().splitlines():
        checksum, name = line.split(maxsplit=1)
        if name in checksums or not re.fullmatch(r'[0-9a-f]{64}', checksum):
            raise RuntimeError('Invalid candidate checksum manifest')
        checksums[name] = 'sha256:' + checksum
    for name in names:
        path = source / name
        if path.is_symlink() or not path.is_file() or digest(path) != checksums.get(name):
            raise RuntimeError('Candidate checksum mismatch: ' + name)
        shutil.copyfile(path, destination / name)


def installation_note(filename):
    return (f'\n浏览器扩展：下载 `{filename}`，解压后在 Chrome / Edge 的扩展管理页开启开发者模式，'
            '选择「加载已解压的扩展程序」。后续更新需替换文件并重新加载；此 ZIP 不提供商店自动更新。\n')


def stage_web_clipper(root, destination, commit):
    version = json.loads((root / 'extensions/web-clipper/release/package.json').read_text())['version']
    version_tuple(version)
    if version == '0.0.1':
        raise RuntimeError('Cannot publish the extension placeholder')
    tag = 'web-clipper-v' + version
    filename = f'memos-web-clipper-chromium-v{version}.zip'
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise RuntimeError('Invalid release commit')
    archive = destination / filename
    if archive.is_symlink():
        raise RuntimeError('Candidate archive must not be a symlink')
    verify_web_clipper(archive, version, tag, commit)
    shutil.copyfile(root / 'extensions/web-clipper/release/CHANGELOG.md', destination / 'CHANGELOG.md')
    shutil.copyfile(root / 'LICENSE', destination / 'LICENSE')
    release_notes(destination, version)
    (destination / 'release.json').write_text(json.dumps({
        'component': 'web-clipper', 'version': version, 'tag': tag, 'commit': commit, 'file': filename,
    }, indent=2) + '\n')
    write_checksums(destination)


def prepare(source, destination, commit, component='memos'):
    if component not in ('memos', 'web-clipper'):
        raise RuntimeError('Unknown release component')
    release = json.loads((source / 'release.json').read_text())
    version = release['version']
    version_tuple(version)
    tag = ('web-clipper-v' if component == 'web-clipper' else 'castor-v') + version
    if (not re.fullmatch(r'[0-9a-f]{40}', commit) or release.get('commit') != commit or release.get('tag') != tag
            or ('component' in release and release['component'] != component)):
        raise RuntimeError('Candidate release identity mismatch')
    if component == 'web-clipper':
        filename = f'memos-web-clipper-chromium-v{version}.zip'
        if release != {'component': component, 'version': version, 'tag': tag, 'commit': commit, 'file': filename}:
            raise RuntimeError('Candidate web clipper metadata mismatch')
        if version == '0.0.1':
            raise RuntimeError('Cannot publish the extension placeholder')
        copy_verified(source, destination, ('CHANGELOG.md', 'LICENSE', 'release.json', filename))
        verify_web_clipper(source / filename, version, tag, commit)
        body = release_notes(source, version) + f'\n\n提交：`{commit}`\n' + installation_note(filename)
        write_checksums(destination)
        return version, tag, body

    # Legacy bundled releases must still contain their original extension asset.
    extension_name = None
    if 'component' not in release:
        extension = release.get('webClipper')
        extension_version = extension.get('version') if isinstance(extension, dict) else None
        if not isinstance(extension_version, str) or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', extension_version):
            raise RuntimeError('Candidate web clipper metadata mismatch')
        extension_name = f'memos-web-clipper-chromium-v{extension_version}.zip'
        if extension != {'version': extension_version, 'file': extension_name}:
            raise RuntimeError('Candidate web clipper metadata mismatch')
    elif 'webClipper' in release:
        raise RuntimeError('Independent Memos releases must not bundle the extension')
    image = json.loads((source / 'image.json').read_text())
    if image.get('commit') != commit or image.get('version') != version:
        raise RuntimeError('Published image identity mismatch')
    match = re.fullmatch(r'[^\s@]+@(sha256:[0-9a-f]{64})', image.get('image', ''))
    if not match:
        raise RuntimeError('Published image digest is missing')
    image_digest = match[1]
    names = ('memos-linux-amd64', 'memos-linux-arm64', 'CHANGELOG.md', 'LICENSE', 'release.json')
    copy_verified(source, destination, names + ((extension_name,) if extension_name else ()))
    if extension_name:
        verify_web_clipper(source / extension_name, extension_version, tag, commit)
    # Public assets expose the immutable digest, not the private registry location.
    (destination / 'image-digest.txt').write_text(image_digest + '\n')
    write_checksums(destination)
    body = release_notes(source, version) + f'\n\n提交：`{commit}`\n\n镜像摘要：`{image_digest}`\n\n镜像构建和安装/升级测试已通过；服务器更新状态需单独确认。\n'
    if extension_name:
        body += installation_note(extension_name)
    return version, tag, body


class GitHub:
    def __init__(self, repo):
        if repo != 'Castor6/memos':
            raise RuntimeError('Unexpected release repository')
        self.repo = repo

    def api(self, path, method='GET', data=None, optional=False):
        command = ['gh', 'api', 'repos/' + self.repo + '/' + path, '--method', method]
        if data is not None:
            command += ['--input', '-']
        result = subprocess.run(command, input=json.dumps(data) if data is not None else None,
                                capture_output=True, text=True, check=False)
        if result.returncode:
            if optional and '(HTTP 404)' in result.stderr:
                return None
            raise RuntimeError('GitHub API request failed: ' + result.stderr.strip())
        return json.loads(result.stdout)

    def listing(self, path):
        items = []
        for page in range(1, 1001):
            batch = self.api(f'{path}?per_page=100&page={page}')
            items.extend(batch)
            if len(batch) < 100:
                return items
        raise RuntimeError('GitHub pagination limit exceeded')

    def upload(self, tag, path):
        subprocess.run(['gh', 'release', 'upload', tag, str(path), '--repo', self.repo], check=True)

    def asset_digest(self, asset):
        if re.fullmatch(r'sha256:[0-9a-f]{64}', asset.get('digest') or ''):
            return asset['digest']
        # Older assets may not expose a digest. Compare their actual bytes.
        result = subprocess.run(['gh', 'api', f'repos/{self.repo}/releases/assets/{asset["id"]}',
                                 '-H', 'Accept: application/octet-stream'], check=True, capture_output=True)
        return 'sha256:' + hashlib.sha256(result.stdout).hexdigest()


def publish(client, directory, commit, version, tag, body, component='memos'):
    if component not in ('memos', 'web-clipper') or tag != ('web-clipper-v' if component == 'web-clipper' else 'castor-v') + version:
        raise RuntimeError('Release tag does not match its component')
    # Never move an existing tag. Resolve annotated tags to the final commit.
    ref = client.api('git/ref/tags/' + tag, optional=True)
    if ref is None:
        ref = client.api('git/refs', 'POST', {'ref': 'refs/tags/' + tag, 'sha': commit})
    obj = ref['object']
    for _ in range(10):
        if obj['type'] != 'tag':
            break
        obj = client.api('git/tags/' + obj['sha'])['object']
    if obj['type'] != 'commit' or obj['sha'] != commit:
        raise RuntimeError('Existing release tag points to a different commit')
    releases = client.listing('releases')
    matching = [r for r in releases if r['tag_name'] == tag]
    if len(matching) > 1:
        raise RuntimeError('Duplicate release tag')
    release = matching[0] if matching else client.api('releases', 'POST', {
        'tag_name': tag, 'target_commitish': commit, 'name': tag, 'body': body,
        'draft': True, 'prerelease': False, 'make_latest': 'false'})
    if release.get('prerelease'):
        raise RuntimeError('Existing release unexpectedly marked prerelease')
    assets = {a['name']: a for a in client.listing(f'releases/{release["id"]}/assets')}
    for path in sorted(directory.iterdir()):
        asset = assets.get(path.name)
        if asset:
            if asset.get('state') != 'uploaded' or client.asset_digest(asset) != digest(path):
                raise RuntimeError('Existing release asset differs: ' + path.name)
        elif not release['draft']:
            raise RuntimeError('Published release is missing asset: ' + path.name)
        else:
            client.upload(tag, path)
    # Read back every uploaded asset before exposing the release.
    assets = {a['name']: a for a in client.listing(f'releases/{release["id"]}/assets')}
    for path in directory.iterdir():
        asset = assets.get(path.name)
        if not asset or asset.get('state') != 'uploaded' or client.asset_digest(asset) != digest(path):
            raise RuntimeError('Uploaded release asset verification failed: ' + path.name)
    if release['draft']:
        newer = any(not r['draft'] and not r['prerelease'] and re.fullmatch(r'castor-v\d+\.\d+\.\d+', r['tag_name'])
                    and version_tuple(r['tag_name'][8:]) > version_tuple(version) for r in releases)
        release = client.api(f'releases/{release["id"]}', 'PATCH', {
            'draft': False, 'name': tag, 'body': body, 'make_latest': 'true' if component == 'memos' and not newer else 'false'})
    return release['html_url']


def main():
    commit = os.environ['RELEASE_COMMIT']
    if sys.argv[1:] == ['stage-web-clipper']:
        stage_web_clipper(Path('.'), Path('build/web-clipper'), commit)
        return
    if sys.argv[1:]:
        raise RuntimeError('Unknown release command')
    client = GitHub(os.environ['GITHUB_REPOSITORY'])
    component = os.environ.get('RELEASE_COMPONENT', 'memos')
    source = Path('build/web-clipper' if component == 'web-clipper' else 'build/candidate')
    with tempfile.TemporaryDirectory(prefix='memos-github-release-') as temp:
        destination = Path(temp)
        version, tag, body = prepare(source, destination, commit, component)
        url = publish(client, destination, commit, version, tag, body, component)
    print('GitHub Release verified: ' + url)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'GitHub Release: {url}\n')


if __name__ == '__main__':
    main()
