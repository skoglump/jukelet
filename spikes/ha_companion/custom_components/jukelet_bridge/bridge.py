"""Serialized persistence/readback state machine, independent of HA imports."""

import asyncio
from collections.abc import Callable
from typing import Any, Protocol

from .protocol import ProtocolError, valid_publisher, validate_snapshot


class Persistence(Protocol):
    async def load(self) -> object: ...
    async def save(self, snapshot: dict[str, Any]) -> None: ...


class Bridge:
    def __init__(self, publisher: str, store: Persistence, stopping: Callable[[], bool]) -> None:
        if not valid_publisher(publisher):
            raise ValueError("invalid configured publisher")
        self.publisher = publisher
        self.store = store
        self.stopping = stopping
        self.active: dict[str, Any] | None = None
        self.health = "empty"
        self.error: str | None = None
        self.lock = asyncio.Lock()
        self.tasks: set[asyncio.Task[dict[str, Any]]] = set()

    async def start(self) -> None:
        async with self.lock:
            try:
                data = await self.store.load()
                if data is not None:
                    snapshot = validate_snapshot(data)
                    if snapshot["publisher_id"] != self.publisher:
                        raise ProtocolError("publisher_mismatch")
                    self.active = snapshot
                    self.health = "healthy"
            except Exception:
                self.health, self.error = "degraded", "storage_invalid"

    def _status(self) -> dict[str, Any]:
        return {
            "protocol_version": 1,
            "schema_version": 1,
            "publisher_id": self.publisher,
            "active_revision": self.active["revision"] if self.active else None,
            "active_checksum": self.active["payload_checksum"] if self.active else None,
            "mapping_count": len(self.active["payload"]["mappings"]) if self.active else 0,
            "persistence": self.health,
            "last_error": self.error,
            "dispatch_enabled": False,
            "supported_media": ["album", "playlist"],
            "supported_preferences": ["enabled", "shuffle"],
            "playback_profiles": ["default"],
        }

    async def status(self) -> dict[str, Any]:
        async with self.lock:
            return self._status()

    async def publish(self, value: object) -> dict[str, Any]:
        if len(self.tasks) >= 4:
            raise ProtocolError("busy")
        snapshot = validate_snapshot(value)
        task = asyncio.create_task(self._publish(snapshot))
        self.tasks.add(task)
        task.add_done_callback(self._finished)
        return await asyncio.shield(task)

    def _finished(self, task: asyncio.Task[dict[str, Any]]) -> None:
        self.tasks.discard(task)
        if not task.cancelled():
            task.exception()  # Retrieve failures even if the disconnected caller was cancelled.

    async def _publish(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            if self.stopping():
                raise ProtocolError("shutting_down")
            if self.health == "degraded":
                raise ProtocolError("recovery_required")
            if snapshot["publisher_id"] != self.publisher:
                raise ProtocolError("publisher_mismatch")
            active_revision = self.active["revision"] if self.active else None
            if self.active and snapshot["revision"] == active_revision:
                if snapshot["payload_checksum"] != self.active["payload_checksum"]:
                    raise ProtocolError("revision_conflict")
                return self._status()
            if self.active and snapshot["revision"] < active_revision:
                raise ProtocolError("stale_revision")
            if snapshot["expected_active_revision"] != active_revision:
                raise ProtocolError("base_conflict")
            try:
                await self.store.save(snapshot)
                observed = await self.store.load()
            except Exception as exc:
                self.health, self.error = "degraded", "persistence_uncertain"
                raise ProtocolError("persistence_uncertain") from exc
            if observed != snapshot:
                self.error = "persistence_failed"
                if observed != self.active:
                    self.health, self.error = "degraded", "persistence_uncertain"
                raise ProtocolError(self.error)
            if self.stopping():
                self.health, self.error = "degraded", "persistence_uncertain"
                raise ProtocolError("persistence_uncertain")
            self.active = snapshot
            self.health, self.error = "healthy", None
            return self._status()
