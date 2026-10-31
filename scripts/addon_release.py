"""Prepare and verify source-bound add-on artifacts with python -m scripts.addon_release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from scripts.check_addon_release import IMAGE, SOURCE, _json, _read, validate_release
from scripts.package_addon import (
    _assemble,
    _open_directory,
    _output_parent,
    _write_files,
    encoded,
    git,
    verify,
)

BRIDGE = "companion/custom_components/jukelet_bridge/manifest.json"
METADATA = (
    "backend/pyproject.toml",
    "backend/uv.lock",
    "frontend/package.json",
    "frontend/package-lock.json",
)
SHA = r"[0-9a-f]{40}"


def _blob(repository: Path, commit: str, name: str) -> bytes:
    entry = git(repository, "ls-tree", "-l", commit, "--", name).decode().strip()
    metadata, path = entry.split("\t")
    mode, kind, _object, size = metadata.split()
    if path != name or mode != "100644" or kind != "blob" or not 0 <= int(size) <= 1024 * 1024:
        raise ValueError("Release metadata requires bounded regular committed files")
    return git(repository, "show", commit + ":" + name)


def _base_images(recipe: bytes) -> list[str]:
    aliases: set[str] = set()
    bases: list[str] = []
    instructions = {
        "ADD",
        "ARG",
        "CMD",
        "COPY",
        "ENTRYPOINT",
        "ENV",
        "EXPOSE",
        "FROM",
        "HEALTHCHECK",
        "LABEL",
        "MAINTAINER",
        "ONBUILD",
        "RUN",
        "SHELL",
        "STOPSIGNAL",
        "USER",
        "VOLUME",
        "WORKDIR",
    }
    continued = False
    for raw in recipe.decode("utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            if re.match(r"#\s*(?:escape|syntax)\s*=", line, re.IGNORECASE):
                raise ValueError("Unsupported Dockerfile parser directive")
            continue
        if "<<" in line:
            raise ValueError("Unsupported Dockerfile heredoc syntax")
        # Match Docker's default continuation rule; an escaped backslash is not
        # a continuation. Parser directives and continued FROM are refused, so
        # instruction fragments cannot hide an external image from this guard.
        next_continued = re.search(r"(^|[^\\])\\[ \t]*$", raw) is not None
        if continued:
            continued = next_continued
            continue
        keyword = re.match(r"([A-Za-z]+)(?:[ \t]+|$)", line)
        if keyword is None or keyword[1].upper() not in instructions:
            raise ValueError("Unsupported Dockerfile instruction spelling")
        continued = next_continued
        if keyword[1].upper() != "FROM":
            continue
        if continued:
            raise ValueError("Unsupported Dockerfile continued base-image declaration")
        parts = line.split()
        if len(parts) not in {2, 4} or (len(parts) == 4 and parts[2].upper() != "AS"):
            raise ValueError("Unsupported add-on base-image declaration")
        image = parts[1]
        if image.casefold() not in aliases:
            if re.fullmatch(r"[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}", image) is None:
                raise ValueError("Every external base image must have a pinned digest")
            if image not in bases:
                bases.append(image)
        if len(parts) == 4:
            if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", parts[3]) is None:
                raise ValueError("Unsupported Dockerfile stage alias")
            aliases.add(parts[3].casefold())
    if continued:
        raise ValueError("Unterminated Dockerfile continuation")
    if not bases:
        raise ValueError("No pinned base images were found")
    return bases


def source_plan(
    repository: Path, ref: str, release_tag: str, *, prerelease: bool
) -> tuple[dict[str, Any], dict[str, bytes], dict[str, bytes]]:
    """Resolve once, then derive all release inputs from that exact commit."""
    files, context = _assemble(repository, ref)
    commit = context["source_commit"]
    bridge = _blob(repository, commit, BRIDGE)
    with tempfile.TemporaryDirectory(prefix="jukelet-addon-release-") as temporary:
        metadata = Path(temporary)
        for name, content in {
            **{name: files[name] for name in METADATA},
            "addon/local/config.json.template": files["config.json"],
            BRIDGE: bridge,
        }.items():
            target = metadata / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        release = validate_release(metadata, release_tag, prerelease=prerelease)
    config = json.loads(files["config.json"])
    if (
        not isinstance(config.get("name"), str)
        or not 1 <= len(config["name"].strip()) <= 128
        or not isinstance(config.get("description"), str)
        or not 1 <= len(config["description"].strip()) <= 1024
        or config.get("url") != SOURCE
    ):
        raise ValueError("Invalid app repository metadata identity")
    config["image"] = IMAGE
    snapshot = {
        "repository.yaml": encoded(
            {"name": "Jukelet add-ons", "url": SOURCE, "maintainer": "Jukelet maintainers"}
        ),
        "jukelet/config.json": encoded(config),
        "jukelet/translations/en.yaml": files["translations/en.yaml"],
    }
    plan = {
        **release,
        "format_version": 1,
        "artifact": "jukelet-addon-release-plan",
        "source_commit": commit,
        "source_tree": context["source_tree"],
        "context_sha256": context["context_sha256"],
        "embedded_build_info_sha256": context["files"]["build-info.json"],
        "integration_manifest_sha256": hashlib.sha256(bridge).hexdigest(),
        "base_images": _base_images(files["Dockerfile"]),
        "repository_files": {
            name: hashlib.sha256(content).hexdigest() for name, content in sorted(snapshot.items())
        },
        "labels": {
            **release["labels"],
            "org.opencontainers.image.revision": commit,
            "io.jukelet.context.sha256": context["context_sha256"],
        },
    }
    return plan, files, snapshot


def _exclusive_directory_files(repository: Path, folder: Path, files: dict[str, bytes]) -> None:
    parent = _output_parent(repository, folder, parent_only=True)
    try:
        os.mkdir(folder.name, 0o755, dir_fd=parent)
        directory = _open_directory(parent, folder.name, create=False)
    finally:
        os.close(parent)
    try:
        _write_files(directory, files)
    finally:
        os.close(directory)


def prepare(
    repository: Path, ref: str, release_tag: str, *, prerelease: bool, output: Path
) -> dict[str, Any]:
    plan, files, snapshot = source_plan(repository, ref, release_tag, prerelease=prerelease)
    _exclusive_directory_files(
        repository,
        output,
        {
            **{"context/jukelet/" + name: content for name, content in files.items()},
            **{"repository/" + name: content for name, content in snapshot.items()},
            "plan.json": encoded(plan),
        },
    )
    return plan


def _verify_snapshot(folder: Path, expected: dict[str, bytes], prefix: str = "") -> set[str]:
    found: set[str] = set()
    for entry in folder.iterdir():
        name = prefix + entry.name
        metadata = entry.lstat()
        if stat.S_ISDIR(metadata.st_mode):
            if not any(path.startswith(name + "/") for path in expected):
                raise ValueError("Unexpected repository snapshot directory")
            found |= _verify_snapshot(entry, expected, name + "/")
        elif not stat.S_ISREG(metadata.st_mode) or name not in expected:
            raise ValueError("Unexpected nonregular repository snapshot file")
        elif _read(folder, entry.name).encode("utf-8") != expected[name]:
            raise ValueError("Repository snapshot differs from the committed release plan")
        else:
            found.add(name)
    return found


def verify_prepared(repository: Path, folder: Path, expected_source: str) -> dict[str, Any]:
    if re.fullmatch(SHA, expected_source) is None:
        raise ValueError("An independent full expected source commit is required")
    actual = _json(folder, "plan.json")
    if actual.get("source_commit") != expected_source or not isinstance(
        actual.get("prerelease"), bool
    ):
        raise ValueError("Prepared release does not match the expected source")
    tag = actual.get("release_tag")
    if not isinstance(tag, str):
        raise ValueError("Invalid prepared release tag")
    expected, _files, snapshot = source_plan(
        repository, expected_source, tag, prerelease=actual["prerelease"]
    )
    if encoded(actual) != encoded(expected):
        raise ValueError("Prepared plan differs from committed release inputs")
    children = {entry.name: entry.lstat() for entry in folder.iterdir()}
    if set(children) != {"context", "repository", "plan.json"} or any(
        not stat.S_ISDIR(children[name].st_mode) for name in ("context", "repository")
    ):
        raise ValueError("Unexpected prepared release file set")
    context_folder = folder / "context"
    if {entry.name for entry in context_folder.iterdir()} != {"jukelet"}:
        raise ValueError("Unexpected release build-context directory")
    context = verify(repository, context_folder / "jukelet")
    if (
        context["source_commit"] != expected_source
        or context["context_sha256"] != expected["context_sha256"]
    ):
        raise ValueError("Prepared build context does not match the expected source")
    if _verify_snapshot(folder / "repository", snapshot) != set(snapshot):
        raise ValueError("Repository snapshot is incomplete")
    return expected


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path.cwd())
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("prepare")
    build.add_argument("--ref", required=True)
    build.add_argument("--release-tag", required=True)
    build.add_argument("--prerelease", choices=("true", "false"), required=True)
    build.add_argument("--output", type=Path, required=True)
    check = commands.add_parser("verify-prepared")
    check.add_argument("--prepared", type=Path, required=True)
    check.add_argument("--expected-source", required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            result = prepare(
                args.repository,
                args.ref,
                args.release_tag,
                prerelease=args.prerelease == "true",
                output=args.output,
            )
        else:
            result = verify_prepared(args.repository, args.prepared, args.expected_source)
    except ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError:
        parser.error("Unable to prepare or verify the committed add-on release")
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
