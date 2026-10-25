"""Synthetic playback boundary fixtures; no household services or credentials."""

import asyncio
import unittest
from typing import Any

from companion.custom_components.jukelet_bridge.playback import (
    PlaybackAdapter,
    ScriptFailed,
    ScriptUnavailable,
    validate_request,
)
from companion.custom_components.jukelet_bridge.protocol import ProtocolError


def request(**changes: Any) -> dict[str, Any]:
    return {
        "tag_id": "  Synthetic e\u0301 / 🦊  ",
        "media_type": "album",
        "spotify_uri": "spotify:album:" + "A" * 22,
        "enabled": True,
        "shuffle": False,
        "playback_profile_id": "default",
        "snapshot_revision": 7,
        "correlation_id": "synthetic-request-1",
        "reader_id": " Synthetic Reader ",
        **changes,
    }


class RequestTests(unittest.TestCase):
    def test_rejects_mismatched_uri_before_invocation(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "invalid_request"):
            validate_request(request(media_type="playlist"))

    def test_strict_fields_limits_and_no_repairs(self) -> None:
        cases: dict[str, list[Any]] = {
            "tag_id": ["", "a" * 257, "é" * 129, "\x00", "\x7f", "\ud800", 3],
            "reader_id": [None, "", [], "\n", "x" * 257],
            "correlation_id": [None, "", True, "\udfff", "x" * 257],
            "media_type": ["track", "Album", [], True],
            "spotify_uri": ["spotify:album:short", "spotify:album:" + "é" * 22, None],
            "enabled": [None, "true", 1],
            "shuffle": [None, 0, "false"],
            "snapshot_revision": [0, -1, True, 1.0, 2**53, "7"],
            "playback_profile_id": ["script.anything", "other", None, [], " default"],
        }
        for key, values in cases.items():
            for value in values:
                with self.subTest(key=key, value=repr(value)), self.assertRaises(ProtocolError):
                    validate_request(request(**{key: value}))
        for key in request():
            item = request()
            del item[key]
            if key == "reader_id":
                self.assertEqual(validate_request(item), item)
            else:
                with self.assertRaises(ProtocolError):
                    validate_request(item)
        malformed_requests: list[object] = [[], None, request(extra=True)]
        for malformed in malformed_requests:
            with self.assertRaises(ProtocolError):
                validate_request(malformed)
        for kind, shuffle in (("album", False), ("playlist", True)):
            item = request(
                media_type=kind, spotify_uri=f"spotify:{kind}:" + "B" * 22, shuffle=shuffle
            )
            self.assertEqual(validate_request(item), item)
        item = request(tag_id=" " * 256, snapshot_revision=2**53 - 1)
        self.assertEqual(validate_request(item), item)

    def test_allowlist_and_deadline_are_explicit_and_strict(self) -> None:
        invalid_profiles: list[object] = [
            None,
            [],
            {"other": "script.synthetic"},
            {"default": None},
            {"default": "light.synthetic"},
            {"default": "script.turn_on"},
            {"default": "script.turn_off"},
            {"default": "script.toggle"},
            {"default": "script.reload"},
            {"default": "script.turn_on" + " "},
            {"default": "script.{{ template }}"},
            {"default": "script.UPPER"},
            {"default": "script." + "a" * 128},
        ]
        for profiles in invalid_profiles:
            with (
                self.subTest(profiles=profiles),
                self.assertRaisesRegex(ProtocolError, "invalid_profiles"),
            ):
                PlaybackAdapter(Stub(), profiles)
        invalid_timeouts: list[Any] = [
            None,
            False,
            True,
            "30",
            0,
            -1,
            300.01,
            10**1000,
            float("inf"),
            float("nan"),
        ]
        for timeout in invalid_timeouts:
            with self.assertRaisesRegex(ProtocolError, "invalid_timeout"):
                PlaybackAdapter(Stub(), {}, timeout=timeout)


def completion(item: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        "contract_version": 1,
        "correlation_id": item["correlation_id"],
        "snapshot_revision": item["snapshot_revision"],
        "execution": "finished",
        "error": None,
        **changes,
    }


