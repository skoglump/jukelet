"""Validate a release from package metadata in the current repository root."""

import argparse
import json
import re
import tomllib
from pathlib import Path


def validate_release(tag: str) -> str:
    if not re.fullmatch(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
        raise ValueError("release tag must be X.Y.Z or vX.Y.Z, without a prerelease suffix")
    version = tag.removeprefix("v")
    project = tomllib.loads(Path("backend/pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads(Path("backend/uv.lock").read_text(encoding="utf-8"))
    packages = [entry for entry in lock["package"] if entry["name"] == project["project"]["name"]]
    if len(packages) != 1:
        raise ValueError("backend/uv.lock must contain exactly one application package")
    frontend = json.loads(Path("frontend/package.json").read_text(encoding="utf-8"))
    frontend_lock = json.loads(Path("frontend/package-lock.json").read_text(encoding="utf-8"))
    versions = {
        "backend/pyproject.toml": project["project"]["version"],
        "backend/uv.lock": packages[0]["version"],
        "frontend/package.json": frontend["version"],
        "frontend/package-lock.json": frontend_lock["version"],
        'frontend/package-lock.json packages[""]': frontend_lock["packages"][""]["version"],
    }
    for source, actual in versions.items():
        if actual != version:
            raise ValueError(f"{source} version does not match the release tag")
    return version


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="Stable release tag, with an optional leading v")
    args = parser.parse_args()
    try:
        version = validate_release(args.tag)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    except KeyError, TypeError:
        parser.error("invalid package metadata structure")
    print(version)


if __name__ == "__main__":
    main()
