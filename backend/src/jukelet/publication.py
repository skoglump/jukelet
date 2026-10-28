"""Read actual companion state before writes and after every uncertain outcome.

This module has no playback, scan, dispatcher activation or automation operations.
"""

import asyncio
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import HAError
from jukelet.publication_protocol import MAX_REVISION, BridgeStatus
from jukelet.publication_store import (
    PublicationRevoked,
    PublicationStore,
    desired,
    now,
    queue,
    record,
)


class PublicationError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code


class ReviewInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    action: Literal["publish", "recover", "activate"]


class ConfirmInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    review_token: str = Field(min_length=32, max_length=128)
    confirmed: bool
    confirm_empty: bool = False
    automatic_publication_attested: bool = False


@dataclass
class Review:
    session: str
    action: str
    desired_version: int
    checksum: str
    actual: tuple[object, ...]
    expires: float


class Publisher:
    def __init__(self, store: PublicationStore, ha: HAAdapter, manage: bool) -> None:
        self.store, self.ha, self.manage = store, ha, manage
        self.lock = asyncio.Lock()
        self.reviews: dict[str, Review] = {}
        self.task: asyncio.Task[None] | None = None
        self.epoch: int | None = None
        self.actual: BridgeStatus | None = None
        self.fresh = False
        self.ha.on_disconnect = self.disconnected

    def disconnected(self) -> None:
        self.fresh = False
        self.store.reset_connection()

    def start(self) -> None:
        self.store.reset_connection()
        self.task = asyncio.create_task(self._run())

    async def close(self) -> None:
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        self.store.reset_connection()

    def _guard(self, code: str) -> None:
        with self.store.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE publication_state SET guard_generation=guard_generation+1 WHERE id=1 "
                    "AND ((SELECT reconciliation_required FROM recovery_state WHERE id=1)=0 "
                    "OR EXISTS (SELECT 1 FROM publication_job WHERE recovery=1 "
                    "AND state IN ('queued','in_flight','uncertain')))"
                )
            )
            connection.execute(
                text("UPDATE recovery_state SET reconciliation_required=1 WHERE id=1")
            )
            connection.execute(
                text(
                    "UPDATE publication_state SET healthy=0,automatic_enabled=0,last_error=:code "
                    "WHERE id=1"
                ),
                {"code": code},
            )
            # Queued content was reviewed against a different actual state. Keep evidence,
            # never silently rebase it. A new reviewed recovery gets a new revision.
            connection.execute(
                text(
                    "UPDATE publication_job SET state='fenced' WHERE state IN "
                    "('queued','in_flight','uncertain')"
                )
            )

    async def _observe(self) -> BridgeStatus | None:
        self.fresh = False
        generation = self.ha.generation
        try:
            actual = BridgeStatus.model_validate(await self.ha.bridge_status())
            if generation != self.ha.generation:
                raise HAError("unavailable")
        except (HAError, ValueError) as error:
            code = error.code if isinstance(error, HAError) else "unsupported_response"
            with self.store.engine.begin() as connection:
                connection.execute(
                    text("UPDATE publication_state SET healthy=0,last_error=:code WHERE id=1"),
                    {"code": code},
                )
            return None
        self.actual, self.fresh, self.epoch = actual, True, generation
        with self.store.engine.begin() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            state = record(connection)
            connection.execute(
                text("UPDATE publication_state SET observed=:status,observed_at=:at WHERE id=1"),
                {"status": actual.model_dump_json(), "at": now()},
            )
            pending = (
                connection.execute(
                    text(
                        "SELECT * FROM publication_job WHERE state IN "
                        "('queued','in_flight','uncertain','fenced') ORDER BY revision"
                    )
                )
                .mappings()
                .all()
            )
            matching = next(
                (
                    job
                    for job in pending
                    if (job["revision"], job["checksum"]) == actual.identity()
                    # Retained jobs are evidence, not permission to rewind a newer
                    # confirmed anchor after HA restores a coherent older backup.
                    and job["revision"] > (state["active_revision"] or 0)
                    and (job["state"] != "fenced" or state["reconciliation_required"])
                ),
                None,
            )
            foreign = actual.publisher_id != state["publisher_id"]
            if not foreign and actual.active_revision is not None:
                connection.execute(
                    text(
                        "UPDATE publication_state SET high_water=max(high_water,:revision) WHERE "
                        "id=1"
                    ),
                    {"revision": actual.active_revision},
                )
            degraded = actual.persistence not in {"healthy", "empty"}
            if not foreign and not degraded and matching:
                # Completion of an old job records its captured desired version, never
                # the newer live assignment revision. Forward readback of fenced
                # work may record accepted content, but cannot clear its guard.
                envelope = json.loads(matching["envelope"])
                connection.execute(
                    text("UPDATE publication_job SET state='verified' WHERE revision=:revision"),
                    {"revision": matching["revision"]},
                )
                connection.execute(
                    text(
                        "UPDATE publication_state SET "
                        "active_revision=:revision,active_checksum=:checksum,active_payload=:payload,"
                        "active_desired_version=:version,established=1,"
                        "high_water=max(high_water,:revision),last_error=NULL "
                        "WHERE id=1"
                    ),
                    {
                        "revision": matching["revision"],
                        "checksum": matching["checksum"],
                        "payload": json.dumps(envelope["payload"]),
                        "version": matching["desired_version"],
                    },
                )
                if (
                    matching["recovery"]
                    and matching["state"] != "fenced"
                    and matching["guard_generation"] == state["guard_generation"]
                ):
                    connection.execute(
                        text("UPDATE recovery_state SET reconciliation_required=0 WHERE id=1")
                    )
                known = True
            else:
                known = actual.identity() == (
                    state["active_revision"],
                    state["active_checksum"],
                ) and (actual.active_revision is not None or not state["established"])
                known = known or any(
                    job["recovery"]
                    and job["state"] != "fenced"
                    and actual.identity()
                    == (
                        json.loads(job["envelope"])["expected_active_revision"],
                        job["base_checksum"],
                    )
                    for job in pending
                )
            guarded = bool(
                connection.scalar(
                    text("SELECT reconciliation_required FROM recovery_state WHERE id=1")
                )
            )
            if not foreign and not degraded and known:
                connection.execute(
                    text(
                        "UPDATE publication_state SET healthy=:healthy,last_error=:error WHERE id=1"
                    ),
                    {
                        "healthy": not guarded,
                        "error": (state["last_error"] or "recovery_required") if guarded else None,
                    },
                )
                return actual
        self._guard(
            "foreign_publisher"
            if foreign
            else "persistence_degraded"
            if degraded
            else "restore_or_revision_mismatch"
        )
        return actual

    async def refresh(self) -> dict[str, Any]:
        async with self.lock:
            await self._observe()
            return self.status()

    def status(self) -> dict[str, Any]:
        state = self.store.read()
        actual = json.loads(state["observed"]) if state["observed"] else None
        connected = self.ha.status.connection == "connected" and self.epoch == self.ha.generation
        fresh = self.fresh and connected
        return {
            "publisher_id": state["publisher_id"],
            "desired_version": state["desired_version"],
            "desired_checksum": state["desired_checksum"],
            "mapping_count": state["mapping_count"],
            "active_desired_version": state["active_desired_version"],
            "active_revision": state["active_revision"],
            "active_checksum": state["active_checksum"],
            "high_water": state["high_water"],
            "automatic_enabled": bool(state["automatic_enabled"]),
            "healthy": fresh and bool(state["healthy"]),
            "reconciliation_required": bool(state["reconciliation_required"]),
            "verified": fresh
            and bool(state["healthy"])
            and state["desired_checksum"] == state["active_checksum"]
            and state["desired_version"] == state["active_desired_version"],
            "actual": actual,
            "actual_stale": not fresh,
            "checked_at": state["observed_at"],
            "error": state["invalid"] or state["last_error"],
            "shuffle_conflict": state["shuffle_conflict"],
            "pending_removals": state["pending_removals"],
            "jobs": state["jobs"],
            # Companion acceptance/execution diagnostics do not independently observe Spotify.
            "playback_verified": None,
        }

    async def review(self, action: str, session: str) -> dict[str, Any]:
        async with self.lock:
            actual = await self._observe()
            state = self.store.read()
            self._eligible(action, state, actual)
            assert actual is not None and state["desired_checksum"] is not None
            token = secrets.token_urlsafe(32)
            self.reviews = {
                key: value
                for key, value in self.reviews.items()
                if value.expires > time.monotonic()
            }
            while len(self.reviews) >= 32:
                del self.reviews[next(iter(self.reviews))]
            self.reviews[token] = Review(
                session,
                action,
                state["desired_version"],
                state["desired_checksum"],
                actual.review_identity(),
                time.monotonic() + 900,
            )
            return {
                "review_token": token,
                "action": action,
                "mappings": state["mappings"],
                "desired_version": state["desired_version"],
                "checksum": state["desired_checksum"],
                "mapping_count": state["mapping_count"],
                "empty": state["mapping_count"] == 0,
                "pending_removals": state["pending_removals"],
                "shuffle_conflict": state["shuffle_conflict"],
                "actual": actual.model_dump(),
            }

    @staticmethod
    def _eligible(action: str, state: dict[str, Any], actual: BridgeStatus | None) -> None:
        if actual is None:
            raise PublicationError("bridge_unavailable")
        if actual.publisher_id != state["publisher_id"] or actual.persistence not in {
            "healthy",
            "empty",
        }:
            raise PublicationError("operator_ha_recovery_required")
        if state["invalid"]:
            raise PublicationError("invalid_snapshot")
        if action != "activate" and state["high_water"] >= MAX_REVISION:
            raise PublicationError("revision_limit_reached")
        if action == "recover":
            if not state["reconciliation_required"]:
                raise PublicationError("recovery_not_required")
        elif state["reconciliation_required"] or not state["healthy"]:
            raise PublicationError("recovery_required")
        if action == "activate":
            if state["shuffle_conflict"]:
                raise PublicationError("shuffle_conflict")
            if (
                state["active_checksum"] != state["desired_checksum"]
                or state["active_desired_version"] != state["desired_version"]
            ):
                raise PublicationError("reviewed_publication_required")
        if action in {"recover", "activate"} and any(
            job["state"] in {"queued", "in_flight", "uncertain"} for job in state["jobs"]
        ):
            raise PublicationError("job_pending")

    async def confirm(self, value: ConfirmInput, session: str) -> dict[str, Any]:
        async with self.lock:
            entry = self.reviews.get(value.review_token)
            if (
                not entry
                or entry.session != session
                or entry.expires <= time.monotonic()
                or not value.confirmed
            ):
                raise PublicationError("review_expired")
            actual = await self._observe()
            state = self.store.read()
            if (
                actual is None
                or actual.review_identity() != entry.actual
                or state["desired_version"] != entry.desired_version
                or state["desired_checksum"] != entry.checksum
            ):
                raise PublicationError("review_stale")
            self._eligible(entry.action, state, actual)
            if not state["mapping_count"] and not value.confirm_empty:
                raise PublicationError("empty_confirmation_required")
            if entry.action == "activate" and not value.automatic_publication_attested:
                raise PublicationError("automatic_publication_attestation_required")
            with self.store.engine.begin() as connection:
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                # Another request can save during status IO, or from another thread.
                version, current = desired(connection)
                from jukelet.publication_protocol import checksum

                if version != entry.desired_version or checksum(current) != entry.checksum:
                    raise PublicationError("review_stale")
                if entry.action == "activate":
                    connection.execute(
                        text("UPDATE publication_state SET automatic_enabled=1 WHERE id=1")
                    )
                else:
                    if entry.action == "recover":
                        connection.execute(
                            text(
                                "UPDATE publication_job SET state='fenced' WHERE state IN "
                                "('queued','in_flight','uncertain')"
                            )
                        )
                    queue(
                        connection,
                        recovery=entry.action == "recover",
                        base=actual.identity() if entry.action == "recover" else None,
                    )
            self.reviews.pop(value.review_token, None)
            return self.status()

    async def disable_automatic(self) -> dict[str, Any]:
        async with self.lock:
            with self.store.engine.begin() as connection:
                connection.execute(
                    text("UPDATE publication_state SET automatic_enabled=0 WHERE id=1")
                )
            return self.status()

    async def step(self) -> None:
        async with self.lock:
            actual = await self._observe()
            if not self.manage or actual is None:
                return
            with self.store.engine.begin() as connection:
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                state = record(connection)
                job = (
                    connection.execute(
                        text(
                            "SELECT * FROM publication_job WHERE state IN "
                            "('queued','in_flight','uncertain') ORDER BY revision LIMIT 1"
                        )
                    )
                    .mappings()
                    .first()
                )
                if (
                    not job
                    or job["guard_generation"] != state["guard_generation"]
                    or bool(job["recovery"]) != bool(state["reconciliation_required"])
                ):
                    return
                if actual.publisher_id != state["publisher_id"] or actual.persistence not in {
                    "healthy",
                    "empty",
                }:
                    return
                envelope = json.loads(job["envelope"])
                if actual.identity() != (
                    envelope["expected_active_revision"],
                    job["base_checksum"],
                ):
                    self.fresh = False
                    # Exit the transaction before latching the guard.
                    mismatch = True
                else:
                    mismatch = False
                    connection.execute(
                        text(
                            "UPDATE publication_job SET state='in_flight' WHERE revision=:revision"
                        ),
                        {"revision": job["revision"]},
                    )
            if mismatch:
                self._guard("job_base_mismatch")
                return
            try:
                assert self.epoch is not None
                await self.ha.publish_snapshot(
                    envelope,
                    self.epoch,
                    before_send=lambda: self.store.sending(int(job["revision"])),
                )
            except PublicationRevoked:
                pass  # A restore fenced unsent work; it must not be resurrected.
            except HAError as error:
                if error.code not in {
                    "timeout",
                    "unavailable",
                    "unsupported_response",
                    "not_ready",
                    "busy",
                    "rate_limited",
                }:
                    # Known rejection stops its dependent queue. Retain the exact job
                    # evidence and suspend automatic mode; no periodic blind retries.
                    self._guard(error.code)
                else:
                    with self.store.engine.begin() as connection:
                        connection.execute(
                            text("UPDATE publication_state SET last_error=:code WHERE id=1"),
                            {"code": error.code},
                        )
            finally:
                with self.store.engine.begin() as connection:
                    connection.execute(
                        text(
                            "UPDATE publication_job SET state='uncertain' WHERE "
                            "revision=:revision AND state='in_flight'"
                        ),
                        {"revision": job["revision"]},
                    )
            # A separate actual-state read is the only completion authority.
            await self._observe()

    async def _run(self) -> None:
        while True:
            if self.ha.status.connection == "connected":
                await self.step()
            else:
                self.fresh = False
                with self.store.engine.begin() as connection:
                    connection.execute(text("UPDATE publication_state SET healthy=0 WHERE id=1"))
            await asyncio.sleep(1)
