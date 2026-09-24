#!/usr/bin/env python3
"""Package an already built Chromium extension for a Castor Memos release."""

import argparse
import base64
import binascii
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import zipfile
from html.parser import HTMLParser


EXTENSION_ROOT = Path(__file__).resolve().parents[1]
OFFICIAL_EXTENSION_ID = "nebaoebnljalfegiidibihhkebeiklbl"
RUNTIME_SUFFIXES = {
    ".js", ".css", ".html", ".json", ".png", ".svg", ".ico", ".jpg",
    ".jpeg", ".gif", ".webp", ".avif", ".woff", ".woff2", ".ttf", ".otf",
}
TEXT_SUFFIXES = {".js", ".css", ".html", ".json", ".svg"}
DEVELOPMENT_MARKERS = (
    "@vite/client", "/@react-refresh", "/@vite/env", "__vite_plugin_react_preamble_installed__",
    "http://localhost:5173", "http://127.0.0.1:5173", "sourceMappingURL=",
)
SECRET_NAME = re.compile(r"(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|private)(?:[._-]|$)", re.I)


class PackageError(ValueError):
    """An unsafe or incomplete release input."""


def git(root, *args):
    try:
        return subprocess.check_output(
            ["git", *args], cwd=root, text=True, encoding="utf-8", stderr=subprocess.PIPE,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise PackageError("Packaging requires a readable Git checkout.") from error


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise PackageError(f"Cannot read JSON: {path}") from error
    if not isinstance(value, dict):
        raise PackageError(f"Expected a JSON object: {path}")
    return value


def chrome_version(version):
    if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}", version):
        raise PackageError("The extension version must contain one to four Chromium-compatible integer components.")
    parts = [int(part) for part in version.split(".")]
    if any(part > 65535 for part in parts) or not any(parts):
        raise PackageError("Chromium version components must be 0..65535 and cannot all be zero.")
    return version


