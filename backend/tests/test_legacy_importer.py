"""Synthetic HA variables.tags shapes, not household configuration captures."""

import json
from typing import Literal

import pytest

from jukelet.ha.models import Tag
from jukelet.importers.legacy import MAX_SOURCE_BYTES, PreviewError, preview
from jukelet.inventory import tag_key

URI = "spotify:album:0123456789ABCDEFGHIJKL"
UPDATED = "2026-10-19T12:00:00+00:00"
IDS = ["04:AB:00:cd", "123e4567-e89b-12d3-a456-426614174000", "a/b", "Å/音楽", "  exact  "]


def test_exact_join_and_report_export_round_trip() -> None:
    content = json.dumps(
        {
            "variables": {
                "tags": {
                    key: {"media_content_id": URI, "media_content_type": "album"} for key in IDS
                }
            },
            "private_unrelated": "MUST_NOT_LEAK",
        }
    )
    report = preview(
        content,
        "json",
        registry=tuple(Tag(id=key, name="Å") for key in IDS[:-1]) + (Tag(id="unassigned"),),
        registry_updated_at=UPDATED,
        registry_stale=False,
    )
    assert report.counts.model_dump() == {
        "mappings": 5,
        "accepted": 5,
        "rejected": 0,
        "matched": 4,
        "unassigned": 1,
        "orphaned": 1,
    }
    exported = json.loads(report.model_dump_json())
    assert [row["ha_tag_id"] for row in exported["rows"]] == IDS
    assert exported["rows"][-1]["diagnostics"] == ["missing_registry_tag"]
    assert "MUST_NOT_LEAK" not in report.model_dump_json()
    assert all(row.tag_key == tag_key(key) for row, key in zip(report.rows, IDS, strict=True))
    assert tag_key("é") != tag_key("e\u0301")
    assert tag_key("Case") != tag_key("case")


@pytest.mark.parametrize("format", ["yaml", "json"])
def test_duplicate_mappings_are_not_collapsed_and_counts_are_distinct_ids(
    format: Literal["json", "yaml"],
) -> None:
    row = f'{{"media_content_id":"{URI}","media_content_type":"album"}}'
    content = '{"variables":{"tags":{"duplicate":' + row + ',"duplicate":' + row + "}}}"
    report = preview(
        content,
        format,
        registry=(Tag(id="duplicate"), Tag(id="free")),
        registry_updated_at=UPDATED,
        registry_stale=False,
    )
    assert report.counts.mappings == 2
    assert report.counts.rejected == 2
    assert report.counts.matched == 1
    assert report.counts.unassigned == 1
    assert all(row.diagnostics == ["duplicate_tag_id"] for row in report.rows)


def test_rejected_rows_templates_types_uri_mismatch_and_nonstring_keys_preserved() -> None:
    content = """variables:
  tags:
    "template": {media_content_type: album, media_content_id: "{{ secret }}"}
    "track": {media_content_type: track, media_content_id: spotify:track:0123456789ABCDEFGHIJKL}
    "wrong-kind": {media_content_type: playlist,
      media_content_id: spotify:album:0123456789ABCDEFGHIJKL}
    "bad-id": {media_content_type: album, media_content_id: spotify:album:short}
    123: {media_content_type: album, media_content_id: spotify:album:0123456789ABCDEFGHIJKL}
    "123": {media_content_type: album, media_content_id: spotify:album:0123456789ABCDEFGHIJKL}
    true: {media_content_type: album, media_content_id: spotify:album:0123456789ABCDEFGHIJKL}
    "extra": {media_content_type: album,
      media_content_id: spotify:album:0123456789ABCDEFGHIJKL, shuffle: true}
    "duplicate-field": {media_content_type: album, media_content_type: playlist}
    "not-object": []
"""
    report = preview(content, "yaml", registry_updated_at=UPDATED)
    assert report.counts.mappings == 10
    assert report.counts.accepted == 1
    assert report.counts.rejected == 9
    assert "template_not_supported" in report.rows[0].diagnostics
    assert "unsupported_media_type" in report.rows[1].diagnostics
    assert "media_type_mismatch" in report.rows[2].diagnostics
    assert "invalid_spotify_uri" in report.rows[3].diagnostics
    assert report.rows[4].ha_tag_id is None and report.rows[4].key_literal == "123"
    assert report.rows[5].ha_tag_id == "123" and report.rows[5].accepted
    assert report.rows[6].key_literal == "true"
    assert "unsupported_mapping_field" in report.rows[7].diagnostics
    assert "duplicate_mapping_field" in report.rows[8].diagnostics
    assert "mapping_must_be_object" in report.rows[9].diagnostics


