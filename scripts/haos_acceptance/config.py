"""Private, declared inputs for the task-owned native acceptance fixture."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FIXTURE = "jukelet-m5-issue62-matrix-kvm"
LOCAL_ORIGIN = "https://127.0.0.1:18223"
PROXY_ORIGIN = "https://127.0.0.1:28223"
CONTROL_ROOT = Path("/tmp/jukelet-issue62-matrix-control")
_ERROR = "Unsupported fixture configuration"
_FIELDS = {
    "schema_version",
    "fixture",
    "synthetic",
    "origin",
    "proxy_origin",
    "qmp_socket_file",
    "admin_credentials_file",
    "denied_credentials_file",
    "certificate_file",
    "candidate",
    "bridge",
}


def _hash(value: Any, *, digest: bool = False, commit: bool = False) -> bool:
    return (
        type(value) is str
        and re.fullmatch(
            r"sha256:[a-f0-9]{64}" if digest else r"[a-f0-9]{40}" if commit else r"[a-f0-9]{64}",
            value,
        )
        is not None
    )


def validate_document(value: Any) -> dict[str, Any]:
    """Validate declarations, without contacting HA or establishing acceptance."""
    if (
        type(value) is not dict
        or set(value) != _FIELDS
        or type(value["schema_version"]) is not int
        or value["schema_version"] != 1
        or value["fixture"] != FIXTURE
        or value["synthetic"] is not True
        or value["origin"] != LOCAL_ORIGIN
        or value["proxy_origin"] not in (None, PROXY_ORIGIN)
        or value["qmp_socket_file"] != "qmp.sock"
    ):
        raise ValueError(_ERROR)
    for key, extension in (
        ("admin_credentials_file", "json"),
        ("denied_credentials_file", "json"),
        ("certificate_file", "crt"),
    ):
        if (
            type(value[key]) is not str
            or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}\." + extension, value[key]) is None
        ):
            raise ValueError(_ERROR)
    if value["admin_credentials_file"] == value["denied_credentials_file"]:
        raise ValueError(_ERROR)
    candidate = value["candidate"]
    bridge = value["bridge"]
    if (
        type(candidate) is not dict
        or set(candidate)
        != {"source_commit", "context_sha256", "image_config_digest", "image_manifest_digest"}
        or not _hash(candidate["source_commit"], commit=True)
        or not _hash(candidate["context_sha256"])
        or not _hash(candidate["image_config_digest"], digest=True)
        or not _hash(candidate["image_manifest_digest"], digest=True)
        or type(bridge) is not dict
        or set(bridge) != {"source_commit", "archive_sha256"}
        or not _hash(bridge["source_commit"], commit=True)
        or not _hash(bridge["archive_sha256"])
    ):
        raise ValueError(_ERROR)
    # Detach nested declarations; callers cannot change an already checked object.
    return {**value, "candidate": dict(candidate), "bridge": dict(bridge)}


def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in items:
        if key in value:
            raise ValueError(_ERROR)
        value[key] = item
    return value


def _regular(
    root: int, name: str, *, limit: int, read: bool, public_certificate: bool = False
) -> tuple[dict[str, int], bytes | None]:
    flags = os.O_RDONLY if read else os.O_PATH
    descriptor = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=root)
    try:
        info = os.fstat(descriptor)
        allowed = {0o600, 0o644} if public_certificate else {0o600}
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_IMODE(info.st_mode) not in allowed
            or (info.st_uid, info.st_gid) != (os.geteuid(), os.getegid())
            or info.st_nlink != 1
            or not 0 < info.st_size <= limit
        ):
            raise ValueError(_ERROR)
        data = os.read(descriptor, limit + 1) if read else None
        if data is not None and len(data) != info.st_size:
            raise ValueError(_ERROR)
        return {"bytes": info.st_size, "mode": stat.S_IMODE(info.st_mode)}, data
    finally:
        os.close(descriptor)


@dataclass(frozen=True)
class FixtureInputs:
    """Validated local declarations, not verified VM or native acceptance evidence."""

    document: dict[str, Any]
    file_metadata: dict[str, Any]

    def public_report(self) -> dict[str, Any]:
        return {
            "result": "PASS_LOCAL_INPUT",
            "fixture": FIXTURE,
            "origin": self.document["origin"],
            "proxy_origin": self.document["proxy_origin"],
            "declared_candidate": self.document["candidate"],
            "declared_bridge": self.document["bridge"],
            "files": self.file_metadata,
            "credential_values_read": False,
            "qmp_identity": "NOT_QUERIED",
            "native_acceptance": "NOT_RUN",
        }


def load_config(path: Path) -> FixtureInputs:
    """Read only one private control root; do not open credential-file contents."""
    descriptor: int | None = None
    try:
        if (
            not path.is_absolute()
            or path.parent != CONTROL_ROOT
            or re.fullmatch(r"[a-z][a-z0-9_-]{0,63}\.json", path.name) is None
            or any(parent.is_symlink() for parent in (CONTROL_ROOT, *CONTROL_ROOT.parents))
        ):
            raise ValueError(_ERROR)
        descriptor = os.open(
            CONTROL_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        )
        info = os.fstat(descriptor)
        if stat.S_IMODE(info.st_mode) != 0o700 or (info.st_uid, info.st_gid) != (
            os.geteuid(),
            os.getegid(),
        ):
            raise ValueError(_ERROR)
        metadata, raw = _regular(descriptor, path.name, limit=16384, read=True)
        assert raw is not None
        document = validate_document(json.loads(raw, object_pairs_hook=_pairs))
        files: dict[str, Any] = {"configuration": metadata}
        for key in ("admin_credentials_file", "denied_credentials_file"):
            files[key], _ = _regular(descriptor, document[key], limit=16384, read=False)
        certificate_meta, certificate = _regular(
            descriptor,
            document["certificate_file"],
            limit=32768,
            read=True,
            public_certificate=True,
        )
        assert certificate is not None
        if not certificate.startswith(b"-----BEGIN CERTIFICATE-----\n"):
            raise ValueError(_ERROR)
        files["certificate_file"] = {
            **certificate_meta,
            "sha256": hashlib.sha256(certificate).hexdigest(),
        }
        qmp = os.stat("qmp.sock", dir_fd=descriptor, follow_symlinks=False)
        if (
            not stat.S_ISSOCK(qmp.st_mode)
            or stat.S_IMODE(qmp.st_mode) & 0o077
            or (qmp.st_uid, qmp.st_gid) != (os.geteuid(), os.getegid())
        ):
            raise ValueError(_ERROR)
        files["qmp_socket_file"] = {"mode": stat.S_IMODE(qmp.st_mode)}
        return FixtureInputs(document, files)
    except OSError, ValueError, TypeError, RecursionError:
        raise ValueError(_ERROR) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
