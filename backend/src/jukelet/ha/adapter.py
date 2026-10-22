"""One lifespan-owned connection with bounded requests and explicit freshness."""

import asyncio
import json
import logging
import random
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from pydantic import TypeAdapter, ValidationError
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from jukelet.ha.models import (
    DEADLINE,
    MAX_BYTES,
    MAX_TAGS,
    Capability,
    ErrorCode,
    HAError,
    HAStatus,
    Scan,
    Tag,
    timestamp,
)
from jukelet.ha.rest import SERVICE_FIELDS, RestClient, capabilities

# WebSocket debug logging includes authentication frames. Never forward these logs.
WIRE_LOGGER = logging.Logger("jukelet.ha.wire")
WIRE_LOGGER.disabled = True


def websocket_endpoint(origin: str) -> str:
    parsed = urlsplit(origin)
    return urlunsplit(
        ("wss" if parsed.scheme == "https" else "ws", parsed.netloc, "/api/websocket", "", "")
    )


class OriginConnection(connect):
    def process_redirect(self, exc: Exception) -> Exception | str:
        return exc


class HAAdapter:
    def __init__(
        self,
        origin: str | None,
        token: str | None,
        *,
        rest: RestClient | None = None,
        timeout: float = DEADLINE,
        legacy_entity: str | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self.origin = origin
        self._token = token
        self.rest = rest
        self.timeout = timeout
        self.legacy_entity = legacy_entity
        self.sleep = sleep
        self.status = HAStatus(services={name: Capability() for name in SERVICE_FIELDS})
        self.inventory: tuple[Tag, ...] = ()
        self.observations: dict[str, Scan] = {}
        self.scans: asyncio.Queue[Scan] = asyncio.Queue(maxsize=128)
        self._refresh = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._socket: ClientConnection | None = None
        self.generation = 0
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._subscription: int | None = None
        self._slots = asyncio.Semaphore(32)
        self._inventory_lock = asyncio.Lock()

    def start(self) -> None:
        if self.origin and self._token and self._task is None:
            self.rest = self.rest or RestClient(
                self.origin, self._token, legacy_entity=self.legacy_entity
            )
            self.status.connection = "connecting"
            self._task = asyncio.create_task(self._run())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        if self.rest:
            await self.rest.close()

    def snapshot(self) -> HAStatus:
        return self.status.model_copy(deep=True)

    async def command(self, operation: str) -> Any:
        commands: dict[str, dict[str, str]] = {
            "tag/list": {"type": "tag/list"},
            "subscribe_scans": {"type": "subscribe_events", "event_type": "tag_scanned"},
        }
        if operation == "subscribe_scans" and self._subscription is not None:
            raise HAError("unsupported_operation")
        if operation not in commands:
            raise HAError("unsupported_operation")
        return await self._request(commands[operation])

    async def update_tag_name(self, tag_id: str, name: str) -> None:
        """Narrow mutation; callers must enforce authorization and verify readback."""
        await self._request({"type": "tag/update", "tag_id": tag_id, "name": name})

    async def bridge_status(self) -> Any:
        return await self._request({"type": "jukelet_bridge/status"})

    async def publish_snapshot(self, snapshot: dict[str, Any], generation: int) -> Any:
        """Only immutable snapshot publication; no dispatcher/playback API is exposed."""
        if generation != self.generation:
            raise HAError("unavailable")
        return await self._request({"type": "jukelet_bridge/publish", "snapshot": snapshot})

    async def _request(self, payload: dict[str, Any]) -> Any:
        try:
            async with asyncio.timeout(self.timeout), self._slots:
                socket = self._socket
                if socket is None:
                    raise HAError("unavailable")
                self._next_id += 1
                request_id = self._next_id
                future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
                self._pending[request_id] = future
                if payload["type"] == "subscribe_events":
                    self._subscription = request_id
                try:
                    await socket.send(json.dumps({"id": request_id, **payload}))
                    return await future
                finally:
                    self._pending.pop(request_id, None)
        except TimeoutError:
            raise HAError("timeout") from None
        except WebSocketException:
            raise HAError("unavailable") from None

    async def _receive(self, socket: ClientConnection) -> dict[str, Any]:
        try:
            value = json.loads(await socket.recv())
        except ValueError, UnicodeError, RecursionError:
            raise HAError("unsupported_response") from None
        if not isinstance(value, dict):
            raise HAError("unsupported_response")
        return value

    async def _reader(self, socket: ClientConnection) -> None:
        while True:
            message = await self._receive(socket)
            request_id = message.get("id")
            if type(request_id) is not int:
                raise HAError("unsupported_response")
            if message.get("type") == "result":
                future = self._pending.get(request_id)
                if future is None or future.done():
                    continue  # A late reply cannot complete a newer command.
                if message.get("success") is True and "result" in message:
                    future.set_result(message["result"])
                elif message.get("success") is False and isinstance(message.get("error"), dict):
                    code = message["error"].get("code")
                    if not isinstance(code, str):
                        future.set_exception(HAError("unsupported_response"))
                        continue
                    mapping: dict[str, ErrorCode] = {
                        "unauthorized": "forbidden",
                        "not_allowed": "forbidden",
                        "not_supported": "unsupported_operation",
                        "timeout": "timeout",
                        "rate_limited": "rate_limited",
                        "not_found": "not_found",
                        "unknown_command": "unsupported_operation",
                    }
                    # Keep only bounded contract errors; never expose HA error messages.
                    bridge_errors: dict[str, ErrorCode] = {
                        "not_ready": "not_ready",
                        "shutting_down": "not_ready",
                        "busy": "busy",
                        "invalid_snapshot": "invalid_snapshot",
                        "snapshot_too_large": "snapshot_too_large",
                        "unsupported_schema": "unsupported_schema",
                        "checksum_mismatch": "checksum_mismatch",
                        "publisher_mismatch": "publisher_mismatch",
                        "revision_conflict": "revision_conflict",
                        "stale_revision": "stale_revision",
                        "base_conflict": "base_conflict",
                        "recovery_required": "recovery_required",
                        "persistence_uncertain": "persistence_uncertain",
                    }
                    future.set_exception(
                        HAError(mapping.get(code, bridge_errors.get(code, "unavailable")))
                    )
                else:
                    future.set_exception(HAError("unsupported_response"))
            elif message.get("type") == "event" and request_id == self._subscription:
                event = message.get("event")
                if (
                    not isinstance(event, dict)
                    or event.get("event_type") != "tag_scanned"
                    or not isinstance(event.get("data"), dict)
                ):
                    raise HAError("unsupported_response")
                data = event["data"]
                try:
                    scan = Scan(
                        tag_id=data.get("tag_id"),
                        device_id=data.get("device_id"),
                        observed_at=timestamp(),
                    )
                except ValidationError:
                    raise HAError("unsupported_response") from None
                # Observe immediately: native HA registration can lag behind the event.
                if scan.tag_id not in self.observations and len(self.observations) >= MAX_TAGS:
                    self.observations.pop(next(iter(self.observations)))
                    self.status.discovery_gap = True
                self.observations[scan.tag_id] = scan
                self._refresh.set()
                if self.scans.full():
                    self.scans.get_nowait()
                    self.status.discovery_gap = True
                    self.status.inventory_stale = True
                    self._refresh.set()
                self.scans.put_nowait(scan)
            else:
                raise HAError("unsupported_response")

    async def _inventory(self) -> bool:
        async with self._inventory_lock:
            return await self._read_inventory()

    async def refresh_inventory(self) -> None:
        if not await self._inventory():
            raise HAError(self.status.error or "unavailable")

    async def _read_inventory(self) -> bool:
        self.status.inventory_stale = True
        try:
            raw = await self.command("tag/list")
            tags = TypeAdapter(list[Tag]).validate_python(raw, strict=True)
            if len(tags) > MAX_TAGS or len({tag.id for tag in tags}) != len(tags):
                raise HAError("unsupported_response")
            self.inventory = tuple(tags)
            self.status.tag_list = "supported"
            self.status.inventory_updated_at = timestamp()
            self.status.inventory_stale = False
            return True
        except ValidationError:
            self.status.error = "unsupported_response"
        except HAError as error:
            self.status.error = error.code
            self.status.tag_list = (
                "unsupported" if error.code in {"forbidden", "unsupported_operation"} else "unknown"
            )

        return False

    async def _discover(self) -> None:
        assert self.rest is not None
        complete = True
        # Failures are independent: a missing service cannot hide working tag reads.
        for operation in ("config", "services"):
            try:
                payload = await self.rest.read(operation)
                if operation == "config":
                    version = payload.get("version") if isinstance(payload, dict) else None
                    if (
                        not isinstance(version, str)
                        or not 0 < len(version) <= 64
                        or any(not (c.isalnum() or c in ".-+_") for c in version)
                    ):
                        raise HAError("unsupported_response")
                    self.status.version = version
                else:
                    self.status.services = capabilities(payload)
                    self.status.services_updated_at = timestamp()
            except HAError as error:
                complete = False
                self.status.error = error.code
                if error.code == "unauthorized":
                    raise
        try:
            await self.command("subscribe_scans")
            self.status.scan_subscription = "supported"
            self.status.subscribed = True
        except HAError as error:
            complete = False
            self.status.error = error.code
            self.status.scan_subscription = (
                "unsupported" if error.code in {"forbidden", "unsupported_operation"} else "unknown"
            )
            # A timed-out subscribe may have taken effect: close before retrying.
            if error.code == "timeout":
                raise
        inventory_succeeded = await self._inventory()
        if complete and inventory_succeeded:
            self.status.last_success_at = timestamp()

    async def _session(self, socket: ClientConnection) -> None:
        async with asyncio.timeout(self.timeout):
            hello = await self._receive(socket)
            if hello.get("type") != "auth_required":
                raise HAError("unsupported_response")
            await socket.send(json.dumps({"type": "auth", "access_token": self._token}))
            result = await self._receive(socket)
            if result.get("type") == "auth_invalid":
                raise HAError("unauthorized")
            if result.get("type") != "auth_ok":
                raise HAError("unsupported_response")
        self.generation += 1
        self._socket = socket
        self.status.connection = "connected"
        self.status.error = None
        reader = asyncio.create_task(self._reader(socket))
        discover = asyncio.create_task(self._discover())
        refresher: asyncio.Task[None] | None = None
        try:
            done, _ = await asyncio.wait({reader, discover}, return_when=asyncio.FIRST_COMPLETED)
            for completed in done:
                completed.result()
            if reader in done:
                raise HAError("unavailable")

            async def reconcile() -> None:
                while True:
                    await self._refresh.wait()
                    self._refresh.clear()
                    # Coalesce bursts, retry only while observed IDs remain absent.
                    for delay in (0.0, 0.25, 1.0):
                        if delay:
                            await asyncio.sleep(delay)
                        succeeded = await self._inventory()
                        registered = {tag.id for tag in self.inventory}
                        if succeeded and self.observations.keys() <= registered:
                            break

            refresher = asyncio.create_task(reconcile())
            await reader
        finally:
            for task in (reader, discover, refresher):
                if task:
                    task.cancel()
            await asyncio.gather(
                *(task for task in (reader, discover, refresher) if task), return_exceptions=True
            )

    async def _run(self) -> None:
        assert self.origin is not None
        endpoint = websocket_endpoint(self.origin)
        attempt = 0
        try:
            while True:
                self.status.last_attempt_at = timestamp()
                try:
                    # Redirects are disabled; only the configured origin may receive traffic.
                    async with OriginConnection(
                        endpoint,
                        proxy=None,
                        max_size=MAX_BYTES,
                        max_queue=16,
                        open_timeout=self.timeout,
                        close_timeout=2,
                        logger=WIRE_LOGGER,
                    ) as socket:
                        await self._session(socket)
                except HAError as error:
                    self.status.error = error.code
                except TimeoutError:
                    self.status.error = "timeout"
                except WebSocketException, OSError:
                    self.status.error = "unavailable"
                finally:
                    self._socket = None
                    self._subscription = None
                    self.status.subscribed = False
                    self.status.inventory_stale = True
                    for future in self._pending.values():
                        if not future.done():
                            future.set_exception(HAError("unavailable"))
                    self._pending.clear()
                if self.status.error == "unauthorized":
                    self.status.connection = "unauthorized"
                    return
                self.status.connection = "disconnected"
                self.status.discovery_gap = True
                delay = min(30.0, 2.0 ** min(attempt, 5)) * random.uniform(0.5, 1.0)
                attempt += 1
                await self.sleep(delay)
        finally:
            if self.status.connection != "unauthorized":
                self.status.connection = "disconnected"