class Stub:
    def __init__(self, response: object = None) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()

    async def invoke(self, script: str, variables: dict[str, Any]) -> object:
        self.calls.append((script, variables))
        self.started.set()
        await self.release.wait()
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_detached_request_and_local_resolution(self) -> None:
        original = request()
        stub = Stub(completion(original))
        stub.release.clear()
        profiles = {"default": "script.synthetic"}
        adapter = PlaybackAdapter(stub, profiles)
        profiles["default"] = "script.unapproved"
        item = dict(original)
        task = asyncio.create_task(adapter.execute(item))
        await stub.started.wait()
        item["tag_id"] = "changed"
        stub.release.set()
        result = await task
        self.assertEqual(stub.calls, [("script.synthetic", original)])
        self.assertEqual(
            (result.invocation, result.execution, result.error), ("accepted", "finished", None)
        )
        self.assertEqual(result.playback_verification, "unavailable")

    async def test_disabled_missing_and_unknown_profile_never_call(self) -> None:
        stub = Stub()
        for profiles, item, error in (
            ({}, request(), "profile_unconfigured"),
            ({"default": "script.synthetic"}, request(enabled=False), "disabled"),
        ):
            result = await PlaybackAdapter(stub, profiles).execute(item)
            self.assertEqual(
                (result.invocation, result.execution, result.error),
                ("rejected", "not_started", error),
            )
        for item in (request(playback_profile_id="unknown"), request(media_type="playlist")):
            with self.assertRaises(ProtocolError):
                await PlaybackAdapter(stub, {"default": "script.synthetic"}).execute(item)
        self.assertEqual(stub.calls, [])

    async def test_absent_invalid_and_uncorrelated_telemetry_never_claim_completion(self) -> None:
        responses: list[object] = [None, {}, [], True, "finished"]
        cases: dict[str, list[Any]] = {
            "contract_version": [True, 1.0, 2],
            "snapshot_revision": [True, 7.0, 8],
            "correlation_id": [False, "other"],
            "execution": [[], "verified", "accepted"],
            "error": ["private diagnostic", False],
        }
        for key, values in cases.items():
            responses.extend(completion(request(), **{key: value}) for value in values)
        responses.extend(
            [completion(request(), extra=True), completion(request(), playback_verified=True)]
        )
        for response in responses:
            with self.subTest(response=response):
                stub = Stub(response)
                result = await PlaybackAdapter(stub, {"default": "script.synthetic"}).execute(
                    request()
                )
                self.assertEqual((result.invocation, result.execution), ("accepted", "unknown"))
                self.assertEqual(result.playback_verification, "unavailable")
                self.assertEqual(len(stub.calls), 1)

    async def test_bounded_failure_codes_and_transport_uncertainty(self) -> None:
        for response, invocation, execution, error in (
            (
                completion(request(), execution="failed", error="readiness_failed"),
                "accepted",
                "failed",
                "readiness_failed",
            ),
            (
                completion(request(), execution="failed", error="private"),
                "accepted",
                "unknown",
                "invalid_completion",
            ),
            (ScriptUnavailable("private"), "rejected", "not_started", "script_unavailable"),
            (ScriptFailed("private"), "unknown", "failed", "script_failed"),
            (RuntimeError("private"), "unknown", "unknown", "transport_error"),
        ):
            stub = Stub(response)
            result = await PlaybackAdapter(stub, {"default": "script.synthetic"}).execute(request())
            self.assertEqual(
                (result.invocation, result.execution, result.error), (invocation, execution, error)
            )
            self.assertNotIn("private", repr(result))
            self.assertEqual(len(stub.calls), 1)

    async def test_timeout_and_cancellation_do_not_replay(self) -> None:
        stub = Stub()
        stub.release.clear()
        adapter = PlaybackAdapter(stub, {"default": "script.synthetic"}, timeout=0.01)
        result = await adapter.execute(request())
        self.assertEqual(
            (result.invocation, result.execution, result.error), ("unknown", "unknown", "timeout")
        )
        self.assertEqual(len(stub.calls), 1)
        stub = Stub()
        stub.release.clear()
        task = asyncio.create_task(
            PlaybackAdapter(stub, {"default": "script.synthetic"}).execute(request())
        )
        await stub.started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        stub.release.set()
        await asyncio.sleep(0)
        self.assertEqual(len(stub.calls), 1)

    async def test_concurrent_calls_keep_their_correlations_without_dispatch_policy(self) -> None:
        class Echo:
            async def invoke(self, script: str, variables: dict[str, Any]) -> object:
                await asyncio.sleep(0)
                return completion(variables)

        adapter = PlaybackAdapter(Echo(), {"default": "script.synthetic"})
        results = await asyncio.gather(
            *(adapter.execute(request(correlation_id=f"synthetic-{i}")) for i in range(3))
        )
        self.assertEqual(
            [result.correlation_id for result in results], [f"synthetic-{i}" for i in range(3)]
        )
        self.assertTrue(all(result.execution == "finished" for result in results))
