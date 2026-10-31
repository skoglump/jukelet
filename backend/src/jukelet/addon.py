"""Explicit startup adapter for the Supervisor-managed application image."""

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


def _private_state(data_root: Path, owner: tuple[int, int]) -> int:
    """Return an open, no-follow key descriptor; touch only our own private child."""
    root = os.open(data_root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
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
    finally:
        os.close(root)
    try:
        if created:
            os.fchown(directory, *owner)
            os.fchmod(directory, 0o700)
        _check_private(os.fstat(directory), owner, directory=True)
        for name in (
            DATABASE_NAME,
            *(f"{DATABASE_NAME}{suffix}" for suffix in ("-wal", "-shm", "-journal")),
        ):
            try:
                metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                continue
            _check_private(metadata, owner)
            if metadata.st_nlink != 1:
                raise ValueError("Private add-on database must not have hard links")
        try:
            os.stat(SECRET_NAME, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            _create_secret(directory, owner)
        secret = os.open(
            SECRET_NAME,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=directory,
        )
        try:
            _check_private(os.fstat(secret), owner)
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
    """Prepare the fixed server environment; no database is opened here."""
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
