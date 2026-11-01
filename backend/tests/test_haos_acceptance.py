"""Local synthetic acceptance-input tests; never contact HA or a provider."""

import copy
import json
import os
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from scripts.haos_acceptance import config
from scripts.haos_acceptance.config import FIXTURE, load_config, validate_document


def document() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "fixture": FIXTURE,
        "synthetic": True,
        "origin": "https://127.0.0.1:18223",
        "proxy_origin": "https://127.0.0.1:28223",
        "qmp_socket_file": "qmp.sock",
        "admin_credentials_file": "credentials-admin.json",
        "denied_credentials_file": "credentials-denied.json",
        "certificate_file": "fixture.crt",
        "candidate": {
            "source_commit": "a" * 40,
            "context_sha256": "b" * 64,
            "image_config_digest": "sha256:" + "c" * 64,
            "image_manifest_digest": "sha256:" + "d" * 64,
        },
        "bridge": {"source_commit": "e" * 40, "archive_sha256": "f" * 64},
    }


def test_acceptance_input_rejects_a_household_or_public_origin() -> None:
    value = document()
    value["origin"] = "https://household.example"
    with pytest.raises(ValueError, match="Unsupported fixture configuration"):
        validate_document(value)


def test_declared_input_preserves_exact_identities_without_proving_native_acceptance() -> None:
    value = document()
    checked = validate_document(value)
    assert checked == value
    value["candidate"]["source_commit"] = "0" * 40
    assert checked["candidate"]["source_commit"] == "a" * 40


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("fixture", "jukelet-m5-disposable-kvm"),
        ("synthetic", 1),
        ("schema_version", True),
        ("origin", "http://127.0.0.1:18223"),
        ("origin", "https://localhost:18223"),
        ("origin", "https://127.0.0.1:18223/path"),
        ("origin", "https://127.0.0.1:18223@household.example"),
        ("proxy_origin", "https://127.0.0.1:18224"),
        ("qmp_socket_file", "../qmp.sock"),
        ("admin_credentials_file", "/tmp/credentials.json"),
        ("denied_credentials_file", "../credentials.json"),
        ("denied_credentials_file", "credentials-admin.json"),
        ("certificate_file", "fixture.key"),
        ("password", "SYNTHETIC_PRIVATE_SENTINEL"),
    ],
)
def test_declared_input_refuses_unsafe_targets_and_private_extra_fields(
    key: str, value: Any
) -> None:
    raw = document()
    raw[key] = value
    with pytest.raises(ValueError) as error:
        validate_document(raw)
    assert str(error.value) == "Unsupported fixture configuration"


@pytest.mark.parametrize(
    ("section", "key", "value"),
    [
        ("candidate", "source_commit", "main"),
        ("candidate", "context_sha256", "A" * 64),
        ("candidate", "image_manifest_digest", "sha256:" + "x" * 64),
        ("candidate", "image_config_digest", "sha256:" + "a" * 63),
        ("bridge", "source_commit", "v0.1.5"),
        ("bridge", "archive_sha256", True),
        ("bridge", "token", "SYNTHETIC_PRIVATE_SENTINEL"),
    ],
)
def test_declared_artifacts_require_exact_immutable_identity_shapes(
    section: str, key: str, value: Any
) -> None:
    raw = document()
    raw[section][key] = value
    with pytest.raises(ValueError):
        validate_document(raw)


@pytest.fixture
def private_inputs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "control"
    root.mkdir(mode=0o700)
    monkeypatch.setattr(config, "CONTROL_ROOT", root)
    path = root / "acceptance.json"
    path.write_text(json.dumps(document()))
    path.chmod(0o600)
    for name in ("credentials-admin.json", "credentials-denied.json"):
        private = root / name
        private.write_bytes(b"SYNTHETIC_PRIVATE_SENTINEL_not_json")
        private.chmod(0o600)
    certificate = root / "fixture.crt"
    certificate.write_bytes(b"-----BEGIN CERTIFICATE-----\nSYNTHETIC_PUBLIC_INPUT\n")
    certificate.chmod(0o644)
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(root / "qmp.sock"))
    (root / "qmp.sock").chmod(0o700)
    return path


def test_local_validation_never_reads_credential_values_or_contacts_qmp(
    private_inputs: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_open = os.open
    opened: list[tuple[str, int]] = []

    def observe_open(path: Any, flags: int, *args: Any, **kwargs: Any) -> int:
        opened.append((str(path), flags))
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", observe_open)
    result = load_config(private_inputs).public_report()
    assert result["result"] == "PASS_LOCAL_INPUT"
    assert result["native_acceptance"] == "NOT_RUN"
    assert result["qmp_identity"] == "NOT_QUERIED"
    assert result["credential_values_read"] is False
    assert "SYNTHETIC_PRIVATE_SENTINEL" not in json.dumps(result)
    for name in ("credentials-admin.json", "credentials-denied.json"):
        assert next(flags for path, flags in opened if path == name) & os.O_PATH


@pytest.mark.parametrize("damage", ["mode", "symlink", "hardlink", "directory", "empty"])
def test_local_validation_refuses_unsafe_private_references_without_repair(
    private_inputs: Path, damage: str
) -> None:
    target = private_inputs.parent / "credentials-denied.json"
    original = target.read_bytes()
    if damage == "mode":
        target.chmod(0o644)
    elif damage == "symlink":
        target.unlink()
        target.symlink_to("credentials-admin.json")
    elif damage == "hardlink":
        target.unlink()
        target.hardlink_to(private_inputs.parent / "credentials-admin.json")
    elif damage == "directory":
        target.unlink()
        target.mkdir(mode=0o700)
    else:
        target.write_bytes(b"")
    with pytest.raises(ValueError, match="Unsupported fixture configuration"):
        load_config(private_inputs)
    assert (private_inputs.parent / "credentials-admin.json").read_bytes() == original


@pytest.mark.parametrize("damage", ["root_mode", "qmp_file", "qmp_mode", "duplicate", "oversize"])
def test_local_validation_refuses_untrusted_roots_sockets_and_ambiguous_json(
    private_inputs: Path, damage: str
) -> None:
    if damage == "root_mode":
        private_inputs.parent.chmod(0o755)
    elif damage == "qmp_file":
        socket_path = private_inputs.parent / "qmp.sock"
        socket_path.unlink()
        socket_path.write_bytes(b"not a socket")
        socket_path.chmod(0o600)
    elif damage == "qmp_mode":
        (private_inputs.parent / "qmp.sock").chmod(0o777)
    elif damage == "duplicate":
        private_inputs.write_text('{"fixture":"' + FIXTURE + '","fixture":"other"}')
    else:
        private_inputs.write_bytes(b" " * 16385)
    with pytest.raises(ValueError, match="Unsupported fixture configuration"):
        load_config(private_inputs)


def test_validation_cli_fails_closed_without_private_error_output(tmp_path: Path) -> None:
    config_file = tmp_path / "SYNTHETIC_PRIVATE_SENTINEL.json"
    config_file.write_text(json.dumps(copy.deepcopy(document())))
    result = subprocess.run(
        [sys.executable, "-B", "-m", "scripts.haos_acceptance", "validate", str(config_file)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert result.stdout == ""
    assert json.loads(result.stderr) == {
        "result": "FAIL",
        "code": "invalid_fixture_input",
        "native_acceptance": "NOT_RUN",
    }
