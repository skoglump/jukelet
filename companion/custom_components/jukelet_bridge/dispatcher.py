"""Single HA-local admission, durable uncertainty fence and bounded diagnostics."""

import asyncio
import copy
import hashlib
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, TypeGuard

from .bridge import Bridge, Persistence
from .playback import PlaybackAdapter, ScriptTransport, _text, validate_request
from .protocol import ProtocolError, canonical, validate_snapshot

DUPLICATE_WINDOW = 2.0
MAX_DUPLICATES = 256
MAX_DIAGNOSTICS = 32


@dataclass(frozen=True)
class ControlReview:
    instance: str
    signature: str
    expires_at: float


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
        activation: Persistence | None = None,
    ) -> None:
        self.bridge, self.fence = bridge, fence
        self.adapter = PlaybackAdapter(transport, profiles, timeout=timeout)
        self.timeout = timeout
        self.profiles: dict[str, str] = dict(self.adapter._profiles)
        self.script_ready, self.clock = script_ready, clock
        self.control_lock = asyncio.Lock()
        self.control_instance = str(uuid.uuid4())
        self.control_generation = 0
        self.activation = activation
        self.activation_lock = asyncio.Lock()
        self.resume_record: dict[str, Any] | None = None
        self.resume_pending = False
        self.enabled = False
        self.closed = False
        self.uncertain = True
        self.task: asyncio.Task[None] | None = None
        self.fence_tasks: set[asyncio.Task[None]] = set()
        self.seen: OrderedDict[tuple[str, str | None], float] = OrderedDict()
        self.diagnostics: deque[dict[str, Any]] = deque(maxlen=MAX_DIAGNOSTICS)
        self.operational_records: deque[dict[str, str]] = deque(maxlen=MAX_DIAGNOSTICS)
        self.started_at = self._timestamp()
        self.last_scan_at: str | None = None
        self.last_attempt: dict[str, Any] | None = None
        self.pause_reason: str | None = "startup"
        bridge.dispatch_status = self.status
        bridge.dispatch_suspend = self.suspend
        bridge.dispatch_checkpoint = self.checkpoint

    def suspend(self) -> None:
        if self.closed:
            return  # Shutdown preserves the last reviewed idle choice.
        self.control_generation += 1
        self._pause("snapshot_changed")

    def _pause(self, reason: str) -> asyncio.Task[None] | None:
        remembered = self.enabled or bool(self.resume_record and self.resume_record["enabled"])
        self.enabled = False
        self.resume_pending = False
        self.pause_reason = reason
        if (
            remembered
            and reason != "shutting_down"
            and not self.closed
            and self.activation is not None
        ):
            return self._activation_task(False)
        return None

    def _activation_identity(self) -> str:
        # A partial restore, recovery/replacement or local script/timeout change
        # cannot reuse consent for a different execution configuration.
        return hashlib.sha256(
            canonical(
                {
                    "snapshot": self.bridge._recovery_precondition(),
                    "profiles": self.profiles,
                    "timeout": self.timeout,
                }
            )
        ).hexdigest()

    @staticmethod
    def _valid_activation(value: object) -> TypeGuard[dict[str, Any]]:
        return (
            type(value) is dict
            and set(value) == {"version", "enabled", "identity"}
            and type(value["version"]) is int
            and value["version"] == 1
            and type(value["enabled"]) is bool
            and (
                (not value["enabled"] and value["identity"] is None)
                or (
                    value["enabled"]
                    and type(value["identity"]) is str
                    and len(value["identity"]) == 64
                    and all(c in "0123456789abcdef" for c in value["identity"])
                )
            )
        )

    def _activation_task(self, enabled: bool) -> asyncio.Task[None]:
        value = {
            "version": 1,
            "enabled": enabled,
            "identity": self._activation_identity() if enabled else None,
        }
        # Update the local intent immediately; serialize owned disk operations so
        # cancellation or a later disable cannot reorder the durable choice.
        self.resume_record = value
        task = asyncio.create_task(self._persist_activation(value))
        self.fence_tasks.add(task)
        task.add_done_callback(self._fence_finished)
        return task

    async def _persist_activation(self, value: dict[str, Any]) -> None:
        if self.activation is None:
            return
        async with self.activation_lock:
            try:
                await self.activation.save(value)
                actual = await self.activation.load()
                if not self._valid_activation(actual) or actual != value:
                    raise ProtocolError("activation_uncertain")
            except Exception as exc:
                self.enabled = False
                self.resume_pending = False
                self.pause_reason = "readiness_lost"
                raise ProtocolError("activation_uncertain") from exc

    async def checkpoint(self) -> None:
        """Called under the bridge lock after a normal durable publication."""
        if self.activation is not None:
            reason = self.readiness()
            if reason is not None and not (self.busy and reason == "execution_uncertain"):
                self._pause("readiness_lost")
            enabled = self.enabled and reason is None and not self.busy
            await asyncio.shield(self._activation_task(enabled))

    async def resume_after_startup(self) -> None:
        """One startup-only attempt; never infer stopped work or retry playback."""
        async with self.control_lock, self.bridge.lock:
            if not self.resume_pending:
                return
            self.resume_pending = False
            self.control_generation += 1
            if (
                self.resume_record is None
                or self.resume_record["identity"] != self._activation_identity()
                or self.readiness() is not None
                or self.busy
            ):
                pending = self._pause("readiness_lost")
                if pending is not None:
                    await asyncio.shield(asyncio.gather(pending, return_exceptions=True))
                return
            self.enabled = True
            self.pause_reason = None

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(UTC).isoformat()

    def operational_diagnostics(self) -> dict[str, Any]:
        """Pure versioned read; never runs the mutating v1 status latch or controls."""
        reason = self.readiness()
        return {
            "diagnostics_version": 1,
            "started_at": self.started_at,
            "observed_at": self._timestamp(),
            "dispatch_enabled": self.enabled,
            "ready": reason is None,
            "readiness_error": reason,
            "busy": self.busy,
            "execution_uncertain": self.uncertain,
            "pause_reason": self.pause_reason,
            "last_scan_at": self.last_scan_at,
            "last_attempt": copy.deepcopy(self.last_attempt),
            "diagnostics": copy.deepcopy(list(self.operational_records)),
            "playback_verification": "unavailable",
        }

    async def start(self) -> None:
        try:
            value = await self.fence.load()
            # Missing fence is conservative, including first installation. An admin
            # must attest idle before enabling. Missing/corrupt state never resets it.
            self.uncertain = not self._valid_fence(value, False)
        except Exception:
            self.uncertain = True
        if self.activation is not None:
            try:
                value = await self.activation.load()
                if self._valid_activation(value):
                    self.resume_record = value
                    self.resume_pending = value["enabled"]
            except Exception:
                pass  # Missing/corrupt/unreadable consent never enables dispatch.

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
            if self.enabled:
                # Core may enter stopping before our stop listener. Pause
                # admission without revoking the idle reviewed restart choice.
                self._pause("shutting_down" if reason == "shutting_down" else "readiness_lost")
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

    def _control_signature(self) -> str:
        # Publication identity, history and persistence share the bridge lock.
        # Exclude scan-only diagnostics and timestamps, but detect an intervening
        # operation even if enabled/disabled state returns to its former value.
        script = self.profiles.get("default")
        state = {
            "bridge": self.bridge._recovery_precondition(),
            "generation": self.control_generation,
            "enabled": self.enabled,
            "busy": self.busy,
            "uncertain": self.uncertain,
            "closed": self.closed,
            "profiles": self.profiles,
            "timeout": self.timeout,
            "script_ready": script is not None and self.script_ready(script),
        }
        return hashlib.sha256(canonical(state)).hexdigest()

    async def review_control(self) -> ControlReview:
        async with self.bridge.lock:
            return ControlReview(
                self.control_instance, self._control_signature(), self.clock() + 60
            )

    async def guarded_control(
        self,
        action: str,
        reviewed: ControlReview,
        *,
        confirmed_stopped: bool = False,
        confirmed_exclusive_dispatcher: bool = False,
    ) -> dict[str, Any]:
        # A competing operator must review the result, never queue an old intent.
        if self.control_lock.locked() or self.bridge.lock.locked():
            raise ProtocolError("busy")
        async with self.control_lock, self.bridge.lock:
            if (
                reviewed.instance != self.control_instance
                or self.clock() >= reviewed.expires_at
                or reviewed.signature != self._control_signature()
            ):
                raise ProtocolError("stale_state")
            if (action == "reconcile" and confirmed_stopped is not True) or (
                action == "enable" and confirmed_exclusive_dispatcher is not True
            ):
                raise ProtocolError("confirmation_required")
            return await self._control(action, confirmed_stopped)

    async def control(self, action: str, confirmed_stopped: bool = False) -> dict[str, Any]:
        async with self.control_lock:
            if action == "enable":
                async with self.bridge.lock:
                    return await self._control(action, confirmed_stopped)
            return await self._control(action, confirmed_stopped)

    async def _control(self, action: str, confirmed_stopped: bool) -> dict[str, Any]:
        if self.closed:
            raise ProtocolError("shutting_down")
        self.control_generation += 1
        self.resume_pending = False
        if action == "disable":
            self.enabled = False
            self.pause_reason = "administrator_disabled"
            await asyncio.shield(self._activation_task(False))
        elif action == "reconcile":
            if self.busy or self.closed or not confirmed_stopped:
                raise ProtocolError("reconciliation_required")
            script = self.profiles.get("default")
            if script is None or not self.script_ready(script):
                raise ProtocolError("script_unavailable_or_running")
            self.enabled = False
            self.pause_reason = "administrator_disabled"
            await asyncio.shield(self._activation_task(False))
            # Hold the admission gate during disk I/O, including concurrent controls.
            if self.closed:
                raise ProtocolError("shutting_down")
            self.uncertain = True
            await self._write_fence(False)
        elif action == "enable":
            if self.busy:
                raise ProtocolError("busy")
            reason = self.readiness()
            if reason is not None:
                self.enabled = False
                raise ProtocolError(reason)
            generation = self.control_generation
            await asyncio.shield(self._activation_task(True))
            if generation != self.control_generation or self.readiness() is not None:
                self._pause("readiness_lost")
                raise ProtocolError("stale_state")
            self.enabled = True
            self.pause_reason = None
        else:
            raise ProtocolError("invalid_control")
        return self.status()

    def _record(self, reason: str, **fields: Any) -> None:
        self.diagnostics.append({"reason": reason, **fields})
        at = self._timestamp()
        self.operational_records.append({"reason": reason, "observed_at": at})
        if reason == "invocation_requested":
            self.last_attempt = {
                **fields,
                "requested_at": at,
                "completed_at": None,
                "invocation": "requested",
                "execution": "unknown",
                "error": None,
                "playback_verification": "unavailable",
            }
        elif reason in {"execution_result", "execution_cancelled", "execution_error"}:
            # Pre-invocation failures have no requested attempt to correlate.
            if self.last_attempt and self.last_attempt["correlation_id"] == fields.get(
                "correlation_id"
            ):
                self.last_attempt.update(fields, completed_at=at)
                if reason != "execution_result":
                    self.last_attempt.update(invocation="unknown", error=reason)
            if (
                self.uncertain
                and fields.get("execution") != "finished"
                and fields.get("invocation") != "rejected"
            ):
                self.pause_reason = "execution_uncertain"

    def scan(self, event: object) -> None:
        """Synchronous admission reserves the slot before any asynchronous work."""
        valid_event = (
            type(event) is dict
            and _text(event.get("tag_id"))
            and ("device_id" not in event or _text(event["device_id"]))
            and not set(event) - {"tag_id", "device_id"}
        )
        if valid_event:
            self.last_scan_at = self._timestamp()
        if self.closed or not self.enabled:
            self._record("ignored_disabled")
            return
        if self.busy or self.control_lock.locked():
            self._record("ignored_busy")
            return
        if type(event) is not dict or not valid_event:
            self._record("rejected_event")
            return
        reason = self.readiness()
        if reason is not None:
            self._pause("shutting_down" if reason == "shutting_down" else "readiness_lost")
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
        self.control_generation += 1
        self.task = asyncio.create_task(self._execute(key, now))

    async def _execute(self, key: tuple[str, str | None], now: float) -> None:
        correlation = str(uuid.uuid4())
        revision: int | None = None
        fenced = False
        try:
            active = await self.bridge.capture()
            revision = active["revision"]
            row = next(
                (row for row in active["payload"]["mappings"] if row["tag_id"] == key[0]),
                None,
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
            # While work may be in flight the persisted choice is disabled. A
            # crash, failed completion or reconciliation cannot restore it.
            await asyncio.shield(self._activation_task(False))
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
                "invocation_requested",
                correlation_id=correlation,
                snapshot_revision=revision,
            )
            result = await self.adapter.execute(request)
            self._record("execution_result", **asdict(result))
            if result.execution == "finished" or result.invocation == "rejected":
                await self._write_fence(False)
                async with self.bridge.lock:
                    if self.enabled and self.readiness() is None:
                        await asyncio.shield(self._activation_task(True))
                self.pause_reason = None if self.enabled else self.pause_reason
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
        self.resume_pending = False
        self.enabled = False
        self.pause_reason = "shutting_down"
        self.closed = True
        if self.task is not None:
            # Never cancel a script as a substitute for proving it stopped.
            await asyncio.shield(asyncio.gather(self.task, return_exceptions=True))
        # Includes cancelled reconcile/execute waiters whose Store work remains
        # alive. No new controls or scans can start a write after closed is set.
        # Do not acquire control_lock: configuration closes while holding it.
        if self.fence_tasks:
            await asyncio.shield(asyncio.gather(*self.fence_tasks, return_exceptions=True))
