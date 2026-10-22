"""Supported, companion-owned HA Store only. No credential-store access."""

from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

KEY = "jukelet_bridge.snapshot"


class HAStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    def _store(self) -> Store[dict[str, Any]]:
        return Store(self.hass, 1, KEY, atomic_writes=True, private=True)

    async def load(self) -> object:
        store = self._store()
        path = Path(store.path)

        def evidence_exists() -> bool:
            return path.exists() or any(path.parent.glob(KEY + ".corrupt.*"))

        existed = await self.hass.async_add_executor_job(evidence_exists)
        data = await store.async_load()
        # HA quarantines malformed JSON and returns None. Never interpret that as first install.
        if data is None and existed:
            raise ValueError("companion storage missing or corrupt")
        return data

    async def save(self, snapshot: dict[str, Any]) -> None:
        await self._store().async_save(snapshot)
        # async_save can swallow errors. Bridge requires a new Store disk readback.
