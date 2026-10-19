"""Bounded literal variables.tags parser. Nodes preserve duplicate keys and scalar types."""

import hashlib
import json
import re
from collections import Counter
from typing import Any, Literal

import yaml
from pydantic import BaseModel
from yaml.events import AliasEvent, CollectionEndEvent, CollectionStartEvent, ScalarEvent
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

from jukelet.ha.models import MAX_TAGS, Tag, exact_tag_id
from jukelet.inventory import tag_key

MAX_SOURCE_BYTES = 1024 * 1024
MAX_DEPTH = 32
MAX_NODES = 100000
STRING = "tag:yaml.org,2002:str"
SAFE_TAGS = {
    f"tag:yaml.org,2002:{kind}"
    for kind in (
        "str",
        "null",
        "bool",
        "int",
        "float",
        "timestamp",
        "map",
        "seq",
        "merge",
    )
}


class PreviewError(Exception):
    """Messages are finite diagnostic codes, never source snippets."""


class PreviewRow(BaseModel):
    row: int
    ha_tag_id: str | None
    tag_key: str | None
    key_literal: str | None = None
    name: str | None = None
    media_content_id: str | None = None
    media_content_type: str | None = None
    accepted: bool = False
    registry_state: Literal["matched", "orphaned", "unknown"] = "unknown"
    diagnostics: list[str] = []


class Counts(BaseModel):
    mappings: int
    accepted: int
    rejected: int
    matched: int | None
    unassigned: int | None
    orphaned: int | None


class PreviewReport(BaseModel):
    schema_version: Literal[1] = 1
    source: Literal["upload", "configured"]
    fingerprint: str
    source_changed: bool
    registry_available: bool
    registry_stale: bool
    registry_updated_at: str | None
    counts: Counts
    rows: list[PreviewRow]
    warnings: list[str]


class ObjectPairs(list[tuple[str, Any]]):
    """Keep JSON object members in source order, including duplicate names."""


def json_nodes(content: str) -> Node:
    count = 0

    def convert(value: Any, depth: int = 0) -> Node:
        nonlocal count
        count += 1
        if count > MAX_NODES:
            raise PreviewError("source_too_complex")
        if isinstance(value, list):
            if depth >= MAX_DEPTH:
                raise PreviewError("source_too_deep")
            if isinstance(value, ObjectPairs):
                return MappingNode(
                    "tag:yaml.org,2002:map",
                    [(convert(key, depth + 1), convert(item, depth + 1)) for key, item in value],
                )
            return SequenceNode(
                "tag:yaml.org,2002:seq", [convert(item, depth + 1) for item in value]
            )
        if isinstance(value, str):
            value.encode("utf-8")  # Reject lone surrogate escapes; JSON pairs decode normally.
            return ScalarNode(STRING, value)
        if value is None:
            return ScalarNode("tag:yaml.org,2002:null", "null")
        if isinstance(value, bool):
            return ScalarNode("tag:yaml.org,2002:bool", "true" if value else "false")
        return ScalarNode("tag:yaml.org,2002:float", str(value))

    def invalid_constant(value: str) -> None:
        raise ValueError("Non-JSON constant")

    return convert(
        json.loads(content, object_pairs_hook=ObjectPairs, parse_constant=invalid_constant)
    )


