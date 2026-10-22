"""Deterministic persistence fault/concurrency fixtures; not HA runtime evidence."""

import copy
from typing import Any

from companion.custom_components.jukelet_bridge.protocol import PUBLISHER, checksum


def snapshot(revision: int = 1, expected: int | None = None) -> dict[str, Any]:
    payload = {
        "mappings": [
            {
                "tag_id": "SYNTHETIC_Å",
                "media_type": "album",
                "spotify_uri": "spotify:album:" + "A" * 22,
                "enabled": True,
                "shuffle": False,
                "playback_profile_id": "default",
            }
        ]
    }
    return {
        "schema_version": 1,
        "publisher_id": PUBLISHER,
        "revision": revision,
        "expected_active_revision": expected,
        "payload": payload,
        "payload_checksum": checksum(payload),
    }


class MemoryStore:
    def __init__(self) -> None:
        self.data: object = None
        self.saves = 0
        self.swallow_failure = False

    async def load(self) -> object:
        return copy.deepcopy(self.data)

    async def save(self, value: dict[str, Any]) -> None:
        self.saves += 1
        if not self.swallow_failure:
            self.data = copy.deepcopy(value)
