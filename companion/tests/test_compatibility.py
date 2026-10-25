"""Exact exercised compatibility policy; no HA or credentials required."""

import unittest

from companion.custom_components.jukelet_bridge import supported_ha


class CompatibilityTests(unittest.TestCase):
    def test_exact_transition_and_preferred_core_releases(self) -> None:
        for value in ("2026.10.2", "2026.10.3"):
            with self.subTest(version=value):
                self.assertTrue(supported_ha(value))

    def test_unknown_future_and_malformed_versions_are_not_supported(self) -> None:
        for value in (
            "2026.10.1",
            "2026.10.4",
            "2026.11.0",
            "2026.10",
            "2026.10.3.dev0",
            "2026.10.3 ",
            " 2026.10.3",
            "",
            None,
            True,
            2026.103,
            ["2026.10.3"],
        ):
            with self.subTest(version=value):
                self.assertFalse(supported_ha(value))
