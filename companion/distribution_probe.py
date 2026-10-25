"""Opt-in archive install/upgrade in actual isolated HA; no external inputs accepted."""

from __future__ import annotations

import json
import shutil
import socket
import sys
import tempfile
import zipfile
from importlib.metadata import version
from pathlib import Path
from typing import Any

from companion.dispatcher_probe import DispatcherRuntime
from companion.tests.fixtures import snapshot
from scripts.package_integration import PREFIX, build, digest, git, verify

BASELINE = "82d5445ead6574b6f85d70391bc88fd9fe3df3d1"
SOURCE = "companion/custom_components/jukelet_bridge"
REPLACEMENT = "00000000-0000-4000-8000-000000000038"


def free_port() -> int:
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        return int(reservation.getsockname()[1])


def state(runtime: DispatcherRuntime) -> dict[str, Any]:
    runtime.pipe.send({"type": "distribution_state"})
    return runtime.receive()


def status(runtime: DispatcherRuntime) -> dict[str, Any]:
    result = runtime.request("status")
    assert result["success"], result
    return result["result"]  # type: ignore[no-any-return]


def baseline_install(directory: Path) -> dict[str, str]:
    root = directory / "custom_components/jukelet_bridge"
    files: dict[str, str] = {}
    paths = (
        git(Path.cwd(), "ls-tree", "-r", "--name-only", BASELINE, "--", SOURCE)
        .decode()
        .splitlines()
    )
    for source in paths:
        name = source.removeprefix(SOURCE + "/")
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        content = git(Path.cwd(), "show", BASELINE + ":" + source)
        path.write_bytes(content)
        files[name] = digest(content)
    return files


def install(archive: Path, directory: Path) -> None:
    # Only a fresh stopped probe process/config directory calls this; no storage edits.
    verify(archive)
    root = directory / "custom_components/jukelet_bridge"
    if root.exists():
        shutil.rmtree(root)
    with zipfile.ZipFile(archive) as package:
        package.extractall(directory)
    verify(archive, root)


def loaded(runtime: DispatcherRuntime, manifest: dict[str, Any]) -> dict[str, Any]:
    observed = state(runtime)
    assert observed["version"] == manifest["integration_version"]
    assert observed["identity"]["source_commit"] == manifest["source_commit"]
    assert observed["identity"]["source_tree"] == manifest["source_tree"]
    assert {PREFIX + name: checksum for name, checksum in observed["files"].items()} == manifest[
        "files"
    ]
    assert "" in observed["loaded_modules"] and ".bridge" in observed["loaded_modules"]
    return observed


def control(runtime: DispatcherRuntime, action: str, confirm: bool = True) -> dict[str, Any]:
    def flow(data: dict[str, Any] | None = None, flow_id: str | None = None) -> dict[str, Any]:
        command: dict[str, Any] = {"type": "control_flow"}
        if data is not None:
            command["data"] = data
        if flow_id is not None:
            command["flow_id"] = flow_id
        runtime.pipe.send(command)
        response = runtime.receive()
        assert response["status"] == 200, response
        return response["body"]  # type: ignore[no-any-return]

    page = flow()
    page = flow({"next_step_id": "playback"}, page["flow_id"])
    page = flow({"next_step_id": action}, page["flow_id"])
    field = {
        "enable": "confirm_legacy_disabled",
        "reconcile": "confirm_all_stopped",
        "disable": "confirm_disable",
    }[action]
    return flow({field: confirm}, page["flow_id"])


def confirmed(runtime: DispatcherRuntime, action: str) -> None:
    result = control(runtime, action)
    assert result["step_id"] == "control_result", result
    assert "confirmed" in result["description_placeholders"]["outcome"], result
    # A fresh WS read is independent of the flow's own fresh readback.
    actual = status(runtime)
    assert actual["dispatch_enabled"] == (action == "enable"), actual


def seed(runtime: DispatcherRuntime, profile: str) -> dict[str, Any]:
    assert runtime.request("publish", snapshot=snapshot())["success"]
    replacement = snapshot(7, 1)
    replacement["publisher_id"] = REPLACEMENT
    runtime.pipe.send({"type": "distribution_recover", "snapshot": replacement})
    assert runtime.receive() == {"flow_type": "create_entry"}
    assert runtime.request(
        "configure_dispatch", profiles={"default": profile}, timeout_seconds=120
    )["success"]
    assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)["success"]
    assert runtime.request("dispatch", action="enable")["success"]
    assert len(runtime.scan([{"tag_id": "SYNTHETIC_Å"}])) == 1
    return state(runtime)


def retained(before: dict[str, Any], after: dict[str, Any]) -> None:
    for key in ("entry_id", "entry_data", "history", "snapshot", "fence"):
        assert after[key] == before[key], key


