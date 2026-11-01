"""Validate the separate add-on release lane without building or publishing."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import tomllib
from pathlib import Path
from typing import Any, TypedDict

IMAGE = "ghcr.io/skoglump/jukelet-addon"
SOURCE = "https://github.com/skoglump/jukelet"
NUMBER = r"(?:0|[1-9][0-9]*)"
STABLE = rf"{NUMBER}\.{NUMBER}\.{NUMBER}"
CANDIDATE = r"0\.1\.0-addon\.[1-9][0-9]*"
MAX_METADATA_BYTES = 1024 * 1024


class ReleasePlan(TypedDict):
    addon_version: str
    app_version: str
    integration_source_version: str
    release_tag: str
    prerelease: bool
    image: str
    image_reference: str
    architectures: list[str]
    platforms: list[str]
    labels: dict[str, str]


def _read(repository: Path, name: str) -> str:
    parts = name.split("/")
    directory = os.open(repository, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
    finally:
        os.close(directory)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_METADATA_BYTES:
            raise ValueError("Release metadata must be bounded regular files")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            contents = stream.read(MAX_METADATA_BYTES + 1)
        if len(contents) > MAX_METADATA_BYTES:
            raise ValueError("Release metadata is too large")
        return contents.decode("utf-8")
    finally:
        os.close(descriptor)


def _object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"Invalid {name} metadata structure")
    return value


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate metadata key")
        value[key] = item
    return value


def _reject_constant(_value: str) -> None:
    raise ValueError("Non-finite values are not valid JSON metadata")


def _json(repository: Path, name: str) -> dict[str, Any]:
    try:
        return _object(
            json.loads(
                _read(repository, name),
                object_pairs_hook=_unique_object,
                parse_constant=_reject_constant,
            ),
            name,
        )
    except UnicodeError, ValueError:
        raise ValueError(f"Invalid {name} metadata") from None


def _toml(repository: Path, name: str) -> dict[str, Any]:
    try:
        return tomllib.loads(_read(repository, name))
    except UnicodeError, ValueError:
        raise ValueError(f"Invalid {name} metadata") from None


def _application_version(repository: Path) -> str:
    frontend = _json(repository, "frontend/package.json")
    version = frontend.get("version")
    if not isinstance(version, str):
        raise ValueError("Invalid frontend/package.json application version")
    match = re.fullmatch(rf"(?P<base>{STABLE})(?:-rc\.(?P<rc>{NUMBER}))?", version)
    if match is None:
        raise ValueError("Invalid frontend/package.json application version")
    python_version = f"{match['base']}rc{match['rc']}" if match["rc"] is not None else version
    project = _object(_toml(repository, "backend/pyproject.toml").get("project"), "project")
    lock = _toml(repository, "backend/uv.lock")
    packages = lock.get("package")
    if project.get("name") != "jukelet" or not isinstance(packages, list):
        raise ValueError("Invalid backend application identity")
    matching = [
        _object(entry, "backend/uv.lock")
        for entry in packages
        if _object(entry, "backend/uv.lock").get("name") == "jukelet"
    ]
    if len(matching) != 1:
        raise ValueError("backend/uv.lock must contain exactly one application package")
    frontend_lock = _json(repository, "frontend/package-lock.json")
    root_package = _object(
        _object(frontend_lock.get("packages"), "frontend/package-lock.json").get(""),
        "frontend/package-lock.json",
    )
    for name, actual, expected in (
        ("backend/pyproject.toml", project.get("version"), python_version),
        ("backend/uv.lock", matching[0].get("version"), python_version),
        ("frontend/package-lock.json", frontend_lock.get("version"), version),
        ('frontend/package-lock.json packages[""]', root_package.get("version"), version),
    ):
        if actual != expected:
            raise ValueError(f"{name} does not match the shared application version")
    return version


def validate_release(repository: Path, tag: str, *, prerelease: bool) -> ReleasePlan:
    match = re.fullmatch(rf"addon-v(?P<version>(?P<candidate>{CANDIDATE})|{STABLE})", tag)
    if match is None:
        raise ValueError("Add-on release tag must be addon-v0.1.0-addon.N or addon-vX.Y.Z")
    version = match["version"]
    if len(version) > 128:
        raise ValueError("Add-on packaging version exceeds the Docker tag limit of 128 characters")
    if prerelease != (match["candidate"] is not None):
        raise ValueError("GitHub prerelease flag must match the add-on candidate/stable channel")
    config = _json(repository, "addon/local/config.json.template")
    if config.get("version") != version:
        raise ValueError("Add-on packaging version does not match the release tag")
    if config.get("slug") != "jukelet" or config.get("image", IMAGE) != IMAGE:
        raise ValueError("Add-on image and slug must use the accepted Jukelet namespace")
    if config.get("arch") != ["amd64"]:
        raise ValueError("Only the tested amd64 architecture may be declared")
    application = _application_version(repository)
    bridge = _json(repository, "companion/custom_components/jukelet_bridge/manifest.json")
    integration = bridge.get("version")
    if (
        bridge.get("domain") != "jukelet_bridge"
        or not isinstance(integration, str)
        or re.fullmatch(STABLE, integration) is None
    ):
        raise ValueError("Invalid independently versioned integration source metadata")
    return {
        "addon_version": version,
        "app_version": application,
        "integration_source_version": integration,
        "release_tag": tag,
        "prerelease": prerelease,
        "image": IMAGE,
        "image_reference": f"{IMAGE}:{version}",
        "architectures": ["amd64"],
        "platforms": ["linux/amd64"],
        "labels": {
            "io.hass.version": version,
            "io.hass.arch": "amd64",
            "io.hass.type": "app",
            "org.opencontainers.image.source": SOURCE,
            "org.opencontainers.image.version": version,
            "io.jukelet.application.version": application,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--prerelease", choices=("true", "false"), required=True)
    args = parser.parse_args()
    try:
        result = validate_release(Path.cwd(), args.tag, prerelease=args.prerelease == "true")
    except ValueError as error:
        parser.error(str(error))
    except OSError, KeyError, TypeError:
        parser.error("Unable to validate regular add-on release metadata")
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