def parse_source(content: str, format: Literal["json", "yaml"]) -> Node:
    try:
        if len(content.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise PreviewError("source_too_large")
        if format == "json":
            return json_nodes(content)
        depth = 0
        for count, event in enumerate(yaml.parse(content, Loader=yaml.SafeLoader), 1):
            if count > MAX_NODES:
                raise PreviewError("source_too_complex")
            if isinstance(event, AliasEvent) or getattr(event, "anchor", None):
                raise PreviewError("yaml_aliases_not_supported")
            if isinstance(event, CollectionStartEvent):
                depth += 1
                if depth > MAX_DEPTH:
                    raise PreviewError("source_too_deep")
            if isinstance(event, CollectionEndEvent):
                depth -= 1
            if isinstance(event, ScalarEvent):
                event.value.encode("utf-8")
            if isinstance(event, (ScalarEvent, CollectionStartEvent)):
                if event.tag is not None and event.tag not in SAFE_TAGS:
                    raise PreviewError("yaml_tag_not_supported")
        result = yaml.compose(content, Loader=yaml.SafeLoader)
        if not isinstance(result, Node):
            raise PreviewError("missing_variables_tags")
        return result
    except yaml.YAMLError, ValueError, UnicodeError, RecursionError:
        raise PreviewError("invalid_source") from None


def scalar(node: Node | None) -> str | None:
    return node.value if isinstance(node, ScalarNode) and node.tag == STRING else None


def field(node: Node, key: str) -> Node:
    if not isinstance(node, MappingNode):
        raise PreviewError("missing_variables_tags")
    matches = [value for name, value in node.value if scalar(name) == key]
    if len(matches) > 1:
        raise PreviewError("ambiguous_variables_tags")
    if len(matches) != 1:
        raise PreviewError("missing_variables_tags")
    result = matches[0]
    assert isinstance(result, Node)
    return result


def template(value: str) -> bool:
    return any(marker in value for marker in ("{{", "{%", "{#"))


def preview(
    content: str,
    format: Literal["json", "yaml"],
    *,
    source: Literal["upload", "configured"] = "upload",
    registry: tuple[Tag, ...] = (),
    registry_updated_at: str | None = None,
    registry_stale: bool = True,
    expected_fingerprint: str | None = None,
) -> PreviewReport:
    root = parse_source(content, format)
    tags = field(field(root, "variables"), "tags")
    if not isinstance(tags, MappingNode):
        raise PreviewError("variables_tags_must_be_literal_mapping")
    if len(tags.value) > MAX_TAGS:
        raise PreviewError("too_many_mappings")
    fingerprint = hashlib.sha256(content.encode("utf-8")).hexdigest()
    changed = expected_fingerprint is not None and fingerprint != expected_fingerprint
    available = registry_updated_at is not None
    registry_by_id = {tag.id: tag for tag in registry}
    keys = Counter(scalar(key) for key, _ in tags.value)
    rows: list[PreviewRow] = []
    mapped_ids: set[str] = set()
    for number, (key, value) in enumerate(tags.value, 1):
        tag_id = scalar(key)
        row = PreviewRow(row=number, ha_tag_id=tag_id, tag_key=None)
        if tag_id is None:
            row.key_literal = key.value if isinstance(key, ScalarNode) else None
            row.diagnostics.append("tag_id_must_be_string")
        else:
            try:
                exact_tag_id(tag_id)
                row.tag_key = tag_key(tag_id)
                mapped_ids.add(tag_id)
            except ValueError:
                row.diagnostics.append("invalid_tag_id")
            if keys[tag_id] > 1:
                row.diagnostics.append("duplicate_tag_id")
            if template(tag_id):
                row.diagnostics.append("template_not_supported")
            if available:
                registered = registry_by_id.get(tag_id)
                row.registry_state = "matched" if registered else "orphaned"
                row.name = registered.name if registered else None
        if not isinstance(value, MappingNode):
            row.diagnostics.append("mapping_must_be_object")
        else:
            fields: dict[str, Node] = {}
            for name, item in value.value:
                key_name = scalar(name)
                if key_name not in {"media_content_id", "media_content_type"}:
                    row.diagnostics.append("unsupported_mapping_field")
                elif key_name in fields:
                    row.diagnostics.append("duplicate_mapping_field")
                else:
                    fields[key_name] = item
            row.media_content_id = scalar(fields.get("media_content_id"))
            row.media_content_type = scalar(fields.get("media_content_type"))
            uri, media_type = row.media_content_id, row.media_content_type
            if any(template(text) for text in (uri, media_type) if text):
                row.diagnostics.append("template_not_supported")
            if media_type not in {"album", "playlist"}:
                row.diagnostics.append("unsupported_media_type")
            match = re.fullmatch(r"spotify:(album|playlist):[A-Za-z0-9]{22}", uri or "")
            if not match:
                row.diagnostics.append("invalid_spotify_uri")
            elif match[1] != media_type:
                row.diagnostics.append("media_type_mismatch")
        row.diagnostics = list(dict.fromkeys(row.diagnostics))
        row.accepted = not row.diagnostics
        # Missing registry entries are warnings; a valid mapping is still preserved.
        if row.registry_state == "orphaned":
            row.diagnostics.append("missing_registry_tag")
        rows.append(row)
    warnings = []
    if changed:
        warnings.append("source_changed_review_again")
    if not available:
        warnings.append("registry_unavailable")
    elif registry_stale:
        warnings.append("registry_stale")
    matched = len(mapped_ids & registry_by_id.keys())
    accepted = sum(row.accepted for row in rows)
    return PreviewReport(
        source=source,
        fingerprint=fingerprint,
        source_changed=changed,
        registry_available=available,
        registry_stale=registry_stale,
        registry_updated_at=registry_updated_at,
        counts=Counts(
            mappings=len(rows),
            accepted=accepted,
            rejected=len(rows) - accepted,
            matched=matched if available else None,
            unassigned=len(registry_by_id.keys() - mapped_ids) if available else None,
            orphaned=len(mapped_ids - registry_by_id.keys()) if available else None,
        ),
        rows=rows,
        warnings=warnings,
    )
