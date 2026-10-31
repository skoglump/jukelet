"""Prepare a local Supervisor build folder from committed Git objects only."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

SOURCE = "addon/local/"
CONTROL_FILES = (
    "context-files.txt",
    "config.json.template",
    "Dockerfile.addon",
    "translations/en.yaml",
)
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_CONTEXT_BYTES = 16 * 1024 * 1024
ROOT_FILES = {
    ".dockerignore",
    "Dockerfile",
    "LICENSE",
    "backend/LICENSE",
    "backend/pyproject.toml",
    "backend/uv.lock",
    "frontend/package.json",
    "frontend/package-lock.json",
    "frontend/index.html",
    "frontend/tsconfig.json",
    "frontend/vite.config.ts",
    "frontend/eslint.config.js",
    "frontend/playwright.config.ts",
    "frontend/playwright.fixture.config.ts",
    "frontend/playwright.ingress.config.ts",
}


def _safe_context_path(name: str) -> bool:
    if name in ROOT_FILES:
        return True
    path = PurePosixPath(name)
    return (
        bool(re.fullmatch(r"[A-Za-z0-9_./-]+", name))
        and str(path) == name
        and all(part not in {".", ".."} and not part.startswith(".") for part in path.parts)
        and (
            (name.startswith("backend/src/jukelet/") and path.suffix == ".py")
            or (
                name.startswith(("frontend/src/", "frontend/e2e/", "frontend/fixtures/"))
                and path.suffix in {".ts", ".tsx", ".css"}
            )
            or (name.startswith("frontend/public/") and path.suffix in {".svg", ".txt"})
        )
    )


def git(repository: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repository), *args], stderr=subprocess.PIPE)


def encoded(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _assemble(repository: Path, ref: str) -> tuple[dict[str, bytes], dict[str, Any]]:
    commit = (
        git(repository, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}")
        .decode()
        .strip()
    )
    entries: dict[str, tuple[str, str, int]] = {}
    for entry in git(repository, "ls-tree", "-rlz", commit).split(b"\0"):
        if not entry:
            continue
        metadata, path = entry.decode().split("\t")
        mode, kind, _identity, size = metadata.split()
        entries[path] = (mode, kind, int(size) if size != "-" else -1)
    inputs: dict[str, bytes] = {}

    def read(name: str) -> bytes:
        mode, kind, size = entries.get(name, ("", "", -1))
        if mode != "100644" or kind != "blob" or not 0 <= size <= MAX_FILE_BYTES:
            raise ValueError("Local package requires bounded regular committed files")
        contents = git(repository, "show", commit + ":" + name)
        inputs[name] = contents
        if sum(len(value) for value in inputs.values()) > MAX_CONTEXT_BYTES:
            raise ValueError("Local package context is too large")
        return contents

    controls = {name: read(SOURCE + name) for name in CONTROL_FILES}
    names = controls["context-files.txt"].decode("ascii").splitlines()
    if not names or len(names) > 256 or len(set(names)) != len(names):
        raise ValueError("Invalid local package context allowlist")
    if any(not _safe_context_path(name) for name in names):
        raise ValueError("Unsafe local package context path")
    if set(names) != {
        name for name in entries if _safe_context_path(name)
    } or not ROOT_FILES <= set(names):
        raise ValueError("Committed build sources differ from the reviewed context allowlist")
    files = {name: read(name) for name in names}
    config = json.loads(controls["config.json.template"])
    version = config.get("version") if isinstance(config, dict) else None
    number = r"(?:0|[1-9][0-9]*)"
    versions = rf"0\.1\.0-addon\.[1-9][0-9]*|{number}\.{number}\.{number}"
    if not isinstance(version, str) or len(version) > 128 or not re.fullmatch(versions, version):
        raise ValueError("Add-on version must use 0.1.0-addon.N or X.Y.Z")
    if config.get("slug") != "jukelet":
        raise ValueError("Local add-on slug must be jukelet")
    files["Dockerfile"] += b"\n" + controls["Dockerfile.addon"]
    files["config.json"] = controls["config.json.template"]
    files["translations/en.yaml"] = controls["translations/en.yaml"]
    identity = {
        "format_version": 1,
        "artifact": "jukelet-local-addon",
        "addon_version": version,
        "source_commit": commit,
        "source_tree": git(repository, "rev-parse", commit + "^{tree}").decode().strip(),
        "source_files": {name: digest(contents) for name, contents in sorted(inputs.items())},
    }
    hashes = {name: digest(contents) for name, contents in sorted(files.items())}
    files["build-info.json"] = encoded(
        {
            **identity,
            "payload_files": hashes,
            "payload_sha256": digest(encoded(hashes)),
        }
    )
    hashes = {name: digest(contents) for name, contents in sorted(files.items())}
    info = {**identity, "files": hashes, "context_sha256": digest(encoded(hashes))}
    return files, info


def _open_directory(parent: int, name: str, *, create: bool) -> int:
    if create:
        try:
            os.mkdir(name, 0o755, dir_fd=parent)
        except FileExistsError:
            pass
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)


def _output_parent(repository: Path, output: Path, *, parent_only: bool = False) -> int:
    path = output.absolute()
    source = repository.resolve()
    if (
        ".." in output.parts
        or path == source
        or path in source.parents
        or (path.is_relative_to(source) and path.relative_to(source).parts[0] != "dist")
    ):
        raise ValueError("Unsafe local package destination")
    descriptor = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        parts = path.parent.parts if parent_only else path.parts
        for part in parts[1:]:
            child = _open_directory(descriptor, part, create=True)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _write_files(directory: int, files: dict[str, bytes]) -> None:
    for name, content in sorted(files.items()):
        descriptor = os.dup(directory)
        try:
            path = PurePosixPath(name)
            for part in path.parts[:-1]:
                child = _open_directory(descriptor, part, create=True)
                os.close(descriptor)
                descriptor = child
            target = os.open(
                path.name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o644,
                dir_fd=descriptor,
            )
            with os.fdopen(target, "wb") as stream:
                stream.write(content)
        finally:
            os.close(descriptor)


def build(repository: Path, ref: str, output: Path) -> dict[str, Any]:
    files, info = _assemble(repository, ref)
    try:
        parent = _output_parent(repository, output)
        try:
            os.mkdir("jukelet", 0o755, dir_fd=parent)
            destination = _open_directory(parent, "jukelet", create=False)
        finally:
            os.close(parent)
        try:
            _write_files(destination, files)
        finally:
            os.close(destination)
    except OSError:
        raise ValueError("Unable to create exclusive local package destination") from None
    return info


def verify(repository: Path, folder: Path) -> dict[str, Any]:
    def read(directory: int, name: str) -> bytes:
        descriptor = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory
        )
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_FILE_BYTES:
                raise ValueError("Local bundle requires bounded regular files")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                contents = stream.read(MAX_FILE_BYTES + 1)
            if len(contents) > MAX_FILE_BYTES:
                raise ValueError("Local bundle file is too large")
            return contents
        finally:
            os.close(descriptor)

    def compare(directory: int, prefix: str, expected: dict[str, bytes]) -> set[str]:
        names: set[str] = set()
        for name in os.listdir(directory):
            path = prefix + name
            metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISDIR(metadata.st_mode):
                if not any(key.startswith(path + "/") for key in expected):
                    raise ValueError("Unexpected local bundle directory")
                child = _open_directory(directory, name, create=False)
                try:
                    names |= compare(child, path + "/", expected)
                finally:
                    os.close(child)
            elif path not in expected or read(directory, name) != expected[path]:
                raise ValueError("Local bundle file set or bytes differ from committed source")
            else:
                names.add(path)
        return names

    try:
        directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            identity = json.loads(read(directory, "build-info.json"))
            if not isinstance(identity, dict) or not isinstance(identity.get("source_commit"), str):
                raise ValueError("Invalid local bundle identity")
            files, info = _assemble(repository, identity["source_commit"])
            if compare(directory, "", files) != set(files):
                raise ValueError("Local bundle is missing committed source files")
            return info
        finally:
            os.close(directory)
    except OSError, subprocess.CalledProcessError:
        raise ValueError("Unable to verify regular local bundle files") from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD", help="committed source; ignore working files")
    parser.add_argument("--output", type=Path, default=Path("dist/addon"))
    parser.add_argument(
        "--verify", type=Path, help="check bundle bytes against its committed source"
    )
    args = parser.parse_args()
    try:
        manifest = (
            verify(Path.cwd(), args.verify)
            if args.verify
            else build(Path.cwd(), args.ref, args.output)
        )
    except ValueError, OSError, subprocess.CalledProcessError:
        parser.error("unable to prepare the committed local add-on package")
    print(json.dumps(manifest, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
