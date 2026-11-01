"""Synthetic read-only probe inputs; never the disposable VM or household."""

import hashlib
import hmac
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
    database.chmod(0o600)
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


def observe(
    inputs: dict[str, Any], *, source: str = "a" * 40, require_continuity: bool = False
) -> dict[str, Any]:
    return snapshot(
        source,
        inputs["context"],
        data=inputs["data"],
        process=inputs["process"],
        build_info=inputs["build_info"],
        require_continuity=require_continuity,
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
    assert report["options"]["readable"] is True
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


def test_probe_verifies_private_bound_witness_and_whole_state_without_mutation(
    probe_inputs: dict[str, Any],
) -> None:
    state = probe_inputs["data"] / "jukelet"
    database = state / "jukelet.db"
    with sqlite3.connect(database) as connection:
        publisher = connection.execute("SELECT publisher_id FROM recovery_state").fetchone()[0]
    material = b"jukelet-supervisor-continuity-v1:" + publisher.encode()
    marker = state / ".supervisor-continuity"
    marker.write_bytes(
        material
        + b":"
        + hmac.digest(probe_inputs["private"], material, "sha256").hex().encode()
        + b"\n"
    )
    marker.chmod(0o600)
    before = {path: path.read_bytes() for path in (database, marker, state / "auth-secret")}
    report = observe(probe_inputs)
    assert report["continuity"]["present"] is True
    assert report["continuity"]["valid"] is True
    assert report["sessions"] == 0
    assert report["job_states"] == {
        "queued": 0,
        "in_flight": 0,
        "uncertain": 0,
        "verified": 0,
        "fenced": 0,
    }
    assert len(report["tables"]) == 8
    assert all(len(value["sha256"]) == 64 for value in report["tables"].values())
    assert {path: path.read_bytes() for path in before} == before
    assert publisher not in json.dumps(report)
    assert probe_inputs["private"].decode() not in json.dumps(report)


def test_probe_cannot_emit_malformed_private_counter_as_metadata(
    probe_inputs: dict[str, Any],
) -> None:
    database = probe_inputs["data"] / "jukelet/jukelet.db"
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE publication_state SET high_water='SYNTHETIC_PRIVATE_COUNTER'")
    with pytest.raises(ValueError):
        observe(probe_inputs)


def test_current_guard_proof_requires_witness_while_legacy_observation_is_explicit(
    probe_inputs: dict[str, Any],
) -> None:
    report = observe(probe_inputs)
    assert report["continuity"] == {"required": False, "present": False, "valid": False}
    with pytest.raises(ValueError, match="Required continuity witness"):
        observe(probe_inputs, require_continuity=True)
    assert not (probe_inputs["data"] / "jukelet/.supervisor-continuity").exists()


@pytest.mark.parametrize(
    "damage", ["malformed", "oversize", "foreign", "key", "permissions", "hardlink", "symlink"]
)
def test_probe_rejects_unsafe_witness_without_repair_or_private_output(
    probe_inputs: dict[str, Any], damage: str
) -> None:
    state = probe_inputs["data"] / "jukelet"
    marker = state / ".supervisor-continuity"
    with sqlite3.connect(state / "jukelet.db") as connection:
        publisher = connection.execute("SELECT publisher_id FROM recovery_state").fetchone()[0]
    material = b"jukelet-supervisor-continuity-v1:" + (
        b"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" if damage == "foreign" else publisher.encode()
    )
    key = (
        b"another-valid-synthetic-private-key-123456789"
        if damage == "key"
        else probe_inputs["private"]
    )
    value = material + b":" + hmac.digest(key, material, "sha256").hex().encode() + b"\n"
    marker.write_bytes(
        b"x" * 257
        if damage == "oversize"
        else b"SYNTHETIC_PRIVATE_INVALID"
        if damage == "malformed"
        else value
    )
    marker.chmod(0o644 if damage == "permissions" else 0o600)
    if damage in {"hardlink", "symlink"}:
        actual = state / "retained"
        marker.rename(actual)
        if damage == "hardlink":
            marker.hardlink_to(actual)
        else:
            marker.symlink_to(actual)
    original = (state / "jukelet.db").read_bytes()
    with pytest.raises((ValueError, OSError)) as error:
        observe(probe_inputs, require_continuity=True)
    assert "SYNTHETIC_PRIVATE" not in str(error.value)
    assert (state / "jukelet.db").read_bytes() == original


def test_whole_table_hashes_detect_same_count_change_without_private_values(
    probe_inputs: dict[str, Any],
) -> None:
    before = observe(probe_inputs)
    database = probe_inputs["data"] / "jukelet/jukelet.db"
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE publication_state SET last_error='SYNTHETIC_PRIVATE_CHANGED'")
    after = observe(probe_inputs)
    assert (
        before["tables"]["publication_state"]["rows"]
        == after["tables"]["publication_state"]["rows"]
    )
    assert (
        before["tables"]["publication_state"]["sha256"]
        != after["tables"]["publication_state"]["sha256"]
    )
    assert "SYNTHETIC_PRIVATE_CHANGED" not in json.dumps(after)


def test_service_user_probe_observes_restricted_options_without_repair(
    probe_inputs: dict[str, Any],
) -> None:
    options = probe_inputs["data"] / "options.json"
    options.chmod(0o000)
    before = options.stat()
    try:
        report = observe(probe_inputs)
        assert report["options"]["readable"] is False
        assert report["options"]["sha256"] is None
        assert report["options"]["hash_evidence"] == "separate_fixture_operator_required"
        after = options.stat()
        assert (after.st_mode, after.st_uid, after.st_gid, after.st_mtime_ns) == (
            before.st_mode,
            before.st_uid,
            before.st_gid,
            before.st_mtime_ns,
        )
        assert report["schema"] == "0004" and report["integrity"] == "ok"
    finally:
        options.chmod(0o600)


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
    ("change", "rejection"),
    [
        ("valid", None),
        ("remote_origin", "invalid fixture identity"),
        ("wrong_fixture", "invalid fixture identity"),
        ("real_credentials", "synthetic administrator credentials required"),
        ("extra_control", "invalid fixture identity"),
        ("unsafe_mode", "invalid fixture file"),
    ],
)
def test_browser_config_validation_is_explicit_private_and_network_free(
    tmp_path: Path, change: str, rejection: str | None
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
    source = Path(__file__).resolve().parents[2] / "scripts/probe_addon_browser.mjs"
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    module = scripts / source.name
    module.write_bytes(source.read_bytes())
    # Reproduce the backend CI checkout's missing frontend packages without moving
    # or removing the developer's installed dependencies.
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "const {readConfig}=await import(process.argv[1]); "
            "try { readConfig(process.argv[2]); "
            "process.stdout.write(JSON.stringify({accepted:true})); } "
            "catch(error) { process.stdout.write(JSON.stringify({accepted:false, "
            "reason:error.message})); process.exitCode=1; }",
            module.as_uri(),
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == (0 if rejection is None else 1)
    assert result.stderr == ""
    assert json.loads(result.stdout) == (
        {"accepted": True} if rejection is None else {"accepted": False, "reason": rejection}
    )
    assert "SYNTHETIC_PRIVATE_PASSWORD" not in result.stdout + result.stderr

    probe = subprocess.run(
        ["node", str(module), str(path)], capture_output=True, text=True, check=False
    )
    assert probe.returncode == 1
    assert probe.stderr == ""
    report = json.loads(probe.stdout)
    assert report["result"] == "FAIL"
    assert report["checks"] == {}
    assert report["failed_stage"] == (
        "browser_dependencies" if rejection is None else "fixture_config"
    )
    assert "SYNTHETIC_PRIVATE_PASSWORD" not in probe.stdout + probe.stderr


@pytest.mark.parametrize(
    ("case", "accepted"),
    [
        ("native_404", True),
        ("canonical_redirect", True),
        ("bare_200", False),
        ("html_404", False),
        ("script_404", False),
        ("bootstrap_fragment_404", False),
        ("dom_bootstrap_404", False),
        ("unobserved_document", False),
        ("api_after_404", False),
        ("asset_after_404", False),
        ("redirect_response", False),
        ("foreign_404", False),
        ("wrong_path_404", False),
        ("lost_query_404", False),
        ("foreign_redirect", False),
        ("wrong_path_redirect", False),
        ("lost_query_redirect", False),
        ("lost_canonical_query", False),
        ("failed_restored_session", False),
    ],
)
def test_native_routing_probe_accepts_only_measured_closed_or_canonical_outcomes(
    tmp_path: Path, case: str, accepted: bool
) -> None:
    prefix = "/api/hassio_ingress/synthetic_A-123/"
    query = "?probe=canonical%2Bsafe&repeat=one&repeat=two&escaped=%252F&empty="
    origin = "https://127.0.0.1:18123"
    observation: dict[str, Any] = {
        "status": 404,
        "redirected": False,
        "location": None,
        "url": origin + prefix[:-1] + query,
        "body": "404: Not Found",
        "committed": True,
        "bootstrapNodes": 0,
        "subresources": [],
    }
    checks: dict[str, Any] = {
        "canonical": {
            "response_status": 200,
            "redirected": False,
            "slash": True,
            "query_preserved": True,
        },
        "restored_session": {
            "status": 200,
            "runtime": "ingress",
            "mode": "read_only",
            "has_user_identity": True,
        },
    }
    if case.endswith("redirect"):
        observation.update(
            status=200,
            redirected=True,
            url=origin + prefix + query,
            body='<html><script src="assets/synthetic.js"></script></html>',
            subresources=["script", "stylesheet", "fetch"],
        )
    if case == "bare_200":
        observation["status"] = 200
    elif case == "html_404":
        observation["body"] = "<html>Jukelet</html>"
    elif case == "script_404":
        observation["body"] = '<script src="assets/synthetic.js"></script>'
    elif case == "bootstrap_fragment_404":
        observation["body"] = "<div id=root></div>"
    elif case == "dom_bootstrap_404":
        observation["bootstrapNodes"] = 1
    elif case == "unobserved_document":
        observation["committed"] = False
    elif case in {"api_after_404", "asset_after_404"}:
        observation["subresources"] = ["fetch" if case == "api_after_404" else "script"]
    elif case == "redirect_response":
        observation.update(status=302, location=prefix + query)
    elif case in {"foreign_404", "foreign_redirect"}:
        observation["url"] = observation["url"].replace(origin, "https://synthetic.invalid")
    elif case in {"wrong_path_404", "wrong_path_redirect"}:
        observation["url"] = origin + "/another/path/" + query
    elif case in {"lost_query_404", "lost_query_redirect"}:
        observation["url"] = observation["url"].replace(query, "?probe=canonical+safe")
    elif case == "lost_canonical_query":
        checks["canonical"]["query_preserved"] = False
    elif case == "failed_restored_session":
        checks["restored_session"]["status"] = 401

    source = Path(__file__).resolve().parents[2] / "scripts/probe_addon_browser.mjs"
    module = tmp_path / source.name
    module.write_bytes(source.read_bytes())
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "const {observeBareResponse,validateNativeRouting}=await import(process.argv[1]); "
            "const input=JSON.parse(process.argv[2]); "
            "try { input.checks.bare="
            "observeBareResponse(input.observation,input.prefix,input.query); "
            "validateNativeRouting(input.checks); process.stdout.write('accepted'); } "
            "catch(error) { process.stdout.write(error.message); process.exitCode=1; }",
            module.as_uri(),
            json.dumps(
                {"observation": observation, "checks": checks, "prefix": prefix, "query": query}
            ),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.stderr == ""
    assert result.returncode == (0 if accepted else 1)
    if accepted:
        assert result.stdout == "accepted"
    else:
        assert any(
            reason in result.stdout
            for reason in (
                "bare Ingress",
                "canonical Ingress page/query must remain usable",
                "canonical Ingress session must recover",
            )
        )