@pytest.mark.parametrize(
    ("content", "code"),
    [
        ("!!python/object/apply:os.system ['echo BAD']", "yaml_tag_not_supported"),
        ("variables: &a {tags: *a}", "yaml_aliases_not_supported"),
        ("variables: {tags: {}}\nvariables: {tags: {}}", "ambiguous_variables_tags"),
        ("variables: {tags: {}, tags: {}}", "ambiguous_variables_tags"),
        ("variables: {tags: '{{ template }}'}", "variables_tags_must_be_literal_mapping"),
        ("variables: {other: {}}", "missing_variables_tags"),
        ("[" * 33 + "]" * 33, "source_too_deep"),
        (" " * (MAX_SOURCE_BYTES + 1), "source_too_large"),
        ("variables: [", "invalid_source"),
        ("variables: {}\n---\nvariables: {}", "invalid_source"),
    ],
)
def test_unsafe_ambiguous_or_unbounded_documents_fail_without_source_echo(
    content: str, code: str
) -> None:
    with pytest.raises(PreviewError) as error:
        preview(content, "yaml")
    assert str(error.value) == code


def test_changed_source_fingerprint_is_explicit_and_empty_registry_is_known() -> None:
    original = preview('{"variables":{"tags":{}}}', "json", registry_updated_at=UPDATED)
    same = preview('{"variables":{"tags":{}}}', "json", expected_fingerprint=original.fingerprint)
    changed = preview(
        '{"variables":{"tags":{}}} ',
        "json",
        registry_updated_at=UPDATED,
        expected_fingerprint=original.fingerprint,
    )
    assert original.counts.unassigned == original.counts.matched == original.counts.orphaned == 0
    assert same.source_changed is False
    assert same.counts.matched is None
    assert changed.source_changed
    assert "source_changed_review_again" in changed.warnings
    assert "registry_stale" in changed.warnings


def test_invalid_ids_are_rejected_without_normalization() -> None:
    content = json.dumps({"variables": {"tags": {key: {} for key in ("", "x" * 513)}}})
    report = preview(content, "json")
    assert [row.ha_tag_id for row in report.rows] == ["", "x" * 513]
    assert all("invalid_tag_id" in row.diagnostics for row in report.rows)


def test_json_escaped_unicode_surrogate_pairs_preserve_exact_id() -> None:
    tag_id = "Synthetic 🎵/Å"
    content = json.dumps(
        {
            "variables": {
                "tags": {
                    tag_id: {
                        "media_content_id": URI,
                        "media_content_type": "album",
                    }
                }
            }
        }
    )
    report = preview(content, "json", registry=(Tag(id=tag_id),), registry_updated_at=UPDATED)
    assert report.rows[0].accepted and report.rows[0].ha_tag_id == tag_id
    assert json.loads(report.model_dump_json())["rows"][0]["ha_tag_id"] == tag_id


@pytest.mark.parametrize("format", ["json", "yaml"])
def test_lone_surrogate_escape_is_rejected_not_returned(format: Literal["json", "yaml"]) -> None:
    with pytest.raises(PreviewError, match="invalid_source"):
        preview('{"variables":{"tags":{"\\ud800":{}}}}', format)
