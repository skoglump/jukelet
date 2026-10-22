"""Serialized publication and explicit recovery with a durable revision journal."""

import asyncio
import copy
import hashlib
from collections.abc import Callable
from typing import Any, Protocol, cast

from .protocol import MAX_REVISION, ProtocolError, canonical, valid_publisher, validate_snapshot

MAX_PUBLISHERS = 32


class Persistence(Protocol):
    async def load(self) -> object: ...
    async def save(self, snapshot: dict[str, Any]) -> None: ...


class Bridge:
    def __init__(
        self, publisher: str, store: Persistence, stopping: Callable[[], bool], history: Persistence
    ) -> None:
        if not valid_publisher(publisher):
            raise ValueError("invalid configured publisher")
        self.publisher = publisher
        self.store, self.history, self.stopping = store, history, stopping
        self.active: dict[str, Any] | None = None
        self.journal: dict[str, Any] | None = None
        self.health = "degraded"
        self.error: str | None = "storage_invalid"
        self.lock = asyncio.Lock()
        self.tasks: set[asyncio.Task[dict[str, Any]]] = set()
        self.closed = False

    async def initialize(self) -> None:
        """Only explicit first pairing calls this, before creating the config entry."""
        async with self.lock:
            if await self.history.load() is not None or await self.store.load() is not None:
                raise ProtocolError("recovery_required")
            journal = {
                "version": 1,
                "publisher_id": self.publisher,
                "publishers": {self.publisher: 0},
                "head": None,
            }
            await self._save_verified(self.history, journal)
            self.journal = journal
            self.health, self.error = "empty", None

    async def reattach(self) -> None:
        """Explicitly reconnect an entry to intact history without writing either store."""
        requested = self.publisher
        await self.start()
        if self.journal is None or self.publisher != requested:
            raise ProtocolError("recovery_required")

    def _validate_history(self, data: object) -> dict[str, Any]:
        if (
            type(data) is not dict
            or set(data) != {"version", "publisher_id", "publishers", "head"}
            or type(data["version"]) is not int
            or data["version"] != 1
            or not valid_publisher(data["publisher_id"])
        ):
            raise ValueError("invalid history")
        publishers = data["publishers"]
        if type(publishers) is not dict or not 1 <= len(publishers) <= MAX_PUBLISHERS:
            raise ValueError("invalid history")
        if (
            self.publisher not in publishers
            or data["publisher_id"] not in publishers
            or any(
                not valid_publisher(key) or type(value) is not int or not 0 <= value <= MAX_REVISION
                for key, value in publishers.items()
            )
        ):
            raise ValueError("invalid history")
        head = data["head"]
        if head is None:
            if publishers != {data["publisher_id"]: 0}:
                raise ValueError("invalid history")
        elif (
            type(head) is not dict
            or set(head) != {"revision", "checksum"}
            or type(head["revision"]) is not int
            or head["revision"] != publishers[data["publisher_id"]]
            or any(
                head["revision"] <= revision
                for publisher, revision in publishers.items()
                if publisher != data["publisher_id"]
            )
            or not 1 <= head["revision"] <= MAX_REVISION
            or type(head["checksum"]) is not str
            or len(head["checksum"]) != 64
            or any(c not in "0123456789abcdef" for c in head["checksum"])
        ):
            raise ValueError("invalid history")
        return copy.deepcopy(data)

    async def start(self) -> None:
        async with self.lock:
            self.health, self.error = "degraded", "storage_invalid"
            try:
                self.journal = self._validate_history(await self.history.load())
                self.publisher = self.journal["publisher_id"]
                data = await self.store.load()
                if data is None and self.journal["head"] is None:
                    self.health, self.error = "empty", None
                    return
                snapshot = validate_snapshot(data)
                if snapshot["publisher_id"] != self.publisher:
                    # A partial restore may have lost replacement/retired identities.
                    # Treat the journal as unusable for writes until coherent restoration.
                    self.journal = None
                    raise ProtocolError("publisher_mismatch")
                # Retain valid old content diagnostically, without certifying newer history.
                self.active = snapshot
                if self._identity(snapshot) != self.journal["head"]:
                    raise ProtocolError("recovery_required")
                self.health, self.error = "healthy", None
            except Exception:
                pass  # Only bounded diagnostics escape; startup never resets storage.

    @staticmethod
    def _identity(snapshot: dict[str, Any]) -> dict[str, Any]:
        return {"revision": snapshot["revision"], "checksum": snapshot["payload_checksum"]}

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

    async def recovery_view(self) -> dict[str, Any]:
        async with self.lock:
            state = {"status": self._status(), "history": self.journal}
            return {
                **state,
                "revision_floor": self._revision_floor(),
                "precondition": hashlib.sha256(canonical(state)).hexdigest(),
            }

    def _revision_floor(self) -> int | None:
        if self.journal is None:
            return None
        return cast(
            int,
            max(
                *self.journal["publishers"].values(),
                self.active["revision"] if self.active else 0,
            ),
        )

    async def publish(self, value: object) -> dict[str, Any]:
        return await self._admit(validate_snapshot(value), None)

    async def recover(self, value: object, precondition: str) -> dict[str, Any]:
        return await self._admit(validate_snapshot(value), precondition)

    async def _admit(self, snapshot: dict[str, Any], recovery: str | None) -> dict[str, Any]:
        if self.closed:
            raise ProtocolError("shutting_down")
        if len(self.tasks) >= 4:
            raise ProtocolError("busy")
        task = asyncio.create_task(self._publish(snapshot, recovery))
        self.tasks.add(task)
        task.add_done_callback(self._finished)
        return await asyncio.shield(task)

    def _finished(self, task: asyncio.Task[dict[str, Any]]) -> None:
        self.tasks.discard(task)
        if not task.cancelled():
            task.exception()

    async def close(self) -> None:
        self.closed = True
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

    async def _save_verified(self, store: Persistence, value: dict[str, Any]) -> None:
        await store.save(value)
        if await store.load() != value or self.stopping():
            raise ProtocolError("persistence_uncertain")

    async def _publish(self, snapshot: dict[str, Any], recovery: str | None) -> dict[str, Any]:
        async with self.lock:
            if self.stopping() or self.closed:
                raise ProtocolError("shutting_down")
            if self.journal is None:
                raise ProtocolError("recovery_required")
            publisher = snapshot["publisher_id"]
            revision = snapshot["revision"]
            active_revision = self.active["revision"] if self.active else None
            journal = copy.deepcopy(self.journal)
            if recovery is not None:
                if self.error == "persistence_uncertain":
                    raise ProtocolError("recovery_required")
                state = {"status": self._status(), "history": self.journal}
                if recovery != hashlib.sha256(canonical(state)).hexdigest():
                    raise ProtocolError("base_conflict")
                if publisher != self.publisher:
                    if publisher in journal["publishers"]:
                        raise ProtocolError("publisher_mismatch")
                    if len(journal["publishers"]) >= MAX_PUBLISHERS:
                        raise ProtocolError("history_full")
                    journal["publishers"][publisher] = 0
                floor = self._revision_floor()
                if floor is None or revision <= floor:
                    raise ProtocolError("stale_revision")
            else:
                if self.health == "degraded":
                    raise ProtocolError("recovery_required")
                if publisher != self.publisher:
                    raise ProtocolError("publisher_mismatch")
                if self.active and revision == active_revision:
                    if snapshot["payload_checksum"] != self.active["payload_checksum"]:
                        raise ProtocolError("revision_conflict")
                    return self._status()
                if revision <= journal["publishers"][publisher]:
                    raise ProtocolError("stale_revision")
            if snapshot["expected_active_revision"] != active_revision:
                raise ProtocolError("base_conflict")
            journal["publisher_id"] = publisher
            journal["publishers"][publisher] = revision
            journal["head"] = self._identity(snapshot)
            try:
                # Reserve history first. An interrupted reservation fences restart.
                await self._save_verified(self.history, journal)
                self.journal = journal
                self.publisher = publisher
                await self._save_verified(self.store, snapshot)
            except Exception as exc:
                self.health, self.error = "degraded", "persistence_uncertain"
                # Reconcile disk afresh on restart; do not repair a possibly later write here.
                raise ProtocolError("persistence_uncertain") from exc
            self.active = snapshot
            self.health, self.error = "healthy", None
            return self._status()
