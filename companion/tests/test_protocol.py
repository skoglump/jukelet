"""Synthetic contract cases, no Home Assistant or credentials required."""

import unittest
from typing import Any

from companion.custom_components.jukelet_bridge.protocol import (
    ProtocolError,
    validate_snapshot,
)


class ProtocolTests(unittest.TestCase):
    def test_missing_envelope_is_rejected(self) -> None:
        with self.assertRaises(ProtocolError):
            validate_snapshot({})

    def test_golden_vectors_preserve_unicode_and_exact_ids(self) -> None:
        import hashlib
        import json
        from pathlib import Path

        from companion.custom_components.jukelet_bridge.protocol import checksum

        vectors = json.loads(
            (Path(__file__).parents[2] / "spikes/ha_companion/vectors/checksums.json").read_text()
        )
        for vector in vectors:
            with self.subTest(vector["name"]):
                self.assertEqual(
                    hashlib.sha256(vector["canonical_utf8"].encode()).hexdigest(), vector["sha256"]
                )
                self.assertEqual(checksum(vector["payload"]), vector["sha256"])
                vector["payload"]["mappings"].reverse()
                self.assertEqual(checksum(vector["payload"]), vector["sha256"])

    def test_rejects_malformed_values_without_coercion(self) -> None:
        import copy

        from spikes.ha_companion.tests.test_bridge import snapshot

        invalid = []
        envelope_cases: dict[str, list[Any]] = {
            "schema_version": [True, 1.0, 2, "1"],
            "revision": [True, 0, -1, 1.0, 2**53],
            "expected_active_revision": [False, 0, -1, 1.0],
            "publisher_id": ["bad", "00000000-0000-4000-8000-00000000001A"],
            "payload_checksum": ["0" * 64, None],
            "payload": [{"mappings": {}}, {"mappings": [], "extra": 1}],
        }
        for key, values in envelope_cases.items():
            for value in values:
                item = snapshot()
                item[key] = value
                invalid.append(item)
        row_cases: dict[str, list[Any]] = {
            "tag_id": ["", "x" * 257, "\x00", "\ud800", None, 42],
            "media_type": ["track", "playlist", [], 1],
            "spotify_uri": ["spotify:album:short", "https://example.invalid", None],
            "enabled": [1, "true"],
            "shuffle": [0, None],
            "playback_profile_id": ["script.anything", None],
        }
        for key, values in row_cases.items():
            for value in values:
                item = snapshot()
                item["payload"]["mappings"][0][key] = value
                invalid.append(item)
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(ProtocolError):
                validate_snapshot(item)
        duplicate = snapshot()
        duplicate["payload"]["mappings"] *= 2
        with self.assertRaises(ProtocolError):
            validate_snapshot(duplicate)
        extra = snapshot()
        extra["ignored"] = True
        with self.assertRaises(ProtocolError):
            validate_snapshot(extra)
        item = snapshot()
        detached = validate_snapshot(item)
        original = copy.deepcopy(detached)
        item["payload"]["mappings"].clear()
        self.assertEqual(detached, original)

    def test_mapping_and_encoded_size_limits(self) -> None:
        from companion.custom_components.jukelet_bridge.protocol import checksum
        from spikes.ha_companion.tests.test_bridge import snapshot

        value = snapshot()
        row = value["payload"]["mappings"][0]
        value["payload"]["mappings"] = [{**row, "tag_id": str(i)} for i in range(1000)]
        value["payload_checksum"] = checksum(value["payload"])
        self.assertEqual(len(validate_snapshot(value)["payload"]["mappings"]), 1000)
        value["payload"]["mappings"].append({**row, "tag_id": "1001"})
        with self.assertRaises(ProtocolError):
            validate_snapshot(value)
        value["payload"]["mappings"] = [{**row, "tag_id": str(i) + "x" * 250} for i in range(900)]
        value["payload_checksum"] = checksum(value["payload"])
        with self.assertRaisesRegex(ProtocolError, "snapshot_too_large"):
            validate_snapshot(value)
