"""Synthetic dispatcher behavior; no HA or playback services required."""

import asyncio
import unittest
from typing import Any

from companion.custom_components.jukelet_bridge.bridge import Bridge
from companion.custom_components.jukelet_bridge.dispatcher import (
    MAX_DIAGNOSTICS,
    MAX_DUPLICATES,
    Dispatcher,
)
from companion.custom_components.jukelet_bridge.protocol import (
    PUBLISHER,
    ProtocolError,
    checksum,
)
from companion.tests.fixtures import MemoryStore, snapshot


class CaptureTests(unittest.IsolatedAsyncioTestCase):
    async def test_admission_requires_healthy_detached_snapshot(self) -> None:
        bridge = Bridge(PUBLISHER, MemoryStore(), lambda: False, MemoryStore())
        await bridge.initialize()
        with self.assertRaises(ProtocolError):
            await bridge.capture()
        await bridge.publish(snapshot())
        captured = await bridge.capture()
        captured["payload"]["mappings"].clear()
        self.assertEqual((await bridge.status())["mapping_count"], 1)
        bridge.health = "degraded"
        with self.assertRaises(ProtocolError):
            await bridge.capture()


class Transport:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.gate = asyncio.Event()
        self.gate.set()
        self.response: str = "finished"

    async def invoke(self, script: str, variables: dict[str, Any]) -> object:
        self.calls.append(variables)
        await self.gate.wait()
        if self.response == "error":
            raise RuntimeError("never expose private exception")
        if self.response == "absent":
            return None
        return {
            "contract_version": 1,
            "correlation_id": "wrong"
            if self.response == "mismatched"
            else variables["correlation_id"],
            "snapshot_revision": variables["snapshot_revision"],
            "execution": "failed"
            if self.response in {"readiness_failed", "mismatched"}
            else self.response,
            "error": None
            if self.response == "finished"
            else "readiness_failed"
            if self.response in {"readiness_failed", "mismatched"}
            else "playback_failed",
        }


class DispatcherTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.bridge = Bridge(PUBLISHER, MemoryStore(), lambda: False, MemoryStore())
        await self.bridge.initialize()
        await self.bridge.publish(snapshot())
        self.transport = Transport()
        self.fence = MemoryStore()
        self.now = 1.0
        self.ready = True
        self.dispatcher = Dispatcher(
            self.bridge,
            self.transport,
            {"default": "script.synthetic"},
            self.fence,
            lambda script: self.ready,
            clock=lambda: self.now,
            timeout=0.05,
        )
        await self.dispatcher.start()
        await self.dispatcher.control("reconcile", True)
        await self.dispatcher.control("enable")

    async def scan(self, value: object = None) -> None:
        self.dispatcher.scan(value if value is not None else {"tag_id": "SYNTHETIC_Å"})
        if self.dispatcher.task is not None:
            assert self.dispatcher.task is not None
            await self.dispatcher.task

    async def test_operational_read_is_bounded_timed_and_never_changes_execution(
        self,
    ) -> None:
        await self.scan()
        self.bridge.health = "degraded"
        before = (self.dispatcher.enabled, self.dispatcher.uncertain, self.fence.data)
        view = self.dispatcher.operational_diagnostics()
        self.assertEqual(view["diagnostics_version"], 1)
        self.assertFalse(view["ready"])
        self.assertEqual(view["readiness_error"], "snapshot_unavailable")
        self.assertEqual(view["last_attempt"]["execution"], "finished")
        self.assertEqual(view["last_attempt"]["snapshot_revision"], 1)
        self.assertTrue(view["last_attempt"]["requested_at"])
        self.assertTrue(view["last_attempt"]["completed_at"])
        self.assertTrue(view["last_scan_at"])
        self.assertEqual(
            before,
            (self.dispatcher.enabled, self.dispatcher.uncertain, self.fence.data),
        )
        self.assertEqual(len(self.transport.calls), 1)
        for _ in range(MAX_DIAGNOSTICS + 10):
            self.dispatcher.scan({"tag_id": "unknown"})
        view = self.dispatcher.operational_diagnostics()
        self.assertEqual(len(view["diagnostics"]), MAX_DIAGNOSTICS)
        self.assertEqual(view["last_attempt"]["execution"], "finished")
        self.assertNotIn("SYNTHETIC_Å", str(view))
        self.assertNotIn("script.synthetic", str(view))
        # New timestamps do not silently alter the existing v1 record schema.
        self.assertNotIn("observed_at", self.dispatcher.diagnostics[-1])

    async def test_known_failure_requires_matching_completion_and_read_cannot_clear_fence(
        self,
    ) -> None:
        for outcome, execution, error in (
            ("readiness_failed", "failed", "readiness_failed"),
            ("mismatched", "unknown", "invalid_completion"),
            ("absent", "unknown", "completion_unavailable"),
        ):
            self.transport.response = outcome
            self.now += 3
            await self.scan()
            await (
                self.bridge.status()
            )  # Existing publication polling must not erase pause provenance.
            view = self.dispatcher.operational_diagnostics()
            self.assertEqual(view["last_attempt"]["execution"], execution)
            self.assertEqual(view["last_attempt"]["error"], error)
            self.assertEqual(view["pause_reason"], "execution_uncertain")
            self.assertTrue(view["execution_uncertain"])
            self.assertFalse(view["dispatch_enabled"])
            self.assertEqual(self.fence.data, {"version": 1, "uncertain": True})
            await self.dispatcher.control("reconcile", True)
            await self.dispatcher.control("enable")
        self.assertEqual(len(self.transport.calls), 3)

    async def test_startup_history_is_empty_after_reload_and_status_preserves_reason(
        self,
    ) -> None:
        await self.scan()
        await self.dispatcher.close()
        fresh = Dispatcher(
            self.bridge,
            self.transport,
            {"default": "script.synthetic"},
            self.fence,
            lambda script: True,
        )
        await fresh.start()
        await self.bridge.status()
        view = fresh.operational_diagnostics()
        self.assertEqual(view["pause_reason"], "startup")
        self.assertFalse(view["dispatch_enabled"])
        self.assertTrue(view["ready"])
        self.assertIsNone(view["last_scan_at"])
        self.assertIsNone(view["last_attempt"])
        self.assertEqual(view["diagnostics"], [])

    async def test_one_revision_exact_context_and_publication_while_running(
        self,
    ) -> None:
        self.transport.gate.clear()
        self.dispatcher.scan({"tag_id": "SYNTHETIC_Å", "device_id": " Reader e\u0301 "})
        while not self.transport.calls:
            await asyncio.sleep(0)
        updated = snapshot(2, 1)
        updated["payload"]["mappings"][0]["spotify_uri"] = "spotify:album:" + "B" * 22
        updated["payload_checksum"] = checksum(updated["payload"])
        await self.bridge.publish(updated)
        self.dispatcher.scan({"tag_id": "SYNTHETIC_Å", "device_id": "other"})
        self.transport.gate.set()
        assert self.dispatcher.task is not None
        await self.dispatcher.task
        self.assertEqual(len(self.transport.calls), 1)
        request = self.transport.calls[0]
        self.assertEqual(request["snapshot_revision"], 1)
        self.assertEqual(request["spotify_uri"], "spotify:album:" + "A" * 22)
        self.assertEqual(request["reader_id"], " Reader e\u0301 ")
        self.assertTrue(request["correlation_id"])
        self.assertEqual(self.dispatcher.diagnostics[-1]["playback_verification"], "unavailable")
        self.assertIn("ignored_busy", [d["reason"] for d in self.dispatcher.diagnostics])

    async def test_invalid_events_unknown_disabled_never_execute(self) -> None:
        event: object
        for event in (
            {},
            {"tag_id": ""},
            {"tag_id": "SYNTHETIC_Å", "device_id": None},
            {"tag_id": "SYNTHETIC_Å", "name": None},
            {"tag_id": "SYNTHETIC_Å", "service": "evil"},
            {"tag_id": "unknown"},
            {"tag_id": "SYNTHETIC_Å\n"},
            {"tag_id": "\ud800"},
            [],
        ):
            await self.scan(event)
        updated = snapshot(2, 1)
        updated["payload"]["mappings"][0]["enabled"] = False
        updated["payload_checksum"] = checksum(updated["payload"])
        await self.bridge.publish(updated)
        await self.scan()
        self.assertEqual(self.transport.calls, [])

    async def test_duplicate_expiry_reader_context_and_memory_bounds(self) -> None:
        await self.scan()
        await self.scan()
        self.assertEqual(len(self.transport.calls), 1)
        await self.scan({"tag_id": "SYNTHETIC_Å", "device_id": "reader"})
        self.assertEqual(len(self.transport.calls), 2)
        self.now += 2
        await self.scan()
        self.assertEqual(len(self.transport.calls), 3)
        for index in range(MAX_DUPLICATES + 3):
            await self.scan({"tag_id": "SYNTHETIC_Å", "device_id": str(index)})
        self.assertEqual(len(self.dispatcher.seen), MAX_DUPLICATES)
        self.assertEqual(len(self.dispatcher.diagnostics), MAX_DIAGNOSTICS)

    async def test_activation_failure_and_publication_cannot_reenable(self) -> None:
        self.bridge.health = "degraded"
        self.assertFalse((await self.bridge.status())["dispatch_enabled"])
        self.bridge.health = "healthy"
        await self.bridge.publish(snapshot(2, 1))
        self.assertFalse((await self.bridge.status())["dispatch_enabled"])
        self.ready = False
        with self.assertRaises(ProtocolError):
            await self.dispatcher.control("enable")
        await self.scan()
        self.assertEqual(self.transport.calls, [])

    async def test_preference_conflicts_visible_before_activation(self) -> None:
        updated = snapshot(2, 1)
        updated["payload"]["mappings"][0]["shuffle"] = True
        updated["payload_checksum"] = checksum(updated["payload"])
        await self.bridge.publish(updated)
        status = await self.bridge.status()
        self.assertFalse(status["dispatch_enabled"])
        self.assertEqual(status["dispatcher"]["readiness_error"], "preference_conflict")
        with self.assertRaises(ProtocolError):
            await self.dispatcher.control("enable")
        await self.scan()
        self.assertEqual(self.transport.calls, [])

    async def test_timeout_disable_reenable_reload_and_restart_never_replay(self) -> None:
        self.transport.gate.clear()
        await self.scan()
        self.assertTrue(self.dispatcher.uncertain)
        self.assertFalse(self.dispatcher.enabled)
        for action in ("enable", "reconcile"):
            with self.assertRaises(ProtocolError):
                await self.dispatcher.control(action)
        await self.dispatcher.close()
        fresh = Dispatcher(
            self.bridge,
            self.transport,
            {"default": "script.synthetic"},
            self.fence,
            lambda script: True,
        )
        await fresh.start()
        self.assertTrue(fresh.uncertain)
        self.assertFalse(fresh.enabled)
        with self.assertRaises(ProtocolError):
            await fresh.control("enable")
        self.transport.gate.set()
        await fresh.control("reconcile", True)
        self.assertFalse(fresh.enabled)
        self.assertEqual(len(self.transport.calls), 1)
        await fresh.control("enable")
        fresh.scan({"tag_id": "SYNTHETIC_Å"})
        assert fresh.task is not None
        await fresh.task
        self.assertEqual(len(self.transport.calls), 2)

    async def test_cancellation_and_disable_do_not_release_busy(self) -> None:
        self.transport.gate.clear()
        self.dispatcher.scan({"tag_id": "SYNTHETIC_Å"})
        while not self.transport.calls:
            await asyncio.sleep(0)
        await self.dispatcher.control("disable")
        with self.assertRaises(ProtocolError):
            await self.dispatcher.control("enable")
        with self.assertRaises(ProtocolError):
            await self.dispatcher.control("reconcile", True)
        assert self.dispatcher.task is not None
        self.dispatcher.task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            assert self.dispatcher.task is not None
            await self.dispatcher.task
        self.assertTrue(self.dispatcher.uncertain)
        self.assertFalse(self.dispatcher.enabled)
        self.assertEqual(len(self.transport.calls), 1)

    async def test_failure_and_absent_telemetry_latch_uncertainty(self) -> None:
        for result in ("error", "absent", "failed"):
            self.transport.response = result
            self.now += 3
            await self.scan()
            self.assertTrue(self.dispatcher.uncertain)
            self.assertFalse(self.dispatcher.enabled)
            await self.dispatcher.control("reconcile", True)
            await self.dispatcher.control("enable")
        self.assertEqual(len(self.transport.calls), 3)

    async def test_corrupt_mapping_and_missing_profile_fail_safely(self) -> None:
        assert self.bridge.active is not None
        self.bridge.active["payload"]["mappings"][0]["media_type"] = "track"
        await self.scan()
        self.assertEqual(self.transport.calls, [])
        fresh = Dispatcher(self.bridge, self.transport, {}, self.fence, lambda script: True)
        await fresh.start()
        with self.assertRaises(ProtocolError):
            await fresh.control("enable")
        with self.assertRaises(ProtocolError):
            Dispatcher(
                self.bridge,
                self.transport,
                {"evil": "script.synthetic"},
                self.fence,
                lambda script: True,
            )

    async def test_failed_fence_readback_prevents_invocation(self) -> None:
        self.fence.swallow_failure = True
        await self.scan()
        self.assertEqual(self.transport.calls, [])
        self.assertTrue(self.dispatcher.uncertain)
        self.assertFalse(self.dispatcher.enabled)

    async def test_playlist_and_recovery_disable_without_changing_allowlist(self) -> None:
        updated = snapshot(2, 1)
        row = updated["payload"]["mappings"][0]
        row.update(media_type="playlist", spotify_uri="spotify:playlist:" + "P" * 22, shuffle=True)
        updated["payload_checksum"] = checksum(updated["payload"])
        view = await self.bridge.recovery_view()
        await self.bridge.recover(updated, view["precondition"])
        self.assertFalse(self.dispatcher.enabled)
        await self.scan()
        self.assertEqual(self.transport.calls, [])
        await self.dispatcher.control("enable")
        await self.scan()
        self.assertEqual(self.transport.calls[0]["media_type"], "playlist")
        self.assertTrue(self.transport.calls[0]["shuffle"])

    async def test_capture_wait_reserves_busy_and_disable_prevents_late_start(self) -> None:
        async with self.bridge.lock:
            self.dispatcher.scan({"tag_id": "SYNTHETIC_Å"})
            await asyncio.sleep(0)
            self.dispatcher.scan({"tag_id": "SYNTHETIC_Å", "device_id": "other"})
            await self.dispatcher.control("disable")
        assert self.dispatcher.task is not None
        await self.dispatcher.task
        self.assertEqual(self.transport.calls, [])
        self.assertIn("ignored_busy", [d["reason"] for d in self.dispatcher.diagnostics])
        await self.dispatcher.control("enable")
        await asyncio.sleep(0)
        self.assertEqual(self.transport.calls, [])

    async def test_failed_publication_disables_without_status_poll(self) -> None:
        assert isinstance(self.bridge.store, MemoryStore)
        self.bridge.store.swallow_failure = True
        with self.assertRaises(ProtocolError):
            await self.bridge.publish(snapshot(2, 1))
        self.assertFalse(self.dispatcher.enabled)
        await self.scan()
        self.assertEqual(self.transport.calls, [])

    async def test_unload_drains_without_cancelling_or_accepting_new_attempt(self) -> None:
        self.transport.gate.clear()
        self.dispatcher.scan({"tag_id": "SYNTHETIC_Å"})
        while not self.transport.calls:
            await asyncio.sleep(0)
        close = asyncio.create_task(self.dispatcher.close())
        await asyncio.sleep(0)
        self.dispatcher.scan({"tag_id": "SYNTHETIC_Å", "device_id": "other"})
        self.assertFalse(close.done())
        self.transport.gate.set()
        await close
        self.assertFalse(self.dispatcher.enabled)
        self.assertFalse(self.dispatcher.uncertain)
        self.assertEqual(len(self.transport.calls), 1)

    async def test_missing_corrupt_and_coerced_fences_never_certify_idle(self) -> None:
        for value in (
            None,
            {},
            {"version": True, "uncertain": 0},
            {"version": 1, "uncertain": 0},
            {"version": 1, "uncertain": False, "extra": 1},
        ):
            self.fence.data = value
            fresh = Dispatcher(
                self.bridge,
                self.transport,
                {"default": "script.synthetic"},
                self.fence,
                lambda script: True,
            )
            await fresh.start()
            self.assertTrue(fresh.uncertain)
            with self.assertRaises(ProtocolError):
                await fresh.control("enable")
            self.fence.swallow_failure = True
            with self.assertRaises(ProtocolError):
                await fresh.control("reconcile", True)
            self.fence.swallow_failure = False

    async def test_reconcile_write_is_drained_despite_waiter_cancellation(self) -> None:
        for cancel_waiter in (False, True):
            with self.subTest(cancel_waiter=cancel_waiter):
                fence = GatedClearStore()
                old = Dispatcher(
                    self.bridge,
                    self.transport,
                    {"default": "script.synthetic"},
                    fence,
                    lambda script: True,
                )
                await old.start()
                reconcile = asyncio.create_task(old.control("reconcile", True))
                await fence.entered.wait()
                if cancel_waiter:
                    reconcile.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await reconcile
                close = asyncio.create_task(old.close())
                await asyncio.sleep(0)
                try:
                    self.assertFalse(
                        close.done(), "unload must drain the administrative disk write"
                    )
                    self.assertFalse(fence.cancelled)
                    fence.release.set()
                    await close
                    if not cancel_waiter:
                        await reconcile
                    fresh = Dispatcher(
                        self.bridge,
                        self.transport,
                        {"default": "script.synthetic"},
                        fence,
                        lambda script: True,
                    )
                    await fresh.start()
                    await fresh.control("enable")
                    self.transport.gate.clear()
                    fresh.scan({"tag_id": "SYNTHETIC_Å"})
                    while not self.transport.calls:
                        await asyncio.sleep(0)
                    self.assertEqual(fence.data, {"version": 1, "uncertain": True})
                    assert fresh.task is not None
                    fresh.task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await fresh.task
                    await fresh.close()
                    restarted = Dispatcher(
                        self.bridge,
                        self.transport,
                        {"default": "script.synthetic"},
                        fence,
                        lambda script: True,
                    )
                    await restarted.start()
                    self.assertTrue(restarted.uncertain)
                    with self.assertRaises(ProtocolError):
                        await restarted.control("enable")
                finally:
                    fence.release.set()
                    await asyncio.gather(reconcile, close, return_exceptions=True)
                    self.transport.gate.set()
                    self.transport.calls.clear()

    async def test_cancelled_execution_clear_is_drained_before_replacement(self) -> None:
        fence = GatedClearStore()
        old = Dispatcher(
            self.bridge,
            self.transport,
            {"default": "script.synthetic"},
            fence,
            lambda script: True,
        )
        await old.start()
        await old.control("enable")
        old.scan({"tag_id": "SYNTHETIC_Å"})
        await fence.entered.wait()
        assert old.task is not None
        old.task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await old.task
        close = asyncio.create_task(old.close())
        await asyncio.sleep(0)
        try:
            self.assertFalse(close.done(), "unload must drain the execution clear/readback")
            self.assertFalse(fence.cancelled)
            self.assertTrue(old.busy)
            with self.assertRaises(ProtocolError):
                await old.control("enable")
            # A cancelled unload waiter is not completion. A subsequent unload still waits.
            close.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await close
            close = asyncio.create_task(old.close())
            await asyncio.sleep(0)
            self.assertFalse(close.done())
        finally:
            fence.release.set()
            await close
        self.assertEqual(fence.data, {"version": 1, "uncertain": False})
        self.assertFalse(fence.cancelled)

    async def test_recovery_precondition_excludes_scan_diagnostics_and_execution(self) -> None:
        await self.dispatcher.control("disable")
        preview = await self.bridge.recovery_view()
        self.dispatcher.scan({"tag_id": "unknown"})
        await self.dispatcher.control("enable")
        await self.scan()
        self.assertEqual(
            preview["precondition"], (await self.bridge.recovery_view())["precondition"]
        )
        await self.bridge.recover(snapshot(2, 1), preview["precondition"])
        self.assertEqual((await self.bridge.status())["active_revision"], 2)
        with self.assertRaises(ProtocolError):
            await self.bridge.recover(snapshot(3, 2), preview["precondition"])


class GatedClearStore(MemoryStore):
    """Pause one clear at the persistence boundary, reporting waiter cancellation."""

    def __init__(self) -> None:
        super().__init__()
        self.data = {"version": 1, "uncertain": False}
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = False

    async def save(self, value: dict[str, Any]) -> None:
        if not value["uncertain"] and not self.entered.is_set():
            self.entered.set()
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        await super().save(value)
