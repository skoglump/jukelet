"""Read-only discovery joins and explicit, independently verified HA naming."""

import asyncio
import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from jukelet.api import require_session
from jukelet.assignment_api import read_input, verify_write
from jukelet.assignments import AssignmentStore
from jukelet.auth import AuthService
from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import MAX_TAGS, HAError, Tag, exact_tag_id
from jukelet.inventory import InventoryTag, InventoryView, inventory_view, tag_key


class InboxTag(InventoryTag):
    local_assignment: Literal["unassigned", "enabled", "disabled", "unknown"]


class InboxView(InventoryView):
    tags: list[InboxTag]  # type: ignore[assignment]
    assignments_available: bool


class RenameInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    ha_tag_id: str = Field(min_length=1, max_length=512)
    expected_name: str | None = Field(max_length=512)
    name: str = Field(min_length=1, max_length=512)

    _id = field_validator("ha_tag_id")(exact_tag_id)

    @field_validator("name", "expected_name")
    @classmethod
    def supported_name(cls, value: str | None) -> str | None:
        if value is not None:
            value.encode("utf-8")
        return value

    @field_validator("name")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Name must not be blank")
        return value


class NameView(BaseModel):
    tag_key: str
    name: str | None
    state: Literal["verified", "current"]


class TagNames:
    def __init__(self, ha: HAAdapter) -> None:
        self.ha = ha
        self._lock = asyncio.Lock()
        self._uncertain: set[str] = set()

    @staticmethod
    def failure(code: str, status: int = 503, state: str = "unavailable") -> HTTPException:
        return HTTPException(status, {"code": code, "state": state})

    async def _current(self, key: str) -> Tag:
        try:
            await self.ha.refresh_inventory()
        except HAError as error:
            raise self.failure(error.code) from None
        tag = next((tag for tag in self.ha.inventory if tag_key(tag.id) == key), None)
        if tag is None:
            raise self.failure("not_registered", 404)
        return tag

    async def current(self, key: str) -> NameView:
        async with self._lock:
            tag = await self._current(key)
            self._uncertain.discard(key)
            return NameView(tag_key=key, name=tag.name, state="current")

    async def rename(self, key: str, value: RenameInput) -> NameView:
        async with self._lock:
            if key in self._uncertain:
                raise self.failure("reconciliation_required", 409, "uncertain")
            tag = await self._current(key)
            if tag.name != value.expected_name:
                raise HTTPException(
                    409, {"code": "name_conflict", "state": "conflict", "current_name": tag.name}
                )
            if tag.name == value.name:
                return NameView(tag_key=key, name=tag.name, state="verified")
            if len(self._uncertain) >= MAX_TAGS:
                raise self.failure("rate_limited")
            # Mark before sending: disconnect/cancellation may lose an accepted reply.
            self._uncertain.add(key)
            error_code = "readback_mismatch"
            try:
                await self.ha.update_tag_name(value.ha_tag_id, value.name)
            except HAError as error:
                if error.code in {"forbidden", "not_found", "unsupported_operation"}:
                    self._uncertain.discard(key)
                    raise self.failure(
                        error.code, 403 if error.code == "forbidden" else 503, "rejected"
                    ) from None
                error_code = error.code
            try:
                actual = await self._current(key)
            except HTTPException:
                raise self.failure(error_code, state="uncertain") from None
            if actual.name != value.name:
                raise self.failure(error_code, state="uncertain")
            self._uncertain.discard(key)
            return NameView(tag_key=key, name=actual.name, state="verified")


def onboarding_router(
    settings: Settings, auth: AuthService, ha: HAAdapter, store: AssignmentStore
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/tags")
    names = TagNames(ha)

    def valid_key(key: str) -> None:
        if not re.fullmatch("[a-f0-9]{64}", key):
            raise HTTPException(422, "Invalid tag key")

    @router.get("/inbox")
    async def inbox(
        request: Request,
        view: Literal["unassigned", "observed"] = "unassigned",
        offset: int = Query(0, ge=0, le=20000),
        limit: int = Query(100, ge=1, le=200),
    ) -> InboxView:
        require_session(request, auth)
        # Polling an open onboarding panel also reconciles registrations delayed beyond
        # the event-triggered retry window. Failed reads retain the stale snapshot.
        if ha.status.connection == "connected":
            try:
                await ha.refresh_inventory()
            except HAError:
                pass
        # Capture HA once, then join all tags before filtering/paging; never a page-local inbox.
        inventory = inventory_view(ha, limit=20000)
        try:
            membership = await run_in_threadpool(store.membership)
        except SQLAlchemyError:
            membership = None
        tags = [
            InboxTag(
                **tag.model_dump(),
                local_assignment="unknown"
                if membership is None
                else "unassigned"
                if tag.tag_key not in membership
                else "enabled"
                if membership[tag.tag_key]
                else "disabled",
            )
            for tag in inventory.tags
        ]
        if view == "observed":
            tags = sorted(
                (tag for tag in tags if tag.observed_at is not None),
                key=lambda tag: tag.observed_at or "",
                reverse=True,
            )
        else:
            tags = [tag for tag in tags if tag.local_assignment in {"unassigned", "unknown"}]
        return InboxView(
            **{**inventory.model_dump(), "tags": tags[offset : offset + limit], "total": len(tags)},
            assignments_available=membership is not None,
        )

    @router.get("/{key}/name")
    async def current_name(request: Request, key: str) -> NameView:
        require_session(request, auth)
        valid_key(key)
        return await names.current(key)

    @router.patch("/{key}/name")
    async def rename(request: Request, key: str) -> NameView:
        verify_write(request, auth, settings)
        valid_key(key)
        value = await read_input(request, RenameInput)
        if tag_key(value.ha_tag_id) != key:
            raise HTTPException(422, "Tag key and exact ID disagree")
        return await names.rename(key, value)

    return router
