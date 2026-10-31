"""Synthetic read-only probe inputs; never the disposable VM or household."""

import hashlib
import json
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest

from jukelet.storage import migrate, open_database
from scripts.probe_addon_state import snapshot


@pytest.fixture
def probe_inputs(tmp_path: Path) -> dict[str, Any]:
    data = tmp_path / "data"
    state = data / "jukelet"
    state.mkdir(parents=True, mode=0o700)
    database = state / "jukelet.db"
    engine = open_database(database)
    migrate(engine)
    engine.dispose()
    secret = state / "auth-secret"
    private = b"SYNTHETIC-PRIVATE-KEY-12345678901234567890"
    secret.write_bytes(private)
    secret.chmod(0o600)
    options = data / "options.json"
    options.write_text('{"mode":"read_only","public_origin":"https://ha.example"}')
    process = tmp_path / "status"
    process.write_text(
        "Uid:\t10001\t10001\t10001\t10001\nGid:\t10001\t10001\t10001\t10001\nGroups:\t\nCapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapInh:\t0000000000000000\nCapAmb:\t0000000000000000\n"
    )
    payload_files = {"Dockerfile": "c" * 64}
    identity = {
        "source_commit": "a" * 40,
        "source_tree": "b" * 40,
        "addon_version": "0.1.0-addon.1",
        "payload_files": payload_files,
    }
    build_info = tmp_path / "build-info.json"
    build_info.write_text(json.dumps(identity))
    files = {
        **payload_files,
        "build-info.json": hashlib.sha256(build_info.read_bytes()).hexdigest(),
    }
    context = hashlib.sha256(
        (json.dumps(files, sort_keys=True, indent=2) + "\n").encode()
    ).hexdigest()
    return {
        "data": data,
        "process": process,
        "build_info": build_info,
        "context": context,
        "private": private,
    }


def observe(inputs: dict[str, Any], *, source: str = "a" * 40) -> dict[str, Any]:
    return snapshot(
        source,
        inputs["context"],
        data=inputs["data"],
        process=inputs["process"],
        build_info=inputs["build_info"],
    )


def test_state_probe_reports_selected_facts_without_secret_or_publisher_bytes(
    probe_inputs: dict[str, Any],
) -> None:
    report = observe(probe_inputs)
    data = probe_inputs["data"]
    private = probe_inputs["private"]
    with sqlite3.connect(data / "jukelet/jukelet.db") as connection:
        publisher = connection.execute("SELECT publisher_id FROM recovery_state").fetchone()[0]
    assert report["schema"] == "0004"
    assert report["secret"]["sha256"] == hashlib.sha256(private).hexdigest()
    assert (
        report["options"]["sha256"]
        == hashlib.sha256((data / "options.json").read_bytes()).hexdigest()
    )
    assert len(report["publisher_sha256"]) == 64
    assert report["publication"]["automatic_enabled"] == 0
    assert report["publication_jobs"] == 0
    assert private.decode() not in json.dumps(report)
    assert publisher not in json.dumps(report)


def test_probe_preserves_database_and_observes_actual_guard_state(
    probe_inputs: dict[str, Any],
) -> None:
    database = probe_inputs["data"] / "jukelet/jukelet.db"
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE publication_state SET automatic_enabled=1,high_water=7")
        connection.commit()
    before = database.read_bytes()
    report = observe(probe_inputs)
    assert database.read_bytes() == before
    assert report["publication"]["automatic_enabled"] == 1
    assert report["publication"]["high_water"] == 7


@pytest.mark.parametrize(
    "kind", ["source", "context", "root", "capability", "symlink", "missing_database"]
)
def test_probe_rejects_wrong_candidate_unsafe_runtime_and_nonregular_state(
    probe_inputs: dict[str, Any], kind: str
) -> None:
    if kind == "source":
        with pytest.raises(ValueError, match="identity mismatch"):
            observe(probe_inputs, source="f" * 40)
        return
    if kind == "context":
        probe_inputs["context"] = "f" * 64
    elif kind in {"root", "capability"}:
        process = probe_inputs["process"]
        text = process.read_text()
        process.write_text(
            text.replace("10001", "0")
            if kind == "root"
            else text.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001")
        )
    elif kind == "symlink":
        secret = probe_inputs["data"] / "jukelet/auth-secret"
        secret.rename(secret.with_name("private-target"))
        secret.symlink_to("private-target")
    else:
        (probe_inputs["data"] / "jukelet/jukelet.db").unlink()
    with pytest.raises((ValueError, OSError)):
        observe(probe_inputs)
    if kind == "missing_database":
        assert not (probe_inputs["data"] / "jukelet/jukelet.db").exists()


@pytest.mark.parametrize(
    "change",
    ["valid", "remote_origin", "wrong_fixture", "real_credentials", "extra_control", "unsafe_mode"],
)
def test_browser_config_validation_is_explicit_private_and_network_free(
    tmp_path: Path, change: str
) -> None:
    credentials = tmp_path / "credentials.json"
    credentials.write_text(
        json.dumps(
            {
                "synthetic": change != "real_credentials",
                "fixture_is_admin": True,
                "origin": "https://127.0.0.1:18123",
                "username": "synthetic",
                "password": "SYNTHETIC_PRIVATE_PASSWORD",
            }
        )
    )
    credentials.chmod(0o600)
    certificate = tmp_path / "fixture.crt"
    certificate.write_text("synthetic certificate: validation does not connect or launch Chromium")
    config: dict[str, Any] = {
        "fixture": "jukelet-m5-disposable-kvm",
        "origin": "https://127.0.0.1:18123",
        "credentials_file": str(credentials),
        "certificate_file": str(certificate),
        "source_commit": "a" * 40,
        "context_sha256": "b" * 64,
        "image_id": "sha256:" + "c" * 64,
    }
    if change == "remote_origin":
        config["origin"] = "https://private-household.invalid"
    elif change == "wrong_fixture":
        config["fixture"] = "not-the-task-owned-vm"
    elif change == "extra_control":
        config["command"] = "not-executed"
    path = tmp_path / "probe.json"
    path.write_text(json.dumps(config))
    path.chmod(0o644 if change == "unsafe_mode" else 0o600)
    module = Path(__file__).resolve().parents[2] / "scripts/probe_addon_browser.mjs"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "try { const {readConfig}=await import(process.argv[1]); "
            "readConfig(process.argv[2]); } catch { process.exitCode=1; }",
            module.as_uri(),
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == (0 if change == "valid" else 1)
    assert result.stdout == result.stderr == ""
