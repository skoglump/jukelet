"""Explicit startup adapter for the Supervisor-managed application image."""

import fcntl
import json
import os
import secrets
import stat
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, NoReturn, cast

from jukelet.config import Settings


@dataclass(frozen=True, slots=True)
class AddonOptions:
    public_origin: str = field(repr=False)
    additional_origins: tuple[str, ...] = field(default=(), repr=False)
    mode: Literal["read_only", "manage"] = "read_only"
    spotifyplus_entity_id: str | None = field(default=None, repr=False)


SERVICE_ID = (10001, 10001)
STATE_DIRECTORY = "jukelet"
SECRET_NAME = "auth-secret"
DATABASE_NAME = "jukelet.db"
MARKER_NAME = ".supervisor-continuity"
OPTIONS_PATH = Path("/data/options.json")
DATA_ROOT = Path("/data")


def _read_regular(path: str | Path, limit: int, *, directory: int | None = None) -> bytes:
    descriptor = os.open(
        path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory
    )
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Add-on file must be a regular file")
        value = bytearray()
        while len(value) <= limit:
            part = os.read(descriptor, limit + 1 - len(value))
            if not part:
                break
            value.extend(part)
        if len(value) > limit:
            raise ValueError("Add-on file is too large")
        return bytes(value)
    finally:
        os.close(descriptor)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate add-on option")
        value[key] = item
    return value


def read_options(path: Path) -> AddonOptions:
    """Bounded read only; the Supervisor owns this file and its permissions."""
    try:
        raw = _read_regular(path, 16384)
    except OSError:
        raise ValueError("Unable to read Supervisor add-on options") from None
    try:
        value = json.loads(raw, object_pairs_hook=_unique_object)
    except json.JSONDecodeError, UnicodeError, RecursionError:
        raise ValueError("Add-on options must contain valid JSON") from None
    if not isinstance(value, dict):
        raise ValueError("Add-on options must be an object")
    if value.keys() - {"public_origin", "additional_origins", "mode", "spotifyplus_entity_id"}:
        raise ValueError("Unsupported add-on option")
    origin = value.get("public_origin")
    if not isinstance(origin, str) or not origin.startswith("https://"):
        raise ValueError("public_origin must be an HTTPS origin")
    additional = value.get("additional_origins", [])
    if (
        not isinstance(additional, list)
        or len(additional) > 8
        or any(
            not isinstance(item, str) or not item.startswith("https://") or "," in item
            for item in additional
        )
    ):
        raise ValueError("additional_origins must contain at most eight HTTPS origins")
    mode = value.get("mode", "read_only")
    if not isinstance(mode, str) or mode not in {"read_only", "manage"}:
        raise ValueError("mode must be read_only or manage")
    entity = value.get("spotifyplus_entity_id", "")
    if not isinstance(entity, str):
        raise ValueError("spotifyplus_entity_id must be a media_player entity ID")
    return AddonOptions(
        origin,
        tuple(additional),
        cast(Literal["read_only", "manage"], mode),
        entity or None,
    )


def _check_private(
    metadata: os.stat_result,
    owner: tuple[int, int],
    *,
    directory: bool = False,
) -> None:
    correct_type = stat.S_ISDIR(metadata.st_mode) if directory else stat.S_ISREG(metadata.st_mode)
    if (
        not correct_type
        or (metadata.st_uid, metadata.st_gid) != owner
        or stat.S_IMODE(metadata.st_mode) != (0o700 if directory else 0o600)
    ):
        raise ValueError("Unsafe private add-on state ownership, type or permissions")


def _create_secret(directory: int, owner: tuple[int, int]) -> None:
    """Publish complete bytes without replacing an existing key, including on races."""
    temporary = f".auth-secret-{secrets.token_hex(16)}"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=directory,
    )
    try:
        os.fchown(descriptor, *owner)
        os.fchmod(descriptor, 0o600)
        contents = secrets.token_urlsafe(48).encode("ascii")
        offset = 0
        while offset < len(contents):
            written = os.write(descriptor, contents[offset:])
            if written <= 0:
                raise OSError("Unable to write private add-on key")
            offset += written
        os.fsync(descriptor)
        try:
            os.link(
                temporary,
                SECRET_NAME,
                src_dir_fd=directory,
                dst_dir_fd=directory,
                follow_symlinks=False,
            )
        except FileExistsError:
            pass
    finally:
        os.close(descriptor)
        os.unlink(temporary, dir_fd=directory)
    os.fsync(directory)


def _key_contents(descriptor: int) -> bytes:
    os.lseek(descriptor, 0, os.SEEK_SET)
    value = bytearray()
    while len(value) <= 130:
        part = os.read(descriptor, 131 - len(value))
        if not part:
            break
        value.extend(part)
    secret = bytes(value).rstrip(b"\r\n")
    if len(value) > 130 or not 32 <= len(secret) <= 128 or not secret.isascii():
        raise ValueError("Private add-on key must contain a 32–128 byte ASCII secret")
    os.lseek(descriptor, 0, os.SEEK_SET)
    return bytes(value)


