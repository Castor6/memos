"""Explicit image publication channel shared by release and transfer tooling."""
import os
import re


def channel(value=None):
    selected = value or os.environ.get("IMAGE_CHANNEL") or "ghcr"
    if selected not in ("ghcr", "acr"):
        raise ValueError("IMAGE_CHANNEL must be ghcr or acr")
    return selected


def required(key):
    value = os.environ.get(key, "")
    if not value:
        raise ValueError("Missing " + key)
    return value


def credentials(source, selected=None):
    selected = channel(selected)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source):
        raise ValueError("Invalid source repository")
    if selected == "ghcr":
        registry, repository = "ghcr.io", "ghcr.io/" + source.lower()
        username, password = required("GITHUB_ACTOR"), required("GH_TOKEN")
    else:
        registry, repository = required("ACR_REGISTRY"), required("ACR_IMAGE")
        username, password = required("ACR_USERNAME"), required("ACR_PASSWORD")
    if (not re.fullmatch(r"[a-z0-9.-]+", registry)
            or not re.fullmatch(re.escape(registry) + r"/[a-z0-9_./-]+", repository)):
        raise ValueError("Invalid registry repository")
    return registry, repository, username, password
