"""Synthetic diagnostics reads never acquire execution or publication authority."""

import copy
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import pytest
from fastapi.testclient import TestClient
from test_assignments import login
from test_publication_bridge import fixture

from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.main import create_app
from jukelet.playback_status import Diagnostics, PlaybackStatus


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def diagnostic() -> dict[str, Any]:
    at = datetime.now(UTC).isoformat()
    return {
        "diagnostics_version": 1,
        "started_at": at,
        "observed_at": at,
        "dispatch_enabled": False,
        "ready": True,
        "readiness_error": None,
        "busy": False,
        "execution_uncertain": False,
        "pause_reason": "startup",
        "last_scan_at": None,
        "last_attempt": None,
        "diagnostics": [],
        "playback_verification": "unavailable",
    }


def test_diagnostics_is_authenticated_read_only_and_honest_without_ha(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/playback-status").status_code == 401
        login(client, settings)
        result = client.get("/api/v1/playback-status")
        assert result.status_code == 200
        assert result.json()["connection"] == "not_configured"
        assert result.json()["stale"] is True
        assert result.json()["diagnostics"] is None
        assert (
            client.post(
                "/api/v1/playback-status", headers={"Origin": settings.public_origin}
            ).status_code
            == 405
        )


@pytest.mark.anyio
@pytest.mark.parametrize("transport", ["direct", "supervisor"])
async def test_real_adapter_read_validates_and_preserves_only_stale_last_good(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    transport: Literal["direct", "supervisor"],
) -> None:
    settings = replace(settings, ha_transport=transport)
    async with fixture(settings, monkeypatch) as (client, fake, _):
        fake.diagnostics = diagnostic()
        before = await fake.bridge.status()
        result = (await client.get("/api/v1/playback-status")).json()
        assert not result["stale"] and result["diagnostics"]["ready"]
        at = result["checked_at"]
        fake.diagnostics = {**diagnostic(), "raw_private": "must never reach browser"}
        stale = (await client.get("/api/v1/playback-status")).json()
        assert stale["stale"] and stale["error"] == "unsupported_response"
        assert stale["checked_at"] == at
        assert "must never reach browser" not in str(stale)
        assert before == await fake.bridge.status()
        assert set(fake.commands) <= {
            "tag/list",
            "subscribe_events",
            "jukelet_bridge/status",
            "jukelet_bridge/diagnostics",
        }
        assert fake.payloads == []
        # Unsupported diagnostics do not poison existing publication compatibility.
        assert not (await client.get("/api/v1/publication")).json()["actual_stale"]


@pytest.mark.parametrize(
    "changed",
    [
        {"diagnostics_version": True},
        {"diagnostics_version": 2},
        {"ready": 1},
        {"observed_at": "2026-10-25"},
        {"readiness_error": "private exception text"},
        {"diagnostics": [{"observed_at": "2026-10-25T00:00:00Z", "reason": "secret"}]},
        {"diagnostics": [None] * 33},
        {"playback_verification": "verified"},
    ],
)
def test_strict_bounded_diagnostics(changed: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        Diagnostics.model_validate({**diagnostic(), **changed})


def test_specific_failures_require_a_coherent_correlated_attempt() -> None:
    value = diagnostic()
    value["last_attempt"] = {
        "correlation_id": "00000000-0000-4000-8000-000000000036",
        "snapshot_revision": 1,
        "requested_at": value["observed_at"],
        "completed_at": value["observed_at"],
        "invocation": "accepted",
        "execution": "failed",
        "error": "readiness_failed",
        "playback_verification": "unavailable",
    }
    assert Diagnostics.model_validate(value).last_attempt is not None
    for field, bad in (
        ("snapshot_revision", True),
        ("correlation_id", "private-tag"),
        ("execution", "unknown"),
        ("invocation", "unknown"),
        ("error", "raw exception"),
        ("requested_at", "2026-10-25"),
    ):
        changed = copy.deepcopy(value)
        changed["last_attempt"][field] = bad
        with pytest.raises(ValueError):
            Diagnostics.model_validate(changed)


@pytest.mark.anyio
async def test_expired_future_and_generation_changed_reads_never_certify_current_health(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = HAAdapter(None, None)
    adapter.status.connection = "connected"
    reader = PlaybackStatus(adapter)
    value = diagnostic()

    async def read() -> dict[str, Any]:
        return value

    monkeypatch.setattr(adapter, "playback_diagnostics", read)
    assert not (await reader.refresh())["stale"]
    for seconds in (-31, 6):
        value = diagnostic()
        at = (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()
        value.update(started_at=at, observed_at=at)
        assert (await reader.refresh())["stale"]

    async def changed_generation() -> dict[str, Any]:
        adapter.generation += 1
        return diagnostic()

    monkeypatch.setattr(adapter, "playback_diagnostics", changed_generation)
    assert (await reader.refresh())["stale"]
    adapter.status.connection = "disconnected"
    assert (await reader.refresh())["stale"]
