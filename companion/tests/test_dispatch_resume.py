"""Remembered operator choices, using synthetic stores and inert transport only."""

import asyncio
import copy
import unittest
from typing import Any

from companion.custom_components.jukelet_bridge.bridge import Bridge
from companion.custom_components.jukelet_bridge.dispatcher import Dispatcher
from companion.custom_components.jukelet_bridge.protocol import PUBLISHER, ProtocolError
from companion.tests.fixtures import MemoryStore, snapshot
from companion.tests.test_dispatcher import Transport


class DispatchResumeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.store, self.history = MemoryStore(), MemoryStore()
        self.fence, self.activation = MemoryStore(), MemoryStore()
        self.transport = Transport()
        self.ready = True
        bridge = Bridge(PUBLISHER, self.store, lambda: False, self.history)
        await bridge.initialize()
        await bridge.publish(snapshot())
        self.dispatcher = await self.restart()

    async def restart(self) -> Dispatcher:
        if hasattr(self, "dispatcher"):
            await self.dispatcher.close()
            await self.dispatcher.bridge.close()
        bridge = Bridge(PUBLISHER, self.store, lambda: False, self.history)
        await bridge.start()
        dispatcher = Dispatcher(
            bridge,
            self.transport,
            {"default": "script.synthetic"},
            self.fence,
            lambda script: self.ready,
            activation=self.activation,
        )
        await dispatcher.start()
        return dispatcher

    async def enable(self) -> None:
        await self.dispatcher.control("reconcile", True)
        await self.dispatcher.guarded_control(
            "enable",
            await self.dispatcher.review_control(),
            confirmed_legacy_disabled=True,
        )

    async def test_remembered_enable_waits_for_startup_and_never_starts_playback(self) -> None:
        await self.enable()
        self.dispatcher = await self.restart()
        self.assertFalse(self.dispatcher.enabled)
        await self.dispatcher.resume_after_startup()
        self.assertTrue((await self.dispatcher.bridge.status())["dispatch_enabled"])
        self.assertEqual(self.transport.calls, [])

    async def test_explicit_disable_survives_restart(self) -> None:
        await self.enable()
        await self.dispatcher.control("disable")
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)
        self.assertEqual(self.transport.calls, [])

    async def test_status_polled_during_healthy_shutdown_preserves_enabled_choice(self) -> None:
        await self.enable()
        self.dispatcher.bridge.stopping = lambda: True
        self.assertFalse((await self.dispatcher.bridge.status())["dispatch_enabled"])
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertTrue(self.dispatcher.enabled)
        self.assertEqual(self.transport.calls, [])

    async def test_scan_during_shutdown_drops_without_erasing_idle_choice(self) -> None:
        await self.enable()
        self.dispatcher.bridge.stopping = lambda: True
        self.dispatcher.scan({"tag_id": "SYNTHETIC_Å"})
        self.assertFalse(self.dispatcher.enabled)
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertTrue(self.dispatcher.enabled)
        self.assertEqual(self.transport.calls, [])

    async def test_retained_closed_dispatcher_cannot_overwrite_replacement_choice(self) -> None:
        await self.enable()
        old = self.dispatcher
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        saves = self.activation.saves
        for action in ("disable", "enable", "reconcile"):
            with self.assertRaisesRegex(ProtocolError, "shutting_down"):
                await old.control(action, True)
        self.assertEqual(self.activation.saves, saves)
        self.assertTrue(self.dispatcher.enabled)
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertTrue(self.dispatcher.enabled)

    async def test_first_install_never_enables_even_with_clear_fence(self) -> None:
        await self.dispatcher.control("reconcile", True)
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)

    async def test_unhealthy_or_uncertain_startup_revokes_resume_without_later_retry(self) -> None:
        for failure in ("script", "snapshot", "fence"):
            with self.subTest(failure=failure):
                self.ready = True
                await self.enable()
                history = copy.deepcopy(self.dispatcher.bridge.journal)
                if failure == "script":
                    self.ready = False
                elif failure == "snapshot":
                    self.history.data = {"damaged": True}
                else:
                    self.fence.data = {"version": 1, "uncertain": True}
                self.dispatcher = await self.restart()
                await self.dispatcher.resume_after_startup()
                self.assertFalse(self.dispatcher.enabled)
                self.ready = True
                self.history.data = history
                self.dispatcher = await self.restart()
                await self.dispatcher.resume_after_startup()
                self.assertFalse(self.dispatcher.enabled)
        self.assertEqual(self.transport.calls, [])

    async def test_missing_corrupt_and_coerced_choice_never_enables(self) -> None:
        await self.enable()
        valid = copy.deepcopy(self.activation.data)
        assert type(valid) is dict
        for value in (
            None,
            {},
            {**valid, "version": True},
            {**valid, "enabled": 1},
            {**valid, "identity": "A" * 64},
            {**valid, "extra": True},
        ):
            self.activation.data = value
            self.dispatcher = await self.restart()
            await self.dispatcher.resume_after_startup()
            self.assertFalse(self.dispatcher.enabled)
        self.assertEqual(self.transport.calls, [])

    async def test_configuration_change_or_recovery_requires_new_enable(self) -> None:
        await self.enable()
        self.dispatcher = await self.restart()
        self.dispatcher.timeout = 120
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)
        await self.enable()
        bridge = self.dispatcher.bridge
        await bridge.recover(snapshot(2, 1), (await bridge.recovery_view())["precondition"])
        self.assertFalse(self.dispatcher.enabled)
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)

    async def test_normal_publication_retains_enabled_choice_but_cannot_enable_disabled(
        self,
    ) -> None:
        await self.enable()
        await self.dispatcher.bridge.publish(snapshot(2, 1))
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertTrue(self.dispatcher.enabled)
        await self.dispatcher.control("disable")
        await self.dispatcher.bridge.publish(snapshot(3, 2))
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)

    async def test_execution_temporarily_revokes_resume_and_restores_only_on_finished(self) -> None:
        await self.enable()
        self.transport.gate.clear()
        self.dispatcher.scan({"tag_id": "SYNTHETIC_Å"})
        while not self.transport.calls:
            await asyncio.sleep(0)
        assert type(self.activation.data) is dict
        self.assertFalse(self.activation.data["enabled"])
        await self.dispatcher.bridge.publish(snapshot(2, 1))
        self.assertTrue(self.dispatcher.enabled)
        self.transport.gate.set()
        assert self.dispatcher.task is not None
        await self.dispatcher.task
        assert type(self.activation.data) is dict
        self.assertTrue(self.activation.data["enabled"])
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertTrue(self.dispatcher.enabled)
        self.assertEqual(len(self.transport.calls), 1)
        self.transport.response = "absent"
        self.dispatcher.scan({"tag_id": "SYNTHETIC_Å"})
        assert self.dispatcher.task is not None
        await self.dispatcher.task
        assert type(self.activation.data) is dict
        self.assertFalse(self.activation.data["enabled"])
        await self.dispatcher.control("reconcile", True)
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)
        self.assertEqual(len(self.transport.calls), 2)

    async def test_failed_activation_readback_rejects_enable_and_preserves_snapshot(self) -> None:
        await self.dispatcher.control("reconcile", True)
        before = copy.deepcopy(self.store.data)
        self.activation.swallow_failure = True
        with self.assertRaisesRegex(ProtocolError, "activation_uncertain"):
            await self.dispatcher.control("enable")
        self.assertFalse(self.dispatcher.enabled)
        self.assertEqual(self.store.data, before)
        self.assertEqual(self.transport.calls, [])

    async def test_readiness_loss_and_disable_before_startup_cancel_remembered_enable(self) -> None:
        await self.enable()
        self.ready = False
        await self.dispatcher.bridge.status()
        self.ready = True
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)

        await self.enable()
        self.dispatcher = await self.restart()
        await self.dispatcher.control("disable")
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)

    async def test_unreadable_choice_does_not_load_as_enabled(self) -> None:
        await self.enable()

        class UnreadableStore(MemoryStore):
            async def load(self) -> object:
                raise OSError("synthetic unreadable storage")

        self.activation = UnreadableStore()
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)
        self.assertEqual(self.transport.calls, [])

    async def test_cancelled_disable_is_durably_drained_before_replacement(self) -> None:
        await self.enable()

        class GatedStore(MemoryStore):
            def __init__(self) -> None:
                super().__init__()
                self.entered, self.release = asyncio.Event(), asyncio.Event()

            async def save(self, value: dict[str, Any]) -> None:
                self.entered.set()
                await self.release.wait()
                await super().save(value)

        gated = GatedStore()
        gated.data = copy.deepcopy(self.activation.data)
        self.activation = gated
        self.dispatcher.activation = gated
        caller = asyncio.create_task(self.dispatcher.control("disable"))
        await gated.entered.wait()
        caller.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await caller
        closing = asyncio.create_task(self.dispatcher.close())
        await asyncio.sleep(0)
        self.assertFalse(closing.done())
        gated.release.set()
        await closing
        self.dispatcher = await self.restart()
        await self.dispatcher.resume_after_startup()
        self.assertFalse(self.dispatcher.enabled)
