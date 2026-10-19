"""Read models derived from HA snapshots; no assignment persistence."""

import hashlib
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel

if TYPE_CHECKING:
    from jukelet.ha.adapter import HAAdapter


def tag_key(tag_id: str) -> str:
    return hashlib.sha256(tag_id.encode("utf-8")).hexdigest()


class InventoryTag(BaseModel):
    tag_key: str
    ha_tag_id: str
    name: str | None = None
    last_scanned: str | None = None
    last_reader: str | None = None
    state: Literal["registered", "pending_discovery"] = "registered"


class InventoryView(BaseModel):
    tags: list[InventoryTag]
    total: int
    registry_available: bool
    stale: bool
    updated_at: str | None
    discovery_gap: bool


def inventory_view(ha: HAAdapter, offset: int = 0, limit: int = 100) -> InventoryView:
    rows = {
        tag.id: InventoryTag(
            tag_key=tag_key(tag.id), ha_tag_id=tag.id, name=tag.name, last_scanned=tag.last_scanned
        )
        for tag in ha.inventory
    }
    for scan in ha.observations.values():
        row = rows.setdefault(
            scan.tag_id,
            InventoryTag(
                tag_key=tag_key(scan.tag_id), ha_tag_id=scan.tag_id, state="pending_discovery"
            ),
        )
        if row.last_scanned is None or scan.observed_at >= row.last_scanned:
            row.last_scanned = scan.observed_at
            row.last_reader = scan.device_id
    ordered = sorted(rows.values(), key=lambda row: row.ha_tag_id)
    return InventoryView(
        tags=ordered[offset : offset + limit],
        total=len(ordered),
        registry_available=ha.status.inventory_updated_at is not None,
        stale=ha.status.inventory_stale,
        updated_at=ha.status.inventory_updated_at,
        discovery_gap=ha.status.discovery_gap,
    )