def main() -> None:
    assert len(sys.argv) == 1, (
        "No targets, existing configs, credentials or source overrides accepted"
    )
    assert version("homeassistant") == "2026.10.2"
    with tempfile.TemporaryDirectory(prefix="jukelet-distribution-") as temporary:
        root = Path(temporary)
        manifest = build(Path.cwd(), "HEAD", root / "artifacts")
        archive = root / "artifacts" / manifest["archive"]
        print(
            json.dumps(
                {"ha": version("homeassistant"), "baseline_commit": BASELINE, "artifact": manifest},
                sort_keys=True,
            ),
            flush=True,
        )
        clean = root / "clean"
        clean.mkdir()
        install(archive, clean)
        runtime = DispatcherRuntime(clean, free_port())
        try:
            loaded(runtime, manifest)
            actual = status(runtime)
            assert actual["persistence"] == "empty" and not actual["dispatch_enabled"]
            assert actual["active_revision"] is None
            assert runtime.scan([{"tag_id": "SYNTHETIC_Å"}]) == []
            assert runtime.request("publish", snapshot=snapshot())["success"]
            assert runtime.request(
                "configure_dispatch",
                profiles={"default": "script.synthetic_dispatch"},
                timeout_seconds=120,
            )["success"]
            confirmed(runtime, "reconcile")
            confirmed(runtime, "enable")
            assert len(runtime.scan([{"tag_id": "SYNTHETIC_Å"}])) == 1
            print(
                "PASS archive clean install: loaded version/source/file hashes; "
                "paired empty, disabled; "
                "#37 reconciliation/separate enable; app absent inert execution",
                flush=True,
            )
        finally:
            runtime.close()

        for scenario, profile in (
            ("healthy", "script.synthetic_dispatch"),
            ("uncertain", "script.synthetic_missing_completion"),
            ("damaged_history", "script.synthetic_dispatch"),
        ):
            directory = root / scenario
            directory.mkdir()
            hashes = baseline_install(directory)
            port = free_port()
            runtime = DispatcherRuntime(directory, port)
            try:
                original = state(runtime)
                assert original["version"] == "0.1.0" and original["files"] == hashes
                before = seed(runtime, profile)
                if scenario == "damaged_history":
                    runtime.pipe.send({"type": "distribution_damage_history"})
                    assert runtime.receive() == {"damaged": True}
                    before = state(runtime)
                runtime.close()
                install(archive, directory)
                runtime = DispatcherRuntime(directory, port)
                after = loaded(runtime, manifest)
                retained(before, after)
                actual = status(runtime)
                assert not actual["dispatch_enabled"]
                assert after["snapshot"]["revision"] == 7
                assert after["snapshot"]["payload_checksum"] == snapshot(7, 1)["payload_checksum"]
                if scenario == "damaged_history":
                    assert actual["active_revision"] is None and actual["active_checksum"] is None
                else:
                    assert actual["publisher_id"] == REPLACEMENT
                    assert actual["active_revision"] == 7
                    assert actual["active_checksum"] == snapshot(7, 1)["payload_checksum"]
                assert runtime.request("dispatch_config")["result"] == {
                    "profiles": {"default": profile},
                    "timeout_seconds": 120,
                }
                assert runtime.scan([{"tag_id": "SYNTHETIC_Å"}]) == []
                stale = snapshot(6, 7)
                stale["publisher_id"] = REPLACEMENT
                assert not runtime.request("publish", snapshot=stale)["success"]
                if scenario == "healthy":
                    assert not actual["dispatcher"]["execution_uncertain"]
                    confirmed(runtime, "enable")
                    assert len(runtime.scan([{"tag_id": "SYNTHETIC_Å"}])) == 1
                elif scenario == "uncertain":
                    assert actual["dispatcher"]["execution_uncertain"]
                    rejected = control(runtime, "enable")
                    assert "rejected" in rejected["description_placeholders"]["outcome"]
                    declined = control(runtime, "reconcile", False)
                    assert declined["errors"] == {"base": "confirmation_required"}
                    assert status(runtime)["dispatcher"]["execution_uncertain"]
                    confirmed(runtime, "reconcile")
                    assert not status(runtime)["dispatcher"]["execution_uncertain"]
                    confirmed(runtime, "enable")
                else:
                    assert (
                        actual["persistence"] == "degraded"
                        and actual["last_error"] == "storage_invalid"
                    )
                    higher = snapshot(8, 7)
                    higher["publisher_id"] = REPLACEMENT
                    rejected = runtime.request("publish", snapshot=higher)
                    assert rejected["error"]["code"] == "recovery_required", rejected
                    rejected = control(runtime, "enable")
                    assert "rejected" in rejected["description_placeholders"]["outcome"]
                    runtime.pipe.send({"type": "distribution_recover", "snapshot": higher})
                    assert runtime.receive() == {"flow_type": "abort"}
                    still_preserved = state(runtime)
                    retained(before, still_preserved)
                    assert not status(runtime)["dispatch_enabled"]
                print(
                    f"PASS baseline -> archive {scenario}: "
                    "exact publisher/history/snapshot/config/fence "
                    "preserved; revision7/checksum/profile/120s; "
                    "disabled/no replay; guarded #37 controls",
                    flush=True,
                )
            finally:
                runtime.close()


if __name__ == "__main__":
    main()