def _restore_file(metadata: os.stat_result, owner: tuple[int, int]) -> None:
    identity = metadata.st_uid, metadata.st_gid
    mode = stat.S_IMODE(metadata.st_mode)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or not (
            (identity == owner and mode == 0o600) or (identity == (0, 0) and mode in {0o600, 0o644})
        )
    ):
        raise ValueError("Unsafe private add-on restore file")


def _restore_descriptor(directory: int, name: str, owner: tuple[int, int]) -> int:
    # O_PATH inspects a special file without opening its device/stream behavior.
    # Reopen only a validated regular inode through its held Linux descriptor.
    selected = os.open(name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        original = os.fstat(selected)
        _restore_file(original, owner)
        descriptor = os.open(
            f"/proc/self/fd/{selected}", os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC
        )
        try:
            current = os.fstat(descriptor)
            _restore_file(current, owner)
            if (original.st_dev, original.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError("Private add-on restore selection changed")
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise
    finally:
        os.close(selected)


def _normalize_restored(root: int, directory: int, owner: tuple[int, int]) -> None:
    """Adopt only the bounded native restore shape, without opening SQLite.

    Files are tightened before ownership changes; the root-only parent changes
    last. Partial root600/service600 progress can safely resume, but a witness or
    unexplained entry cannot establish continuity through this path.
    """
    initial = os.fstat(directory)
    if (initial.st_uid, initial.st_gid) == owner:
        return
    if (
        os.geteuid() != 0
        or (initial.st_uid, initial.st_gid) != (0, 0)
        or not stat.S_ISDIR(initial.st_mode)
        or stat.S_IMODE(initial.st_mode) != 0o700
    ):
        raise ValueError("Unsafe private add-on restore directory")
    names = set(os.listdir(directory))
    if DATABASE_NAME not in names or SECRET_NAME not in names:
        raise ValueError("Unsafe private add-on restore: database or key is missing")
    allowed = {
        DATABASE_NAME,
        SECRET_NAME,
        *(DATABASE_NAME + suffix for suffix in ("-wal", "-shm", "-journal")),
    }
    if not names <= allowed:
        raise ValueError("Unsafe private add-on restore contents")
    descriptors: dict[str, int] = {}
    stamps: dict[str, tuple[int, int, int, int]] = {}

    def stamp(metadata: os.stat_result) -> tuple[int, int, int, int]:
        return metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns

    def recheck() -> None:
        current = os.fstat(directory)
        selected = os.stat(STATE_DIRECTORY, dir_fd=root, follow_symlinks=False)
        if (
            (current.st_dev, current.st_ino) != (initial.st_dev, initial.st_ino)
            or (selected.st_dev, selected.st_ino) != (initial.st_dev, initial.st_ino)
            or not stat.S_ISDIR(selected.st_mode)
            or (selected.st_mode, selected.st_uid, selected.st_gid)
            != (current.st_mode, current.st_uid, current.st_gid)
            or stat.S_IMODE(current.st_mode) != 0o700
            or (current.st_uid, current.st_gid) not in {(0, 0), owner}
            or set(os.listdir(directory)) != names
        ):
            raise ValueError("Private add-on restore directory changed")
        for name, descriptor in descriptors.items():
            metadata = os.fstat(descriptor)
            _restore_file(metadata, owner)
            selected = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (
                stamp(metadata) != stamps[name]
                or stamp(selected) != stamps[name]
                or (selected.st_mode, selected.st_uid, selected.st_gid, selected.st_nlink)
                != (metadata.st_mode, metadata.st_uid, metadata.st_gid, metadata.st_nlink)
            ):
                raise ValueError("Private add-on restore file changed")

    try:
        for name in sorted(names):
            descriptor = _restore_descriptor(directory, name, owner)
            descriptors[name] = descriptor
            metadata = os.fstat(descriptor)
            _restore_file(metadata, owner)
            stamps[name] = stamp(metadata)
        key = _key_contents(descriptors[SECRET_NAME])
        recheck()  # Validate the complete selected set before any metadata mutation.
        for descriptor in descriptors.values():
            recheck()
            metadata = os.fstat(descriptor)
            if stat.S_IMODE(metadata.st_mode) != 0o600:
                os.fchmod(descriptor, 0o600)
            recheck()
            if (metadata.st_uid, metadata.st_gid) != owner:
                os.fchown(descriptor, *owner)
            os.fsync(descriptor)
        recheck()
        for descriptor in descriptors.values():
            _check_private(os.fstat(descriptor), owner)
        if not secrets.compare_digest(key, _key_contents(descriptors[SECRET_NAME])):
            raise ValueError("Private add-on restore key changed")
        os.fchown(directory, *owner)
        recheck()
        os.fsync(directory)
    finally:
        for descriptor in descriptors.values():
            os.close(descriptor)


def _private_state(data_root: Path, owner: tuple[int, int]) -> int:
    """Return an open, no-follow key descriptor; touch only our own private child."""
    root = os.open(data_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        # Bootstrap serialization covers mkdir, validation/normalization and the
        # key's exclusive two-link staging interval. This is not server leadership.
        fcntl.flock(root, fcntl.LOCK_EX)
        return _private_child(root, owner)
    finally:
        os.close(root)


def _private_child(root: int, owner: tuple[int, int]) -> int:
    created = False
    try:
        os.mkdir(STATE_DIRECTORY, mode=0o700, dir_fd=root)
        created = True
    except FileExistsError:
        pass
    directory = os.open(
        STATE_DIRECTORY,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=root,
    )
    try:
        if created:
            os.fchown(directory, *owner)
            os.fchmod(directory, 0o700)
        else:
            _normalize_restored(root, directory, owner)
        _check_private(os.fstat(directory), owner, directory=True)
        present: set[str] = set()
        for name in (
            DATABASE_NAME,
            *(f"{DATABASE_NAME}{suffix}" for suffix in ("-wal", "-shm", "-journal")),
            MARKER_NAME,
        ):
            try:
                metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                continue
            present.add(name)
            _check_private(metadata, owner)
            if metadata.st_nlink != 1:
                raise ValueError("Private add-on state must not have hard links")
        if DATABASE_NAME not in present and present:
            raise ValueError("Private add-on database is missing beside retained state")
        try:
            os.stat(SECRET_NAME, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            if present:
                raise ValueError("Private add-on key is missing beside retained state") from None
            _create_secret(directory, owner)
        secret = os.open(
            SECRET_NAME,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=directory,
        )
        try:
            _check_private(os.fstat(secret), owner)
            if os.fstat(secret).st_nlink != 1:
                raise ValueError("Private add-on key must not have hard links")
        except BaseException:
            os.close(secret)
            raise
        return secret
    finally:
        os.close(directory)


def prepare(
    options_path: Path,
    data_root: Path,
    environ: Mapping[str, str],
    *,
    owner: tuple[int, int] = SERVICE_ID,
) -> dict[str, str]:
    """Prepare the fixed server environment; no SQLite connection is opened here."""
    options = read_options(options_path)
    state = data_root / STATE_DIRECTORY
    secret = state / SECRET_NAME
    result = dict(environ)
    result.update(
        APP_RUNTIME="ingress",
        HA_TRANSPORT="supervisor",
        APP_MODE=options.mode,
        APP_ALLOW_INSECURE_HTTP="false",
        APP_PUBLIC_ORIGIN=options.public_origin,
        APP_AUTH_TOKEN_FILE=str(secret),
        DATABASE_PATH=str(state / DATABASE_NAME),
        APP_STATIC_DIR="/app/frontend",
        JUKELET_SUPERVISOR_CONTINUITY="required",
    )
    result.pop("APP_INGRESS_ORIGINS", None)
    result.pop("SPOTIFYPLUS_ENTITY_ID", None)
    if options.additional_origins:
        result["APP_INGRESS_ORIGINS"] = ",".join(options.additional_origins)
    if options.spotifyplus_entity_id:
        result["SPOTIFYPLUS_ENTITY_ID"] = options.spotifyplus_entity_id
    try:
        descriptor = _private_state(data_root, owner)
        try:
            # Settings remains authoritative; validate through the already checked inode.
            Settings.load({**result, "APP_AUTH_TOKEN_FILE": f"/proc/self/fd/{descriptor}"})
        finally:
            os.close(descriptor)
    except OSError:
        raise ValueError("Unable to prepare private add-on state") from None
    return result


def execute(environment: Mapping[str, str]) -> NoReturn:
    """Replace the adapter with the sole server; never interpret shell input."""
    os.umask(0o077)
    os.setgroups([])
    os.setgid(SERVICE_ID[1])
    os.setuid(SERVICE_ID[0])
    os.execve(
        sys.executable,
        [
            sys.executable,
            "-m",
            "uvicorn",
            "jukelet.main:create_app",
            "--factory",
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
            "--workers",
            "1",
            "--no-access-log",
            "--no-proxy-headers",
        ],
        environment,
    )


def main() -> int:
    try:
        environment = prepare(OPTIONS_PATH, DATA_ROOT, os.environ)
        execute(environment)
    except ValueError, OSError:
        print(
            "Jukelet add-on startup failed: "
            "invalid configuration, private data or runtime permissions",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
