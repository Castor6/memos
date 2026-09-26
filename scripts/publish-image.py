#!/usr/bin/env python3
"""Publish a smoke-tested personal release; advance stable only after validation."""

import json
import os
from pathlib import Path
import re
import subprocess
import time

from registry_channel import credentials


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def output(*args):
    return run(*args, capture_output=True).stdout.strip()


def version_tuple(value):
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value):
        raise ValueError("Invalid release version")
    return tuple(map(int, value.split(".")))


def exists(image):
    result = subprocess.run(["docker", "manifest", "inspect", image], capture_output=True, text=True, timeout=90)
    if result.returncode == 0:
        return True
    # Authentication and network errors must never be interpreted as an absent tag.
    if re.search(r"manifest unknown|no such manifest", result.stderr, re.I):
        return False
    raise RuntimeError("Cannot establish registry tag state: " + result.stderr.strip())


def inspect(image):
    return json.loads(output("docker", "image", "inspect", image))[0]


def push(image):
    for attempt in range(3):
        try:
            run("docker", "push", image, timeout=600)
            return
        except (subprocess.SubprocessError, OSError):
            if attempt == 2:
                raise
            time.sleep(5)


def publish():
    registry, repo, username, password = credentials("Castor6/memos")
    commit = os.environ["RELEASE_COMMIT"]
    version = json.loads(Path("package.json").read_text())["version"]
    version_tuple(version)
    if version == "0.0.0" or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Invalid release identity")
    if not re.fullmatch(r"[a-z0-9.-]+", registry) or not re.fullmatch(re.escape(registry) + r"/[a-z0-9_./-]+", repo):
        raise ValueError("Invalid registry configuration")
    if output("git", "rev-parse", "HEAD") != commit:
        raise RuntimeError("Checkout does not match the approved merge commit")
    version_image = repo + ":castor-v" + version
    stable_image = repo + ":stable"
    source = "https://github.com/Castor6/memos"
    run("docker", "login", registry, "--username", username, "--password-stdin", input=password + "\n")
    password = ""
    try:
        if exists(stable_image):
            run("docker", "pull", stable_image)
            stable = inspect(stable_image)["Config"].get("Labels") or {}
            if stable.get("org.opencontainers.image.source") != source:
                raise RuntimeError("Unexpected stable image source")
            stable_version = stable.get("org.opencontainers.image.version", "")
            if version_tuple(stable_version) > version_tuple(version):
                raise RuntimeError("Refusing to move stable backwards")
            if stable_version == version and stable.get("org.opencontainers.image.revision") != commit:
                raise RuntimeError("Stable version already belongs to another commit")
        present = exists(version_image)
        if present:
            run("docker", "pull", version_image)
            labels = inspect(version_image)["Config"].get("Labels") or {}
            if any(labels.get("org.opencontainers.image." + key) != value for key, value in
                   (("source", source), ("version", version), ("revision", commit))):
                raise RuntimeError("Version tag already belongs to another release")
        else:
            run("docker", "build", "--platform", "linux/amd64", "-f", "scripts/Dockerfile",
                "--build-arg", "VERSION=" + version, "--build-arg", "COMMIT=" + commit,
                "--label", "org.opencontainers.image.source=" + source,
                "--label", "org.opencontainers.image.version=" + version,
                "--label", "org.opencontainers.image.revision=" + commit, "-t", version_image, ".")
        previous = json.loads(output("git", "show", "HEAD^:package.json"))["version"]
        version_tuple(previous)
        previous_image = "ghcr.io/usememos/memos:0.30.0" if previous == "0.0.0" else repo + ":castor-v" + previous
        run("bash", "scripts/release_smoke_test.sh", "--candidate-image", version_image, "--previous-image", previous_image)
        if not present:
            push(version_image)
        run("docker", "pull", version_image)
        digest = [item for item in inspect(version_image).get("RepoDigests", []) if item.startswith(repo + "@sha256:")]
        if len(digest) != 1:
            raise RuntimeError("Expected one published digest")
        run("docker", "tag", digest[0], repo + ":sha-" + commit)
        push(repo + ":sha-" + commit)
        # This is the only write to the deployment channel, after all tests pass.
        run("docker", "tag", digest[0], stable_image)
        push(stable_image)
        Path("build/candidate").mkdir(parents=True, exist_ok=True)
        Path("build/candidate/image.json").write_text(json.dumps({"image": digest[0], "version": version, "commit": commit}, indent=2) + "\n")
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(f"Published tested release {version}: `{digest[0]}`\n")
    finally:
        run("docker", "logout", registry)


if __name__ == "__main__":
    publish()