def release_identity(extension_root):
    root = Path(git(extension_root, "rev-parse", "--show-toplevel")).resolve()
    if extension_root.resolve() != root / "extensions" / "web-clipper":
        raise PackageError("The extension must be packaged from the Memos monorepo.")
    if git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise PackageError("Refusing to package a dirty working tree. Commit or stash source changes first.")
    git(root, "ls-files", "--error-unmatch", "package.json", "extensions/web-clipper/package.json", "extensions/web-clipper/release/package.json", "LICENSE")
    version = chrome_version(read_json(extension_root / "release/package.json").get("version"))
    commit = git(root, "rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        raise PackageError("Git HEAD must resolve to a complete commit hash.")
    upstream_version = read_json(extension_root / "package.json").get("version")
    if not isinstance(upstream_version, str) or not upstream_version:
        raise PackageError("The extension package must declare its upstream base version.")
    return {"version": version, "tag": f"web-clipper-v{version}", "commit": commit, "upstreamVersion": upstream_version}


def collect_files(dist):
    if not dist.is_dir() or is_link(dist):
        raise PackageError("dist/ must be a real directory; run `pnpm build` first.")
    files = {}
    names = set()
    for directory, directories, filenames in os.walk(dist, followlinks=False):
        for name in directories + filenames:
            path = Path(directory) / name
            relative = path.relative_to(dist).as_posix()
            normalized = relative.casefold()
            if is_link(path):
                raise PackageError(f"Symlinks and junctions cannot be packaged: {relative}")
            if name.startswith(".") or name != name.rstrip(". ") or "\\" in name or ":" in name or normalized in names:
                raise PackageError(f"Hidden, ambiguous, or duplicate archive path: {relative}")
            names.add(normalized)
            if path.is_dir():
                continue
            if not path.is_file() or path.suffix.lower() not in RUNTIME_SUFFIXES or SECRET_NAME.search(name):
                raise PackageError(f"Unexpected non-runtime or sensitive file: {relative}")
            if path.suffix.lower() == ".json" and relative != "manifest.json" and not re.fullmatch(r"_locales/[^/]+/messages\.json", relative):
                raise PackageError(f"Unexpected runtime JSON file: {relative}")
            data = path.read_bytes()
            if path.suffix.lower() in TEXT_SUFFIXES:
                try:
                    text = data.decode("utf-8")
                except UnicodeError as error:
                    raise PackageError(f"Runtime text is not UTF-8: {relative}") from error
                if any(marker in text for marker in DEVELOPMENT_MARKERS):
                    raise PackageError(f"Development build or source map reference found: {relative}")
                if re.search(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----", text):
                    raise PackageError(f"Private key found in runtime file: {relative}")
            files[relative] = data
    if "manifest.json" not in files:
        raise PackageError("dist/manifest.json is missing; run `pnpm build` first.")
    return files


def is_link(path):
    # Windows junctions are reparse points, including on Python versions before Path.is_junction.
    attributes = getattr(path.lstat(), "st_file_attributes", 0)
    return path.is_symlink() or bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def require_resource(path, files, *, relative_to=None, pattern=False):
    if not isinstance(path, str) or not path or "\\" in path or ":" in path or path.startswith("//"):
        raise PackageError(f"Invalid packaged resource path: {path!r}")
    value = path.removeprefix("/")
    if any(part in ("", "..") for part in value.split("/")):
        raise PackageError(f"Unsafe packaged resource path: {path!r}")
    if relative_to and not path.startswith("/"):
        value = (PurePosixPath(relative_to).parent / value).as_posix()
    value = str(PurePosixPath(value))
    matches = [name for name in files if fnmatch.fnmatchcase(name, value)] if pattern else [value]
    if not matches or any(name not in files or not files[name] for name in matches):
        raise PackageError(f"Missing or empty packaged resource: {path}")


class ResourceParser(HTMLParser):
    def __init__(self, path, files):
        super().__init__()
        self.path = path
        self.files = files

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        resource = attributes.get("src") if tag == "script" else None
        if tag == "link" and attributes.get("rel") in ("stylesheet", "modulepreload", "icon"):
            resource = attributes.get("href")
        if resource:
            require_resource(resource, self.files, relative_to=self.path)


def validate_manifest(files, identity):
    try:
        manifest = json.loads(files["manifest.json"])
    except (UnicodeError, ValueError) as error:
        raise PackageError("The built manifest is not valid JSON.") from error
    if not isinstance(manifest, dict) or manifest.get("manifest_version") != 3:
        raise PackageError("The release requires a Manifest V3 Chromium build.")
    if manifest.get("version") != identity["version"]:
        raise PackageError("Built manifest version does not match the extension release package; rebuild dist/.")
    try:
        key = base64.b64decode(manifest.get("key", ""), validate=True)
        digest = hashlib.sha256(key).hexdigest()[:32]
        extension_id = "".join(chr(ord("a") + int(char, 16)) for char in digest)
    except (TypeError, ValueError, binascii.Error) as error:
        raise PackageError("The built manifest must preserve the official Chromium public key.") from error
    if extension_id != OFFICIAL_EXTENSION_ID:
        raise PackageError("The built manifest must preserve the official Chromium public key.")
    background = manifest.get("background", {})
    action = manifest.get("action", {})
    options = manifest.get("options_ui", {})
    if not all(isinstance(value, dict) for value in (background, action, options)):
        raise PackageError("The built manifest has invalid background, action, or options definitions.")
    require_resource(background.get("service_worker"), files)
    # The trusted editor entry remains packaged even though the action now opens a tab.
    require_resource(action.get("default_popup", "src/popup/index.html"), files)
    require_resource(options.get("page"), files)
    for icons in (manifest.get("icons", {}), action.get("default_icon", {})):
        if not isinstance(icons, (str, dict)):
            raise PackageError("The built manifest has invalid icon definitions.")
        for path in ([icons] if isinstance(icons, str) else icons.values()):
            require_resource(path, files)
    locale = manifest.get("default_locale")
    if not isinstance(locale, str) or not re.fullmatch(r"[A-Za-z_]+", locale):
        raise PackageError("The built manifest must declare a valid default locale.")
    require_resource(f"_locales/{locale}/messages.json", files)
    for entry in manifest_entries(manifest, "content_scripts"):
        for path in resource_list(entry, "js") + resource_list(entry, "css"):
            require_resource(path, files)
    for entry in manifest_entries(manifest, "web_accessible_resources"):
        for path in resource_list(entry, "resources"):
            require_resource(path, files, pattern=True)
    for path, data in files.items():
        if path.endswith(".html"):
            ResourceParser(path, files).feed(data.decode("utf-8"))
        elif path.endswith(".js"):
            # Check emitted static imports and string-literal dynamic imports, including the worker loader.
            for dependency in re.findall(r"(?:\bfrom\s*|\bimport\s*\(?\s*)[\"']([^\"']+)[\"']", data.decode("utf-8")):
                if dependency.startswith((".", "/")):
                    require_resource(dependency, files, relative_to=path)
    manifest.pop("update_url", None)
    manifest["name"] = "Memos Web Clipper - Castor"
    manifest["version"] = identity["version"]
    manifest["version_name"] = f"{identity['version']} Castor (upstream {identity['upstreamVersion']})"
    return manifest


def manifest_entries(manifest, field):
    entries = manifest.get(field, [])
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise PackageError(f"The built manifest has invalid {field} definitions.")
    return entries


def resource_list(entry, field):
    resources = entry.get(field, [])
    if not isinstance(resources, list):
        raise PackageError(f"The built manifest has an invalid {field} resource list.")
    return resources


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def package_release(extension_root, output):
    extension_root = Path(extension_root).resolve()
    identity = release_identity(extension_root)
    files = collect_files(extension_root / "dist")
    files["manifest.json"] = json_bytes(validate_manifest(files, identity))
    files["castor-release.json"] = json_bytes(identity)
    # Read the tracked license bytes to avoid checkout line endings changing the archive.
    files["LICENSE"] = subprocess.check_output(["git", "show", "HEAD:LICENSE"], cwd=extension_root.parents[1])
    output = Path(output).resolve()
    if output == extension_root / "dist" or extension_root / "dist" in output.parents:
        raise PackageError("Release output cannot be inside dist/.")
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"memos-web-clipper-chromium-v{identity['version']}.zip"
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output, suffix=".zip", delete=False) as handle:
            temporary = Path(handle.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(files.items()):
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, data, compresslevel=9)
        temporary.replace(destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=EXTENSION_ROOT / "artifacts", help="Output directory, relative to the current directory when supplied.")
    arguments = parser.parse_args()
    try:
        print(package_release(EXTENSION_ROOT, arguments.output))
    except (PackageError, OSError) as error:
        print(f"Cannot package web clipper: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
