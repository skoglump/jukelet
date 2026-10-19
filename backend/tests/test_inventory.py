"""Exact identity and snapshot normalization with synthetic inventory only."""

from typing import Any

import pytest

from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import Scan, Tag
from jukelet.inventory import inventory_view


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def test_registry_timestamp_cannot_roll_back_newer_scan_and_keys_survive_restart() -> None:
    exact_id = "  Synthetic/Å  "
    first = HAAdapter(None, None)
    first.inventory = (Tag(id=exact_id, name="HA name", last_scanned="2026-10-19T14:00:00+02:00"),)
    first.observations[exact_id] = Scan(
        tag_id=exact_id,
        device_id="reader-new",
        observed_at="2026-10-19T12:01:00+00:00",
    )
    row = inventory_view(first).tags[0]
    assert row.name == "HA name"
    assert row.last_scanned == "2026-10-19T12:01:00+00:00"
    assert row.last_reader == "reader-new"
    restarted = HAAdapter(None, None)
    restarted.inventory = (Tag(id=exact_id, last_scanned="2026-10-19T14:02:00+02:00"),)
    after = inventory_view(restarted).tags[0]
    assert after.tag_key == row.tag_key
    assert after.ha_tag_id == exact_id
    assert after.last_scanned == "2026-10-19T12:02:00+00:00"
    assert after.name is None


@pytest.mark.anyio
@pytest.mark.parametrize(
    "invalid",
    [
        {"id": "x" * 513},
        {"id": "synthetic", "last_scanned": "not-a-time"},
        {"id": "synthetic", "last_scanned": "2026-10-19T12:00:00"},
        {"id": "synthetic", "name": 123},
    ],
)
async def test_malformed_inventory_keeps_timestamp_and_names(invalid: dict[str, Any]) -> None:
    class Fixture(HAAdapter):
        async def command(self, operation: str) -> Any:
            return [invalid]

    adapter = Fixture(None, None)
    adapter.inventory = (Tag(id="previous", name="Last good"),)
    adapter.status.inventory_updated_at = "2026-10-19T12:00:00+00:00"
    assert not await adapter._inventory()
    result = inventory_view(adapter)
    assert result.tags[0].name == "Last good"
    assert result.updated_at == "2026-10-19T12:00:00+00:00"
    assert result.stale and result.registry_available


@pytest.mark.anyio
@pytest.mark.parametrize(
    "out_of_range",
    ["9999-12-31T23:59:59-01:00", "0001-01-01T00:00:00+01:00"],
)
async def test_utc_overflow_retains_last_good_inventory_then_recovers(out_of_range: str) -> None:
    class Fixture(HAAdapter):
        raw: list[dict[str, str]] = [{"id": "synthetic", "name": "Last good"}]

        async def command(self, operation: str) -> Any:
            return self.raw

    adapter = Fixture(None, None)
    assert await adapter._inventory()
    previous = adapter.inventory
    updated = adapter.status.inventory_updated_at
    adapter.raw = [{"id": "synthetic", "last_scanned": out_of_range}]
    assert not await adapter._inventory()
    assert adapter.inventory == previous
    assert adapter.status.inventory_updated_at == updated
    assert adapter.status.inventory_stale
    assert adapter.status.error == "unsupported_response"
    adapter.raw = [
        {
            "id": "synthetic",
            "name": "Recovered",
            "last_scanned": "2026-10-19T14:00:00+02:00",
        }
    ]
    assert await adapter._inventory()
    assert adapter.inventory[0].name == "Recovered"
    assert adapter.inventory[0].last_scanned == "2026-10-19T12:00:00+00:00"
    assert not adapter.status.inventory_stale
    assert adapter.status.inventory_updated_at != updated
