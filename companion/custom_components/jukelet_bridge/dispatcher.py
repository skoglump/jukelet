"""Single HA-local admission, durable uncertainty fence and bounded diagnostics."""

import asyncio
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import asdict
from typing import Any

from .bridge import Bridge, Persistence
from .playback import PlaybackAdapter, ScriptTransport, _text, validate_request
from .protocol import ProtocolError, validate_snapshot

DUPLICATE_WINDOW = 2.0
MAX_DUPLICATES = 256
MAX_DIAGNOSTICS = 32


class Dispatcher:
    def __init__(
        self,
        bridge: Bridge,
        transport: ScriptTransport,
        profiles: object,
        fence: Persistence,
        script_ready: Callable[[str], bool],
        *,
        clock: Callable[[], float] = time.monotonic,
        timeout: float = 30.0,
    ) -> None:
        self.bridge, self.fence = bridge, fence
        self.adapter = PlaybackAdapter(transport, profiles, timeout=timeout)
        self.timeout = timeout
        self.profiles: dict[str, str] = dict(self.adapter._profiles)
        self.script_ready, self.clock = script_ready, clock
        self.control_lock = asyncio.Lock()
        self.enabled = False
        self.closed = False
        self.uncertain = True
        self.task: asyncio.Task[None] | None = None
        self.fence_tasks: set[asyncio.Task[None]] = set()
        self.seen: OrderedDict[tuple[str, str | None], float] = OrderedDict()
        self.diagnostics: deque[dict[str, Any]] = deque(maxlen=MAX_DIAGNOSTICS)
        bridge.dispatch_status = self.status
        bridge.dispatch_suspend = self.suspend

    def suspend(self) -> None:
        self.enabled = False

    async def start(self) -> None:
        try:
            value = await self.fence.load()
            # Missing fence is conservative, including first installation. An admin
            # must attest idle before enabling. Missing/corrupt state never resets it.
            self.uncertain = not self._valid_fence(value, False)
        except Exception:
            self.uncertain = True

    @staticmethod
    def _valid_fence(value: object, uncertain: bool) -> bool:
        return (
            type(value) is dict
            and set(value) == {"version", "uncertain"}
            and type(value["version"]) is int
            and value["version"] == 1
            and type(value["uncertain"]) is bool
            and value["uncertain"] is uncertain
        )

    @property
    def busy(self) -> bool:
        return bool(self.fence_tasks) or (self.task is not None and not self.task.done())

    def readiness(self) -> str | None:
        if self.closed or self.bridge.closed or self.bridge.stopping():
            return "shutting_down"
        if self.bridge.health != "healthy" or self.bridge.active is None:
            return "snapshot_unavailable"
        try:
            active = validate_snapshot(self.bridge.active)
        except ProtocolError:
            return "snapshot_invalid"
        if any(
            row["enabled"] and row["shuffle"] != (row["media_type"] == "playlist")
            for row in active["payload"]["mappings"]
        ):
            return "preference_conflict"
        if self.uncertain:
            return "execution_uncertain"
        script = self.profiles.get("default")
        if script is None:
            return "profile_unconfigured"
        if not self.script_ready(script):
            return "script_unavailable_or_running"
        return None

    def status(self) -> dict[str, Any]:
        reason = self.readiness()
        # Losing readiness latches disabled; publication/recovery cannot revive it.
        # A running admitted attempt has its own fence and does not disable itself.
        if reason is not None and (
            not self.busy
            or reason
            in {"snapshot_unavailable", "snapshot_invalid", "preference_conflict", "shutting_down"}
        ):
            self.enabled = False
        return {
            "dispatch_enabled": self.enabled,
            "dispatcher": {
                "ready": reason is None,
                "readiness_error": reason,
                "busy": self.busy,
                "execution_uncertain": self.uncertain,
                "configured_profiles": dict(self.profiles),
                "diagnostics": list(self.diagnostics),
                "playback_verification": "unavailable",
            },
        }

    async def _write_fence(self, uncertain: bool) -> None:
        # HA Store may write in an executor. Cancelling its waiter cannot cancel
        # that filesystem operation. Own the entire save/readback until drained.
        self.uncertain = True
        task = asyncio.create_task(self._persist_fence(uncertain))
        self.fence_tasks.add(task)
        task.add_done_callback(self._fence_finished)
        await asyncio.shield(task)

    def _fence_finished(self, task: asyncio.Task[None]) -> None:
        self.fence_tasks.discard(task)
        if not task.cancelled():
            task.exception()

    async def _persist_fence(self, uncertain: bool) -> None:
        value = {"version": 1, "uncertain": uncertain}
        await self.fence.save(value)
        if not self._valid_fence(await self.fence.load(), uncertain):
            raise ProtocolError("fence_uncertain")
        self.uncertain = uncertain

    async def control(self, action: str, confirmed_stopped: bool = False) -> dict[str, Any]:
        async with self.control_lock:
            return await self._control(action, confirmed_stopped)

    async def _control(self, action: str, confirmed_stopped: bool) -> dict[str, Any]:
        if action == "disable":
            self.enabled = False
        elif action == "reconcile":
            if self.busy or self.closed or not confirmed_stopped:
                raise ProtocolError("reconciliation_required")
            script = self.profiles.get("default")
            if script is None or not self.script_ready(script):
                raise ProtocolError("script_unavailable_or_running")
            self.enabled = False
            # Hold the admission gate during disk I/O, including concurrent controls.
            self.uncertain = True
            await self._write_fence(False)
        elif action == "enable":
            if self.busy:
                raise ProtocolError("busy")
            reason = self.readiness()
            if reason is not None:
                self.enabled = False
                raise ProtocolError(reason)
            self.enabled = True
        else:
            raise ProtocolError("invalid_control")
        return self.status()

    def _record(self, reason: str, **fields: Any) -> None:
        self.diagnostics.append({"reason": reason, **fields})

    def scan(self, event: object) -> None:
        """Synchronous admission reserves the slot before any asynchronous work."""
        if self.closed or not self.enabled:
            self._record("ignored_disabled")
            return
        if self.busy or self.control_lock.locked():
            self._record("ignored_busy")
            return
        if (
            type(event) is not dict
            or not _text(event.get("tag_id"))
            or ("device_id" in event and not _text(event["device_id"]))
            or set(event) - {"tag_id", "device_id"}
        ):
            self._record("rejected_event")
            return
        reason = self.readiness()
        if reason is not None:
            self.enabled = False
            self._record(reason)
            return
        key = (event["tag_id"], event.get("device_id"))
        now = self.clock()
        while self.seen and next(iter(self.seen.values())) + DUPLICATE_WINDOW <= now:
            self.seen.popitem(last=False)
        if key in self.seen:
            self._record("ignored_duplicate")
            return
        # Detached event scalars; no task queue and no retained raw event payload.
        self.task = asyncio.create_task(self._execute(key, now))

    async def _execute(self, key: tuple[str, str | None], now: float) -> None:
        correlation = str(uuid.uuid4())
        revision: int | None = None
        fenced = False
        try:
            active = await self.bridge.capture()
            revision = active["revision"]
            row = next(
                (row for row in active["payload"]["mappings"] if row["tag_id"] == key[0]), None
            )
            if row is None or not row["enabled"]:
                self._record("rejected_mapping")
                return
            if row["shuffle"] != (row["media_type"] == "playlist"):
                self.enabled = False
                self._record("preference_conflict")
                return
            request = {**row, "snapshot_revision": revision, "correlation_id": correlation}
            if key[1] is not None:
                request["reader_id"] = key[1]
            validate_request(request)
            # Disable/unload can happen while waiting for publication's lock.
            if not self.enabled or self.closed:
                self._record("ignored_disabled")
                return
            fenced = True
            await self._write_fence(True)
            if not self.enabled or self.closed:
                await self._write_fence(False)
                self._record("ignored_disabled")
                return
            if not self.script_ready(self.profiles["default"]):
                await self._write_fence(False)
                self.enabled = False
                self._record("script_unavailable_or_running")
                return
            self.seen[key] = now
            while len(self.seen) > MAX_DUPLICATES:
                self.seen.popitem(last=False)
            self._record(
                "invocation_requested", correlation_id=correlation, snapshot_revision=revision
            )
            result = await self.adapter.execute(request)
            self._record("execution_result", **asdict(result))
            if result.execution == "finished" or result.invocation == "rejected":
                await self._write_fence(False)
            else:
                self.enabled = False
        except asyncio.CancelledError:
            self.enabled = False
            self._record(
                "execution_cancelled",
                correlation_id=correlation,
                snapshot_revision=revision,
                execution="unknown" if fenced else "not_started",
            )
            raise
        except Exception:
            self.enabled = False
            self._record(
                "execution_error",
                correlation_id=correlation,
                snapshot_revision=revision,
                execution="unknown" if fenced else "not_started",
            )

    async def close(self) -> None:
        self.enabled = False
        self.closed = True
        if self.task is not None:
            # Never cancel a script as a substitute for proving it stopped.
            await asyncio.shield(asyncio.gather(self.task, return_exceptions=True))
        # Includes cancelled reconcile/execute waiters whose Store work remains
        # alive. No new controls or scans can start a write after closed is set.
        # Do not acquire control_lock: configuration closes while holding it.
        if self.fence_tasks:
            await asyncio.shield(asyncio.gather(*self.fence_tasks, return_exceptions=True))
