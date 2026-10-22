"""Synthetic production recovery tests; no HA or credentials required."""

import unittest

from companion.custom_components.jukelet_bridge.bridge import Bridge
from companion.custom_components.jukelet_bridge.protocol import PUBLISHER, ProtocolError
from companion.tests.fixtures import MemoryStore, snapshot


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_snapshot_after_restart_is_not_first_install(self) -> None:
        store, history = MemoryStore(), MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: False, history)
        await bridge.initialize()
        await bridge.publish(snapshot())
        store.data = None
        restarted = Bridge(PUBLISHER, store, lambda: False, history)
        await restarted.start()
        self.assertEqual((await restarted.status())["persistence"], "degraded")
        with self.assertRaisesRegex(ProtocolError, "recovery_required"):
            await restarted.publish(snapshot())

    async def new_bridge(self) -> tuple[Bridge, MemoryStore, MemoryStore]:
        store, history = MemoryStore(), MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: False, history)
        await bridge.initialize()
        return bridge, store, history

    async def test_recovery_is_explicit_monotonic_and_preconditioned(self) -> None:
        bridge, store, history = await self.new_bridge()
        await bridge.publish(snapshot())
        store.data = {"invalid": True}
        bridge = Bridge(PUBLISHER, store, lambda: False, history)
        await bridge.start()
        view = await bridge.recovery_view()
        with self.assertRaisesRegex(ProtocolError, "stale_revision"):
            await bridge.recover(snapshot(), view["precondition"])
        result = await bridge.recover(snapshot(2), view["precondition"])
        self.assertEqual(result["active_revision"], 2)
        self.assertFalse(result["dispatch_enabled"])
        with self.assertRaisesRegex(ProtocolError, "base_conflict"):
            await bridge.recover(snapshot(3, 2), view["precondition"])

    async def test_replacement_preserves_history_and_rejects_retired_identity(self) -> None:
        bridge, store, history = await self.new_bridge()
        await bridge.publish(snapshot(7))
        next_snapshot = snapshot(8, 7)
        replacement = "00000000-0000-4000-8000-000000000025"
        next_snapshot["publisher_id"] = replacement
        await bridge.recover(next_snapshot, (await bridge.recovery_view())["precondition"])
        restarted = Bridge(PUBLISHER, store, lambda: False, history)
        await restarted.start()
        self.assertEqual((await restarted.status())["publisher_id"], replacement)
        self.assertEqual((await restarted.status())["persistence"], "healthy")
        self.assertEqual(history.data["publishers"][PUBLISHER], 7)  # type: ignore[index]
        with self.assertRaisesRegex(ProtocolError, "publisher_mismatch"):
            await restarted.publish(snapshot(9, 8))
        with self.assertRaisesRegex(ProtocolError, "publisher_mismatch"):
            await restarted.recover(
                snapshot(9, 8), (await restarted.recovery_view())["precondition"]
            )

    async def test_missing_or_corrupt_history_cannot_be_reinitialized_or_recovered(self) -> None:
        for bad in (None, {"invalid": True}):
            bridge, store, history = await self.new_bridge()
            await bridge.publish(snapshot())
            history.data = bad
            restarted = Bridge(PUBLISHER, store, lambda: False, history)
            await restarted.start()
            self.assertEqual((await restarted.status())["persistence"], "degraded")
            with self.assertRaisesRegex(ProtocolError, "recovery_required"):
                await restarted.recover(
                    snapshot(2), (await restarted.recovery_view())["precondition"]
                )
            with self.assertRaisesRegex(ProtocolError, "recovery_required"):
                await restarted.initialize()

    async def test_journal_and_snapshot_partial_outcomes_fence_until_restart(self) -> None:
        for fail_history in (True, False):
            bridge, store, history = await self.new_bridge()
            await bridge.publish(snapshot())
            (history if fail_history else store).swallow_failure = True
            with self.assertRaisesRegex(ProtocolError, "persistence_uncertain"):
                await bridge.publish(snapshot(2, 1))
            self.assertEqual((await bridge.status())["active_revision"], 1)
            with self.assertRaisesRegex(ProtocolError, "recovery_required"):
                await bridge.recover(snapshot(3, 1), (await bridge.recovery_view())["precondition"])
            restarted = Bridge(PUBLISHER, store, lambda: False, history)
            await restarted.start()
            self.assertEqual(
                (await restarted.status())["persistence"], "healthy" if fail_history else "degraded"
            )
            if not fail_history:
                store.swallow_failure = False
                with self.assertRaisesRegex(ProtocolError, "stale_revision"):
                    await restarted.recover(
                        snapshot(2, 1), (await restarted.recovery_view())["precondition"]
                    )
                await restarted.recover(
                    snapshot(3, 1), (await restarted.recovery_view())["precondition"]
                )

    async def test_retry_conflicts_validation_and_one_concurrent_winner(self) -> None:
        import asyncio

        from companion.custom_components.jukelet_bridge.protocol import checksum

        bridge, store, history = await self.new_bridge()
        first = await bridge.publish(snapshot())
        self.assertEqual(await bridge.publish(snapshot()), first)
        self.assertEqual(store.saves, 1)
        self.assertEqual(history.saves, 2)
        changed = snapshot()
        changed["payload"]["mappings"] = []
        changed["payload_checksum"] = checksum(changed["payload"])
        for candidate, code in (
            (changed, "revision_conflict"),
            (snapshot(2), "base_conflict"),
            ({}, "invalid_snapshot"),
        ):
            with self.assertRaisesRegex(ProtocolError, code):
                await bridge.publish(candidate)
        results = await asyncio.gather(
            bridge.publish(snapshot(2, 1)), bridge.publish(snapshot(3, 1)), return_exceptions=True
        )
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(sum(isinstance(result, ProtocolError) for result in results), 1)

    async def test_cancelled_caller_and_unload_wait_for_readback(self) -> None:
        import asyncio

        entered, release = asyncio.Event(), asyncio.Event()

        class DelayedStore(MemoryStore):
            async def save(self, value: dict[str, object]) -> None:
                entered.set()
                await release.wait()
                await super().save(value)

        store, history = DelayedStore(), MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: False, history)
        await bridge.initialize()
        caller = asyncio.create_task(bridge.publish(snapshot()))
        await entered.wait()
        caller.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await caller
        closing = asyncio.create_task(bridge.close())
        status = asyncio.create_task(bridge.status())
        await asyncio.sleep(0)
        self.assertFalse(closing.done())
        self.assertFalse(status.done())
        release.set()
        await closing
        self.assertEqual((await status)["active_revision"], 1)
        with self.assertRaisesRegex(ProtocolError, "shutting_down"):
            await bridge.publish(snapshot(2, 1))

    async def test_shutdown_after_write_is_uncertain_and_restart_reconciles(self) -> None:
        stopping = False

        class StopStore(MemoryStore):
            async def save(self, value: dict[str, object]) -> None:
                nonlocal stopping
                await super().save(value)
                stopping = True

        store, history = StopStore(), MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: stopping, history)
        await bridge.initialize()
        with self.assertRaisesRegex(ProtocolError, "persistence_uncertain"):
            await bridge.publish(snapshot())
        self.assertEqual((await bridge.status())["active_revision"], None)
        restarted = Bridge(PUBLISHER, store, lambda: False, history)
        await restarted.start()
        self.assertEqual((await restarted.status())["active_revision"], 1)

    async def test_restored_behind_history_refuses_automatic_writes(self) -> None:
        bridge, store, history = await self.new_bridge()
        await bridge.publish(snapshot(5))
        store.data = snapshot(2)
        restarted = Bridge(PUBLISHER, store, lambda: False, history)
        await restarted.start()
        self.assertEqual((await restarted.status())["persistence"], "degraded")
        with self.assertRaisesRegex(ProtocolError, "recovery_required"):
            await restarted.publish(snapshot(6, 2))
        await restarted.recover(snapshot(6, 2), (await restarted.recovery_view())["precondition"])

    async def test_partial_history_restore_cannot_forget_replacement_publisher(self) -> None:
        bridge, store, history = await self.new_bridge()
        await bridge.publish(snapshot(5))
        old_history = await history.load()
        replacement_id = "00000000-0000-4000-8000-000000000025"
        replacement = snapshot(10, 5)
        replacement["publisher_id"] = replacement_id
        healthy = await bridge.recover(replacement, (await bridge.recovery_view())["precondition"])
        coherent_history = await history.load()
        history.data = old_history
        restarted = Bridge(PUBLISHER, store, lambda: False, history)
        await restarted.start()
        before = await restarted.status()
        self.assertEqual(before["persistence"], "degraded")
        self.assertEqual(before["last_error"], "storage_invalid")
        self.assertFalse(before["dispatch_enabled"])
        saves = (store.saves, history.saves)
        for publisher, revision in (
            (PUBLISHER, 6),
            (PUBLISHER, 11),
            (replacement_id, 11),
            ("00000000-0000-4000-8000-000000000026", 11),
        ):
            with self.subTest(publisher=publisher, revision=revision):
                candidate = snapshot(revision, before["active_revision"])
                candidate["publisher_id"] = publisher
                with self.assertRaisesRegex(ProtocolError, "recovery_required"):
                    await restarted.publish(candidate)
                with self.assertRaisesRegex(ProtocolError, "recovery_required"):
                    await restarted.recover(
                        candidate, (await restarted.recovery_view())["precondition"]
                    )
                self.assertEqual(await restarted.status(), before)
                self.assertEqual((store.saves, history.saves), saves)
                self.assertEqual(await store.load(), replacement)
                self.assertEqual(await history.load(), old_history)
        # A coherent synthetic backup restores the actual replacement history and identity.
        history.data = coherent_history
        restored = Bridge(PUBLISHER, store, lambda: False, history)
        await restored.start()
        self.assertEqual(await restored.status(), healthy)
        next_snapshot = snapshot(11, 10)
        next_snapshot["publisher_id"] = replacement_id
        self.assertEqual((await restored.publish(next_snapshot))["active_revision"], 11)
        with self.assertRaisesRegex(ProtocolError, "publisher_mismatch"):
            await restored.publish(snapshot(12, 11))

    async def test_history_head_must_exceed_every_retired_publisher(self) -> None:
        retired = "00000000-0000-4000-8000-000000000025"
        for retired_revision in (5, 10):
            with self.subTest(retired_revision=retired_revision):
                bridge, store, history = await self.new_bridge()
                await bridge.publish(snapshot(5))
                history.data["publishers"][retired] = retired_revision  # type: ignore[index]
                restarted = Bridge(PUBLISHER, store, lambda: False, history)
                await restarted.start()
                self.assertEqual((await restarted.status())["persistence"], "degraded")
                with self.assertRaisesRegex(ProtocolError, "recovery_required"):
                    await restarted.publish(snapshot(6, 5))
                with self.assertRaisesRegex(ProtocolError, "recovery_required"):
                    await restarted.recover(
                        snapshot(11), (await restarted.recovery_view())["precondition"]
                    )
                self.assertEqual(store.saves, 1)
                self.assertEqual(history.saves, 2)

    async def test_recovery_cannot_rewind_snapshot_ahead_of_history(self) -> None:
        for replace in (False, True):
            with self.subTest(replace=replace):
                bridge, store, history = await self.new_bridge()
                await bridge.publish(snapshot(5))
                store.data = snapshot(10, 5)
                restarted = Bridge(PUBLISHER, store, lambda: False, history)
                await restarted.start()
                before = await restarted.status()
                self.assertEqual(before["persistence"], "degraded")
                self.assertEqual(before["active_revision"], 10)
                view = await restarted.recovery_view()
                self.assertEqual(view["revision_floor"], 10)
                for revision in (6, 10):
                    candidate = snapshot(revision, 10)
                    if replace:
                        candidate["publisher_id"] = "00000000-0000-4000-8000-000000000025"
                    with self.assertRaisesRegex(ProtocolError, "stale_revision"):
                        await restarted.recover(candidate, view["precondition"])
                    self.assertEqual(await restarted.status(), before)
                    self.assertEqual(store.saves, 1)
                    self.assertEqual(history.saves, 2)
                candidate = snapshot(11, 10)
                if replace:
                    candidate["publisher_id"] = "00000000-0000-4000-8000-000000000025"
                recovered = await restarted.recover(candidate, view["precondition"])
                self.assertEqual(recovered["active_revision"], 11)
                self.assertEqual(recovered["persistence"], "healthy")
                self.assertFalse(recovered["dispatch_enabled"])

    async def test_history_capacity_never_discards_retired_publishers(self) -> None:
        from uuid import UUID

        bridge, store, history = await self.new_bridge()
        await bridge.publish(snapshot())
        for revision in range(2, 33):
            candidate = snapshot(revision, revision - 1)
            candidate["publisher_id"] = str(UUID(int=revision))
            await bridge.recover(candidate, (await bridge.recovery_view())["precondition"])
        candidate = snapshot(33, 32)
        candidate["publisher_id"] = str(UUID(int=33))
        with self.assertRaisesRegex(ProtocolError, "history_full"):
            await bridge.recover(candidate, (await bridge.recovery_view())["precondition"])
        self.assertEqual((await bridge.status())["active_revision"], 32)

    async def test_bounded_admission_and_shutdown_before_write(self) -> None:
        import asyncio

        entered, release = asyncio.Event(), asyncio.Event()

        class DelayedStore(MemoryStore):
            async def save(self, value: dict[str, object]) -> None:
                entered.set()
                await release.wait()
                await super().save(value)

        store, history = DelayedStore(), MemoryStore()
        stopping = False
        bridge = Bridge(PUBLISHER, store, lambda: stopping, history)
        await bridge.initialize()
        stopping = True
        with self.assertRaisesRegex(ProtocolError, "shutting_down"):
            await bridge.publish(snapshot())
        stopping = False
        callers = [asyncio.create_task(bridge.publish(snapshot())) for _ in range(4)]
        await entered.wait()
        with self.assertRaisesRegex(ProtocolError, "busy"):
            await bridge.publish(snapshot())
        release.set()
        self.assertTrue(
            all(result["active_revision"] == 1 for result in await asyncio.gather(*callers))
        )

    async def test_interrupted_pairing_reattaches_without_writes_or_history_reset(self) -> None:
        bridge, store, history = await self.new_bridge()
        attached = Bridge(PUBLISHER, store, lambda: False, history)
        await attached.reattach()
        self.assertEqual((await attached.status())["persistence"], "empty")
        self.assertEqual(history.saves, 1)
        await attached.publish(snapshot(3))
        store.data = None
        attached = Bridge(PUBLISHER, store, lambda: False, history)
        await attached.reattach()
        self.assertEqual((await attached.status())["persistence"], "degraded")
        self.assertEqual(history.saves, 2)
        wrong = Bridge("00000000-0000-4000-8000-000000000099", store, lambda: False, history)
        with self.assertRaisesRegex(ProtocolError, "recovery_required"):
            await wrong.reattach()
        history.data = None
        missing = Bridge(PUBLISHER, store, lambda: False, history)
        with self.assertRaisesRegex(ProtocolError, "recovery_required"):
            await missing.reattach()
