"""Exact exercised compatibility policy; no HA or credentials required."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from companion.custom_components.jukelet_bridge import async_setup, supported_ha
from companion.custom_components.jukelet_bridge.compatibility import version_policy


class CompatibilityTests(unittest.TestCase):
    def test_compatible_stable_releases_do_not_need_patch_allowlist_edits(self) -> None:
        for value in ("2026.10.3", "2026.10.4", "2026.11.0", "2027.1.12"):
            with self.subTest(version=value):
                self.assertTrue(supported_ha(value))

    def test_below_minimum_and_malformed_versions_are_not_supported(self) -> None:
        for value in (
            "2026.10.1",
            "2026.10.2",
            "2026.10",
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

    def test_previews_are_experimental_and_never_claim_tested(self) -> None:
        for value in ("2026.11.0b0", "2026.11.0b9", "2026.11.0.dev0"):
            result = version_policy(value)
            self.assertTrue(result.allowed)
            self.assertEqual(result.state, "untested")
            self.assertEqual(result.reason, "experimental_beta_dev")
        self.assertEqual(version_policy("2027.1.12").state, "expected_compatible")

    def test_noncanonical_calendar_versions_refused(self) -> None:
        for value in (
            "2026.13.0",
            "2026.0.1",
            "2026.01.1",
            "2026.10.04",
            "2026.11.0rc1",
            "2026.11.0b1+local",
        ):
            self.assertFalse(version_policy(value).allowed, value)

    def test_known_bad_release_is_actionable_and_not_allowed(self) -> None:
        with patch.dict(
            "companion.custom_components.jukelet_bridge.compatibility.KNOWN_INCOMPATIBLE",
            {"2026.11.0": "synthetic_issue_48"},
        ):
            result = version_policy("2026.11.0")
            self.assertFalse(result.allowed)
            self.assertEqual(result.state, "known_incompatible")
            self.assertEqual(result.reason, "synthetic_issue_48")

    def test_failed_contract_refuses_setup_without_mutating_existing_state(self) -> None:
        result = version_policy("2026.10.4")
        from dataclasses import replace

        result = replace(
            result, state="known_incompatible", allowed=False, reason="atomic_private_store"
        )
        hass = SimpleNamespace(data={"unrelated": object()})
        before = dict(hass.data)
        with patch(
            "companion.custom_components.jukelet_bridge.compatibility.compatibility",
            return_value=result,
        ):
            self.assertFalse(asyncio.run(async_setup(hass, {})))
        self.assertEqual(hass.data, before)

    def test_oversized_numeric_versions_are_bounded_malformed_refusals(self) -> None:
        for value in (
            "2026.10." + "9" * 5000,
            "2026.11.0b" + "9" * 5000,
            "2026.11.0.dev" + "9" * 5000,
        ):
            result = version_policy(value)
            self.assertFalse(result.allowed)
            self.assertEqual(result.reason, "malformed_version")
