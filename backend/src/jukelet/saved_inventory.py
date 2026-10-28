"""Join a page of HA inventory with one consistent saved-assignment snapshot."""

from pydantic import BaseModel
from sqlalchemy import bindparam, text

from jukelet.assignments import Assignment, AssignmentStore
from jukelet.inventory import InventoryTag, InventoryView


class SavedInventoryTag(InventoryTag):
    saved_assignment: Assignment | None


class SavedInventoryView(BaseModel):
    tags: list[SavedInventoryTag]
    total: int
    registry_available: bool
    stale: bool
    updated_at: str | None
    discovery_gap: bool


def saved_inventory(view: InventoryView, store: AssignmentStore) -> SavedInventoryView:
    # Bound the join to the inventory page; no N+1 reads or partial membership.
    keys = {tag.tag_key for tag in view.tags}
    with store.engine.connect() as connection:
        rows = connection.execute(
            text("SELECT * FROM assignment WHERE deleted=0 AND tag_key IN :keys").bindparams(
                bindparam("keys", expanding=True)
            ),
            {"keys": list(keys)},
        ).mappings()
        saved = {str(row["tag_key"]): Assignment.model_validate(dict(row)) for row in rows}
    return SavedInventoryView(
        **view.model_dump(exclude={"tags"}),
        tags=[
            SavedInventoryTag(**tag.model_dump(), saved_assignment=saved.get(tag.tag_key))
            for tag in view.tags
        ],
    )
