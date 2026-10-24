"""Supported HA envelope normalization without HA, credentials or playback."""

import unittest
from typing import Any

from companion.custom_components.jukelet_bridge import normalize_tag_event


class TagEventTests(unittest.TestCase):
    def test_metadata_never_changes_exact_routing_ids(self) -> None:
        tag, reader = "  Tag e\u0301 / 🦊  ", " Reader Å "
        for name in (None, "", "Synthetic name", "script.other", "spotify:playlist:any"):
            value = {"tag_id": tag, "device_id": reader, "name": name}
            normalized = normalize_tag_event(value)
            self.assertEqual(normalized, {"tag_id": tag, "device_id": reader})
            self.assertIsNot(normalized, value)
            self.assertEqual(value["name"], name)
        self.assertEqual(
            normalize_tag_event({"tag_id": tag, "device_id": reader}),
            {
                "tag_id": tag,
                "device_id": reader,
            },
        )

    def test_missing_or_null_reader_is_absent_not_coerced(self) -> None:
        for value in ({"tag_id": "123"}, {"tag_id": "123", "device_id": None, "name": None}):
            self.assertEqual(normalize_tag_event(value), {"tag_id": "123"})

    def test_malformed_and_unknown_envelopes_reject(self) -> None:
        cases: list[Any] = [None, [], {}, {"name": "tag"}]
        invalid: Any
        name: Any
        for field in ("tag_id", "device_id"):
            for invalid in (True, 1, [], {}, "", "\n", "\ud800", "x" * 257):
                cases.append({"tag_id": "synthetic", field: invalid})
        cases.append({"tag_id": None})
        for name in (True, 1, [], {}):
            cases.append({"tag_id": "synthetic", "name": name})
        for key in ("extra", "spotify_uri", "playback_profile_id", "target", "reader_id"):
            cases.append({"tag_id": "synthetic", "name": None, key: "override"})
        for value in cases:
            with self.subTest(value=repr(value)):
                self.assertIsNone(normalize_tag_event(value))
