"""Synthetic reviewed administrative controls; no HA, credentials or playback."""

import unittest
from typing import Any

from companion.custom_components.jukelet_bridge.bridge import Bridge
from companion.custom_components.jukelet_bridge.dispatcher import Dispatcher
from companion.custom_components.jukelet_bridge.protocol import PUBLISHER, ProtocolError
from companion.tests.fixtures import MemoryStore, snapshot
from companion.tests.test_dispatcher import Transport


class AdministrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.bridge = Bridge(PUBLISHER, MemoryStore(), lambda: False, MemoryStore())
        await self.bridge.initialize()
        await self.bridge.publish(snapshot())
        self.transport = Transport()
        self.now = 1.0
        self.ready = True
        self.dispatcher = Dispatcher(
            self.bridge,
            self.transport,
            {"default": "script.synthetic"},
            MemoryStore(),
            lambda script: self.ready,
            clock=lambda: self.now,
        )
        await self.dispatcher.start()

    async def test_separate_attested_reconcile_and_legacy_checked_enable(self) -> None:
        reviewed = await self.dispatcher.review_control()
        with self.assertRaisesRegex(ProtocolError, "confirmation_required"):
            await self.dispatcher.guarded_control("reconcile", reviewed)
        reviewed = await self.dispatcher.review_control()
        await self.dispatcher.guarded_control("reconcile", reviewed, confirmed_stopped=True)
        self.assertFalse(self.dispatcher.enabled)
        self.assertFalse(self.dispatcher.uncertain)
        reviewed = await self.dispatcher.review_control()
        with self.assertRaisesRegex(ProtocolError, "confirmation_required"):
            await self.dispatcher.guarded_control("enable", reviewed)
        reviewed = await self.dispatcher.review_control()
        await self.dispatcher.guarded_control("enable", reviewed, confirmed_legacy_disabled=True)
        self.assertTrue(self.dispatcher.enabled)
        self.assertEqual(self.transport.calls, [])

    async def test_stale_age_snapshot_operation_and_restart_reject(self) -> None:
        for change in ("expiry", "snapshot", "operation", "restart"):
            with self.subTest(change=change):
                reviewed = await self.dispatcher.review_control()
                if change == "expiry":
                    self.now += 61
                elif change == "snapshot":
                    await self.bridge.publish(snapshot(2, 1))
                elif change == "operation":
                    await self.dispatcher.control("disable")
                else:
                    self.dispatcher.control_instance = "replacement"
                with self.assertRaisesRegex(ProtocolError, "stale_state"):
                    await self.dispatcher.guarded_control(
                        "reconcile", reviewed, confirmed_stopped=True
                    )
                self.assertTrue(self.dispatcher.uncertain)
        self.assertEqual(self.transport.calls, [])

    async def test_busy_operations_reject_instead_of_queue(self) -> None:
        reviewed = await self.dispatcher.review_control()
        async with self.dispatcher.control_lock:
            with self.assertRaisesRegex(ProtocolError, "busy"):
                await self.dispatcher.guarded_control("disable", reviewed)
        async with self.bridge.lock:
            with self.assertRaisesRegex(ProtocolError, "busy"):
                await self.dispatcher.guarded_control("disable", reviewed)
        self.assertFalse(self.dispatcher.enabled)

    async def test_action_outcome_is_separate_from_independent_readback(self) -> None:
        from companion.custom_components.jukelet_bridge.administration import Administration

        admin = Administration(lambda: self.dispatcher)
        reviewed = await self.dispatcher.review_control()
        original = self.dispatcher.guarded_control
        writes = 0

        async def lost_ack(*args: Any, **kwargs: Any) -> dict[str, Any]:
            nonlocal writes
            writes += 1
            await original(*args, **kwargs)
            raise TimeoutError("private details must not escape")

        self.dispatcher.guarded_control = lost_ack  # type: ignore[method-assign]
        result = await admin.act("reconcile", reviewed, confirmed_stopped=True)
        self.assertEqual(result.outcome, "uncertain")
        self.assertFalse(result.observation["diagnostics"]["execution_uncertain"])  # type: ignore[index]
        self.assertFalse(result.observation["diagnostics"]["dispatch_enabled"])  # type: ignore[index]
        self.assertEqual(writes, 1)
        self.assertNotIn("private", str(result))
        self.dispatcher.guarded_control = original  # type: ignore[method-assign]
        reviewed = await self.dispatcher.review_control()
        result = await admin.act("enable", reviewed)
        self.assertEqual((result.outcome, result.error), ("rejected", "confirmation_required"))
        self.assertIsNotNone(result.observation)
        self.assertEqual(self.transport.calls, [])

    async def test_malformed_ack_failed_readback_and_replaced_dispatcher(self) -> None:
        from companion.custom_components.jukelet_bridge.administration import Administration

        current: Dispatcher | None = self.dispatcher
        admin = Administration(lambda: current)
        original = self.dispatcher.guarded_control
        original_status = self.bridge.status
        reads = 0

        async def counted_read() -> dict[str, Any]:
            nonlocal reads
            reads += 1
            return await original_status()

        self.bridge.status = counted_read  # type: ignore[method-assign]

        async def malformed(*args: Any, **kwargs: Any) -> dict[str, Any]:
            await original(*args, **kwargs)
            return {"dispatch_enabled": "false"}

        self.dispatcher.guarded_control = malformed  # type: ignore[method-assign]
        result = await admin.act("disable", await self.dispatcher.review_control())
        self.assertEqual(result.outcome, "uncertain")
        self.assertEqual(reads, 1)
        self.assertIsNotNone(result.observation)

        async def failed_read() -> dict[str, Any]:
            raise TimeoutError("private upstream details")

        self.bridge.status = failed_read  # type: ignore[method-assign]
        result = await admin.act("disable", await self.dispatcher.review_control())
        self.assertEqual((result.outcome, result.error), ("uncertain", "readback_unavailable"))
        self.assertIsNone(result.observation)
        self.bridge.status = original_status  # type: ignore[method-assign]

        async def unloaded(*args: Any, **kwargs: Any) -> dict[str, Any]:
            nonlocal current
            result = await original(*args, **kwargs)
            current = None
            return result

        self.dispatcher.guarded_control = unloaded  # type: ignore[method-assign]
        result = await admin.act("disable", await self.dispatcher.review_control())
        self.assertEqual(result.outcome, "uncertain")
        self.assertIsNone(result.observation)
        self.assertEqual(self.transport.calls, [])

    async def test_readiness_guards_and_snapshot_history_unchanged(self) -> None:
        from companion.custom_components.jukelet_bridge.administration import Administration
        from companion.custom_components.jukelet_bridge.protocol import checksum

        admin = Administration(lambda: self.dispatcher)
        await self.dispatcher.control("reconcile", True)
        baseline = await self.bridge.recovery_view()
        for condition in ("uncertain", "script", "snapshot", "preferences"):
            with self.subTest(condition=condition):
                self.dispatcher.uncertain = condition == "uncertain"
                self.ready = condition != "script"
                self.bridge.health = "degraded" if condition == "snapshot" else "healthy"
                self.bridge.active = snapshot()
                if condition == "preferences":
                    self.bridge.active["payload"]["mappings"][0]["shuffle"] = True
                    self.bridge.active["payload_checksum"] = checksum(self.bridge.active["payload"])
                result = await admin.act(
                    "enable", await self.dispatcher.review_control(), confirmed_legacy_disabled=True
                )
                self.assertEqual(result.outcome, "rejected")
                self.assertFalse(self.dispatcher.enabled)
        self.bridge.active = snapshot()
        self.bridge.health, self.ready, self.dispatcher.uncertain = "healthy", True, False
        self.assertEqual(
            (await self.bridge.recovery_view())["precondition"], baseline["precondition"]
        )
        self.assertEqual(self.transport.calls, [])
