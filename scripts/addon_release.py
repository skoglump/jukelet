"""Prepare and verify source-bound add-on artifacts with python -m scripts.addon_release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
import tarfile
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from scripts.addon_image import inspect_archive, read_metadata, registry_observation
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


def _docker_instructions(recipe: bytes) -> Iterator[str]:
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
    pending = ""
    continuation = re.compile(r"(^|[^\\])\\[ \t]*$")
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
        continued = continuation.search(raw) is not None
        if not pending:
            keyword = re.match(r"([A-Za-z]+)(?:[ \t]+|$)", line)
            if keyword is None or keyword[1].upper() not in instructions:
                raise ValueError("Unsupported Dockerfile instruction spelling")
            if keyword[1].upper() == "FROM" and continued:
                raise ValueError("Unsupported Dockerfile continued base-image declaration")
        # Preserve continuation-line whitespace as Docker does. This also joins
        # split flag names before checking selectors, without reading shell data
        # as a second Docker instruction.
        fragment = continuation.sub(r"\1", raw) if continued else raw
        pending = pending + fragment if pending else fragment.lstrip()
        if continued:
            continue
        yield pending
        pending = ""
    if pending:
        raise ValueError("Unterminated Dockerfile continuation")


def _leading_docker_flags(line: str) -> list[str]:
    parts = line.split(None, 1)
    if len(parts) != 2:
        return []
    lexer = shlex.shlex(parts[1], posix=True)
    lexer.whitespace_split = True
    lexer.commenters = ""
    flags: list[str] = []
    while (token := lexer.get_token()) is not None:
        if not token.startswith("--"):
            break
        flags.append(token)
    return flags


def _base_images(recipe: bytes) -> list[str]:
    aliases: set[str] = set()
    current_alias: str | None = None
    bases: list[str] = []
    for line in _docker_instructions(recipe):
        parts = line.split()
        instruction = parts[0].upper()
        if instruction == "ONBUILD":
            raise ValueError("Unsupported nested Dockerfile image-selector instruction")
        if instruction in {"COPY", "RUN"}:
            flags = _leading_docker_flags(line)
            if instruction == "RUN" and flags:
                raise ValueError("Unsupported Dockerfile RUN image-selector or instruction flags")
            if instruction == "COPY" and flags:
                if len(flags) != 1 or not flags[0].startswith("--from="):
                    raise ValueError("Unsupported Dockerfile COPY image-selector flags")
                selected = flags[0].removeprefix("--from=").casefold()
                if selected not in aliases or selected == current_alias:
                    raise ValueError("Dockerfile COPY image-selector must name a prior stage")
        if instruction != "FROM":
            continue
        if len(parts) not in {2, 4} or (len(parts) == 4 and parts[2].upper() != "AS"):
            raise ValueError("Unsupported add-on base-image declaration")
        image = parts[1]
        if image.casefold() not in aliases:
            if re.fullmatch(r"[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}", image) is None:
                raise ValueError("Every external base image must have a pinned digest")
            if image not in bases:
                bases.append(image)
        current_alias = None
        if len(parts) == 4:
            if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", parts[3]) is None:
                raise ValueError("Unsupported Dockerfile stage alias")
            current_alias = parts[3].casefold()
            aliases.add(current_alias)
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


def _write_json(repository: Path, output: Path, value: dict[str, Any]) -> None:
    parent = _output_parent(repository, output, parent_only=True)
    try:
        descriptor = os.open(
            output.name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o644,
            dir_fd=parent,
        )
    finally:
        os.close(parent)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(encoded(value))


def archive_artifact(
    repository: Path, prepared: Path, expected_source: str, archive: Path
) -> dict[str, Any]:
    plan = verify_prepared(repository, prepared, expected_source)
    observed = inspect_archive(archive, plan)
    return {
        "format_version": 1,
        "artifact": "jukelet-addon-image-archive",
        "source_commit": plan["source_commit"],
        "source_tree": plan["source_tree"],
        "context_sha256": plan["context_sha256"],
        "addon_version": plan["addon_version"],
        "app_version": plan["app_version"],
        "integration_source_version": plan["integration_source_version"],
        "image_reference": plan["image_reference"],
        "plan_sha256": hashlib.sha256(encoded(plan)).hexdigest(),
        **observed,
    }


def seal_archive(
    repository: Path, prepared: Path, expected_source: str, archive: Path, output: Path
) -> dict[str, Any]:
    artifact = archive_artifact(repository, prepared, expected_source, archive)
    _write_json(repository, output, artifact)
    return artifact


def verify_archive(
    repository: Path,
    prepared: Path,
    expected_source: str,
    archive: Path,
    artifact: Path,
    *,
    expected_archive_sha256: str,
) -> dict[str, Any]:
    if re.fullmatch(r"[0-9a-f]{64}", expected_archive_sha256) is None:
        raise ValueError("An independently expected archive SHA-256 is required")
    actual = _json(artifact.parent, artifact.name)
    expected = archive_artifact(repository, prepared, expected_source, archive)
    if expected["archive_sha256"] != expected_archive_sha256:
        raise ValueError("Saved bytes do not match the independently expected archive SHA-256")
    if encoded(actual) != encoded(expected):
        raise ValueError("Saved archive does not match its independently expected artifact")
    return expected


def record_registry_receipt(
    repository: Path,
    prepared: Path,
    expected_source: str,
    archive: Path,
    artifact: Path,
    manifest: Path,
    manifest_digest: str,
    output: Path,
    *,
    expected_archive_sha256: str,
    fixture_image: str | None = None,
    index: Path | None = None,
    index_digest: str | None = None,
) -> dict[str, Any]:
    sealed = verify_archive(
        repository,
        prepared,
        expected_source,
        archive,
        artifact,
        expected_archive_sha256=expected_archive_sha256,
    )
    receipt = {
        "format_version": 1,
        "artifact": "jukelet-addon-registry-observation",
        **registry_observation(
            sealed,
            read_metadata(manifest),
            manifest_digest,
            observed_image=fixture_image or sealed["image_reference"],
            fixture=fixture_image is not None,
            index_bytes=read_metadata(index) if index is not None else None,
            index_digest=index_digest,
        ),
    }
    _write_json(repository, output, receipt)
    return receipt


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
    for command in ("seal", "verify-archive", "receipt"):
        action = commands.add_parser(command)
        action.add_argument("--prepared", type=Path, required=True)
        action.add_argument("--expected-source", required=True)
        action.add_argument("--archive", type=Path, required=True)
        if command != "seal":
            action.add_argument("--artifact", type=Path, required=True)
            action.add_argument("--expected-archive-sha256", required=True)
        if command != "verify-archive":
            action.add_argument("--output", type=Path, required=True)
        if command == "receipt":
            action.add_argument("--manifest", type=Path, required=True)
            action.add_argument("--manifest-digest", required=True)
            action.add_argument("--index", type=Path)
            action.add_argument("--index-digest")
            action.add_argument("--fixture-image")
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
        elif args.command == "verify-prepared":
            result = verify_prepared(args.repository, args.prepared, args.expected_source)
        elif args.command == "seal":
            result = seal_archive(
                args.repository, args.prepared, args.expected_source, args.archive, args.output
            )
        elif args.command == "verify-archive":
            result = verify_archive(
                args.repository,
                args.prepared,
                args.expected_source,
                args.archive,
                args.artifact,
                expected_archive_sha256=args.expected_archive_sha256,
            )
        else:
            result = record_registry_receipt(
                args.repository,
                args.prepared,
                args.expected_source,
                args.archive,
                args.artifact,
                args.manifest,
                args.manifest_digest,
                args.output,
                expected_archive_sha256=args.expected_archive_sha256,
                fixture_image=args.fixture_image,
                index=args.index,
                index_digest=args.index_digest,
            )
    except (
        ValueError,
        OSError,
        KeyError,
        TypeError,
        EOFError,
        tarfile.TarError,
        subprocess.CalledProcessError,
    ):
        parser.error("Unable to prepare or verify the committed add-on release")
    print(json.dumps(result, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
