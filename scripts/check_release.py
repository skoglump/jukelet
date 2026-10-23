"""Validate a release from package metadata in the current repository root."""

import argparse
import json
import re
import tomllib
from pathlib import Path


def validate_release(tag: str, *, prerelease: bool = False) -> str:
    number = r"(?:0|[1-9][0-9]*)"
    match = re.fullmatch(
        rf"v?(?P<base>{number}\.{number}\.{number})(?:-rc\.(?P<rc>{number}))?", tag
    )
    if match is None:
        raise ValueError("release tag must be X.Y.Z or X.Y.Z-rc.N, with an optional leading v")
    candidate = match["rc"] is not None
    if prerelease != candidate:
        raise ValueError(
            "GitHub prerelease flag must be true for RC tags and false for stable tags"
        )
    version = tag.removeprefix("v")
    python_version = f"{match['base']}rc{match['rc']}" if candidate else version
    project = tomllib.loads(Path("backend/pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads(Path("backend/uv.lock").read_text(encoding="utf-8"))
    packages = [entry for entry in lock["package"] if entry["name"] == project["project"]["name"]]
    if len(packages) != 1:
        raise ValueError("backend/uv.lock must contain exactly one application package")
    frontend = json.loads(Path("frontend/package.json").read_text(encoding="utf-8"))
    frontend_lock = json.loads(Path("frontend/package-lock.json").read_text(encoding="utf-8"))
    versions = {
        "backend/pyproject.toml": (project["project"]["version"], python_version),
        "backend/uv.lock": (packages[0]["version"], python_version),
        "frontend/package.json": (frontend["version"], version),
        "frontend/package-lock.json": (frontend_lock["version"], version),
        'frontend/package-lock.json packages[""]': (
            frontend_lock["packages"][""]["version"],
            version,
        ),
    }
    for source, (actual, expected) in versions.items():
        if actual != expected:
            raise ValueError(f"{source} version does not match the release tag")
    return version


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="Stable or numbered RC release tag, with an optional leading v")
    parser.add_argument(
        "--prerelease",
        choices=("true", "false"),
        default="false",
        help="GitHub release prerelease flag (default: false)",
    )
    args = parser.parse_args()
    try:
        version = validate_release(args.tag, prerelease=args.prerelease == "true")
    except (OSError, ValueError) as error:
        parser.error(str(error))
    except KeyError, TypeError:
        parser.error("invalid package metadata structure")
    print(version)


if __name__ == "__main__":
    main()
