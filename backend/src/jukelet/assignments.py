"""Transactional local drafts. No HA or metadata transport belongs in this module."""

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Connection, Engine, text

from jukelet.ha.models import exact_tag_id
from jukelet.inventory import tag_key
from jukelet.providers.spotifyplus import MediaType, parse_uri


class Preferences(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    enabled: bool
    shuffle: bool
    playback_profile_id: Literal["default"]


class AssignmentInput(Preferences):
    ha_tag_id: str = Field(min_length=1, max_length=512)
    input: str = Field(min_length=1, max_length=512)
    media_type: MediaType
    expected_version: int = Field(ge=0, le=2**53 - 1)

    @field_validator("ha_tag_id")
    @classmethod
    def valid_tag(cls, value: str) -> str:
        return exact_tag_id(value)

    @model_validator(mode="after")
    def valid_uri(self) -> AssignmentInput:
        self.input = parse_uri(self.input, self.media_type)
        return self


class DeleteInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    expected_version: int = Field(ge=1, le=2**53 - 1)


class Assignment(BaseModel):
    tag_key: str
    ha_tag_id: str
    spotify_uri: str
    media_type: MediaType
    enabled: bool
    shuffle: bool
    playback_profile_id: Literal["default"]
    version: int
    updated_at: str


class AssignmentState(BaseModel):
    version: int
    assignment: Assignment | None


class AssignmentPage(BaseModel):
    assignments: list[Assignment]
    total: int
    revision: int


class AssignmentConflict(Exception):
    def __init__(self, version: int) -> None:
        self.version = version


class AssignmentStore:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def revision(self) -> int:
        with self.engine.connect() as connection:
            return int(connection.scalar(text("SELECT revision FROM assignment_revision")) or 0)

    def state(self, key: str) -> AssignmentState:
        with self.engine.connect() as connection:
            return self._state(connection, key)

    @staticmethod
    def _state(connection: Connection, key: str) -> AssignmentState:
        row = (
            connection.execute(text("SELECT * FROM assignment WHERE tag_key=:key"), {"key": key})
            .mappings()
            .first()
        )
        return AssignmentState(
            version=int(row["version"]) if row else 0,
            assignment=Assignment.model_validate(dict(row)) if row and not row["deleted"] else None,
        )

    def membership(self) -> dict[str, bool]:
        """One snapshot of saved membership; disabled drafts remain assigned."""
        with self.engine.connect() as connection:
            return {
                str(row.tag_key): bool(row.enabled)
                for row in connection.execute(
                    text("SELECT tag_key,enabled FROM assignment WHERE deleted=0")
                )
            }

    def page(self, offset: int, limit: int) -> AssignmentPage:
        with self.engine.connect() as connection:
            # One read transaction produces a consistent list and count.
            connection.exec_driver_sql("BEGIN")
            rows = connection.execute(
                text(
                    "SELECT * FROM assignment WHERE deleted=0 "
                    "ORDER BY ha_tag_id LIMIT :limit OFFSET :offset"
                ),
                {"limit": limit, "offset": offset},
            ).mappings()
            return AssignmentPage(
                assignments=[Assignment.model_validate(dict(row)) for row in rows],
                total=int(
                    connection.scalar(text("SELECT count(*) FROM assignment WHERE deleted=0")) or 0
                ),
                revision=int(
                    connection.scalar(text("SELECT revision FROM assignment_revision")) or 0
                ),
            )

    @staticmethod
    def _audit(connection: Connection, action: str, key: str | None, affected: int) -> None:
        connection.execute(text("UPDATE assignment_revision SET revision=revision+1 WHERE id=1"))
        connection.execute(
            text(
                "INSERT INTO assignment_audit(action,tag_key,affected,created_at) "
                "VALUES (:action,:key,:affected,:at)"
            ),
            {
                "action": action,
                "key": key,
                "affected": affected,
                "at": datetime.now(UTC).isoformat(),
            },
        )
        connection.execute(
            text(
                "DELETE FROM assignment_audit WHERE id NOT IN "
                "(SELECT id FROM assignment_audit ORDER BY id DESC LIMIT 1000)"
            )
        )

    @staticmethod
    def _put(connection: Connection, value: AssignmentInput) -> None:
        key = tag_key(value.ha_tag_id)
        current = AssignmentStore._state(connection, key)
        if current.version != value.expected_version:
            raise AssignmentConflict(current.version)
        connection.execute(
            text("""INSERT INTO assignment
            (tag_key,ha_tag_id,spotify_uri,media_type,enabled,shuffle,
             playback_profile_id,version,deleted,updated_at)
            VALUES (:key,:ha_tag_id,:uri,:media_type,:enabled,:shuffle,
                    :playback_profile_id,:version,0,:at)
            ON CONFLICT(tag_key) DO UPDATE SET spotify_uri=excluded.spotify_uri,
            media_type=excluded.media_type,enabled=excluded.enabled,shuffle=excluded.shuffle,
            playback_profile_id=excluded.playback_profile_id,version=excluded.version,deleted=0,updated_at=excluded.updated_at"""),
            {
                **value.model_dump(),
                "key": key,
                "uri": value.input,
                "version": current.version + 1,
                "at": datetime.now(UTC).isoformat(),
            },
        )

    def put(self, value: AssignmentInput) -> AssignmentState:
        with self.engine.begin() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            self._put(connection, value)
            self._audit(connection, "save", tag_key(value.ha_tag_id), 1)
            return self._state(connection, tag_key(value.ha_tag_id))

    def delete(self, key: str, version: int) -> AssignmentState:
        with self.engine.begin() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            current = self._state(connection, key)
            if current.version != version or current.assignment is None:
                raise AssignmentConflict(current.version)
            connection.execute(
                text(
                    "UPDATE assignment SET deleted=1,version=version+1,updated_at=:at "
                    "WHERE tag_key=:key"
                ),
                {"key": key, "at": datetime.now(UTC).isoformat()},
            )
            self._audit(connection, "remove", key, 1)
            return self._state(connection, key)

    def import_rows(
        self,
        values: list[AssignmentInput],
        revision: int,
        policy: Literal["skip", "replace", "reject"],
    ) -> tuple[int, int]:
        with self.engine.begin() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            current_revision = int(
                connection.scalar(text("SELECT revision FROM assignment_revision")) or 0
            )
            if current_revision != revision:
                raise AssignmentConflict(current_revision)
            imported = skipped = 0
            for value in values:
                current = self._state(connection, tag_key(value.ha_tag_id))
                if current.assignment:
                    if policy == "reject":
                        raise AssignmentConflict(current.version)
                    if policy == "skip":
                        skipped += 1
                        continue
                self._put(
                    connection, value.model_copy(update={"expected_version": current.version})
                )
                imported += 1
            self._audit(connection, "import", None, imported)
            return imported, skipped
