"""Build/verify a deterministic runtime-only HA integration from committed Git objects."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import subprocess
import zipfile
from pathlib import Path
from typing import Any

SOURCE = "companion/custom_components/jukelet_bridge"
PREFIX = "custom_components/jukelet_bridge/"
RUNTIME = (
    "__init__.py",
    "administration.py",
    "bridge.py",
    "config_flow.py",
    "compatibility.py",
    "dispatcher.py",
    "ha_playback.py",
    "ha_store.py",
    "manifest.json",
    "playback.py",
    "protocol.py",
    "strings.json",
    "translations/en.json",
)
BUILD_INFO = "build_info.json"
LICENSE_FILE = "LICENSE"


def git(repository: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repository), *args], stderr=subprocess.PIPE)


def encoded(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def release_version(tag: str, version: str, prerelease: bool) -> str:
    if tag != "integration-v" + version or not re.fullmatch(
        r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version
    ):
        raise ValueError("integration release must be integration-vX.Y.Z matching manifest.json")
    if prerelease:
        raise ValueError("integration-vX.Y.Z is a stable integration-only release")
    return version


def build(repository: Path, ref: str, output: Path) -> dict[str, Any]:
    commit = git(repository, "rev-parse", "--verify", ref + "^{commit}").decode().strip()
    tree = git(repository, "rev-parse", commit + ":" + SOURCE).decode().strip()
    entries = git(repository, "ls-tree", "-r", commit, "--", SOURCE).decode().splitlines()
    names: list[str] = []
    for entry in entries:
        mode, kind, _identity, path = entry.split(maxsplit=3)
        if mode != "100644" or kind != "blob":
            raise ValueError("runtime must contain only regular non-executable files")
        names.append(path.removeprefix(SOURCE + "/"))
    if sorted(names) != sorted(RUNTIME):
        raise ValueError("committed runtime file set differs from reviewed allowlist")
    files = {name: git(repository, "show", commit + ":" + SOURCE + "/" + name) for name in RUNTIME}
    license_entry = git(repository, "ls-tree", commit, "--", LICENSE_FILE).decode().split()
    if license_entry[:2] != ["100644", "blob"]:
        raise ValueError("committed license must be a regular non-executable file")
    files[LICENSE_FILE] = git(repository, "show", commit + ":" + LICENSE_FILE)
    version = json.loads(files["manifest.json"])["version"]
    release_version("integration-v" + version, version, False)
    identity = {
        "format_version": 1,
        "integration_version": version,
        "source_commit": commit,
        "source_tree": tree,
        "source_path": SOURCE,
    }
    files[BUILD_INFO] = encoded(identity)
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(PREFIX + name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    archive_name = f"jukelet-bridge-{version}.zip"
    archive_bytes = stream.getvalue()
    manifest = {
        **identity,
        "archive": archive_name,
        "archive_sha256": digest(archive_bytes),
        "files": {PREFIX + name: digest(content) for name, content in sorted(files.items())},
    }
    outputs = {
        archive_name: archive_bytes,
        archive_name + ".manifest.json": encoded(manifest),
        archive_name + ".sha256": (digest(archive_bytes) + "  " + archive_name + "\n").encode(),
    }
    output.mkdir(parents=True, exist_ok=True)
    for name, content in outputs.items():
        path = output / name
        if path.exists() and path.read_bytes() != content:
            raise ValueError("refusing to replace different existing artifact bytes")
    for name, content in outputs.items():
        (output / name).write_bytes(content)
    return manifest


def verify(archive_path: Path, installed: Path | None = None) -> dict[str, Any]:
    manifest = json.loads(Path(str(archive_path) + ".manifest.json").read_bytes())
    version = manifest["integration_version"]
    release_version("integration-v" + version, version, False)
    expected = {PREFIX + name for name in (*RUNTIME, BUILD_INFO, LICENSE_FILE)}
    if set(manifest["files"]) != expected or manifest["archive"] != archive_path.name:
        raise ValueError("unexpected artifact file set/name")
    archive_bytes = archive_path.read_bytes()
    if digest(archive_bytes) != manifest["archive_sha256"]:
        raise ValueError("archive checksum mismatch")
    checksum = Path(str(archive_path) + ".sha256").read_text()
    if checksum != digest(archive_bytes) + "  " + archive_path.name + "\n":
        raise ValueError("checksum sidecar mismatch")
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        if len(archive.namelist()) != len(expected) or set(archive.namelist()) != expected:
            raise ValueError("unexpected or duplicate archive members")
        for member in archive.infolist():
            if member.external_attr >> 16 != 0o100644:
                raise ValueError("nonregular archive member")
            content = archive.read(member)
            if digest(content) != manifest["files"][member.filename]:
                raise ValueError("runtime file checksum mismatch")
            if installed is not None:
                path = installed / member.filename.removeprefix(PREFIX)
                if (
                    path.is_symlink()
                    or digest(path.read_bytes()) != manifest["files"][member.filename]
                ):
                    raise ValueError("installed runtime checksum mismatch")
        info = json.loads(archive.read(PREFIX + BUILD_INFO))
        if any(info[key] != manifest[key] for key in info):
            raise ValueError("build identity mismatch")
        if json.loads(archive.read(PREFIX + "manifest.json"))["version"] != version:
            raise ValueError("integration version mismatch")
    if installed is not None:
        actual = {
            path.relative_to(installed).as_posix()
            for path in installed.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
        }
        if actual != {*RUNTIME, BUILD_INFO, LICENSE_FILE}:
            raise ValueError("unexpected installed files; replace the complete directory")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ref", default="HEAD", help="committed source only; working files are ignored"
    )
    parser.add_argument("--output", type=Path, default=Path("dist/integration"))
    parser.add_argument("--verify", type=Path, help="archive with adjacent manifest/checksum")
    parser.add_argument(
        "--installed", type=Path, help="compare the installed integration directory"
    )
    parser.add_argument("--release-tag")
    parser.add_argument("--prerelease", choices=("true", "false"), default="false")
    args = parser.parse_args()
    try:
        if args.installed and not args.verify:
            raise ValueError("--installed requires --verify")
        manifest = (
            verify(args.verify, args.installed)
            if args.verify
            else build(Path.cwd(), args.ref, args.output)
        )
        if args.release_tag:
            release_version(
                args.release_tag, manifest["integration_version"], args.prerelease == "true"
            )
    except (
        ValueError,
        OSError,
        KeyError,
        subprocess.CalledProcessError,
        zipfile.BadZipFile,
    ) as error:
        parser.error(str(error))
    print(json.dumps(manifest, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
