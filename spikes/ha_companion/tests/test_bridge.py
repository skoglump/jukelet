"""Deterministic persistence fault/concurrency fixtures; not HA runtime evidence."""

import copy
import unittest
from typing import Any

from spikes.ha_companion.custom_components.jukelet_bridge.bridge import Bridge
from spikes.ha_companion.custom_components.jukelet_bridge.protocol import PUBLISHER, checksum


def snapshot(revision: int = 1, expected: int | None = None) -> dict[str, Any]:
    payload = {
        "mappings": [
            {
                "tag_id": "SYNTHETIC_Å",
                "media_type": "album",
                "spotify_uri": "spotify:album:" + "A" * 22,
                "enabled": True,
                "shuffle": False,
                "playback_profile_id": "default",
            }
        ]
    }
    return {
        "schema_version": 1,
        "publisher_id": PUBLISHER,
        "revision": revision,
        "expected_active_revision": expected,
        "payload": payload,
        "payload_checksum": checksum(payload),
    }


class MemoryStore:
    def __init__(self) -> None:
        self.data: object = None
        self.saves = 0
        self.swallow_failure = False

    async def load(self) -> object:
        return copy.deepcopy(self.data)

    async def save(self, value: dict[str, Any]) -> None:
        self.saves += 1
        if not self.swallow_failure:
            self.data = copy.deepcopy(value)


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_publish_readback_and_restart_keep_dispatch_disabled(self) -> None:
        store = MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: False)
        await bridge.start()
        self.assertEqual((await bridge.status())["persistence"], "empty")
        result = await bridge.publish(snapshot())
        self.assertEqual(result["active_revision"], 1)
        self.assertFalse(result["dispatch_enabled"])
        restarted = Bridge(PUBLISHER, store, lambda: False)
        await restarted.start()
        self.assertEqual(await restarted.status(), result)

    async def test_retry_conflicts_and_foreign_publisher_do_not_write(self) -> None:
        from spikes.ha_companion.custom_components.jukelet_bridge.protocol import ProtocolError

        store = MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: False)
        await bridge.publish(snapshot())
        await bridge.publish(snapshot())
        self.assertEqual(store.saves, 1)
        variants = [
            (snapshot(2), "base_conflict"),
            (snapshot(2, 1), "publisher_mismatch"),
            (snapshot(), "revision_conflict"),
        ]
        variants[1][0]["publisher_id"] = "00000000-0000-4000-8000-000000000020"
        variants[2][0]["payload"]["mappings"] = []
        variants[2][0]["payload_checksum"] = checksum({"mappings": []})
        for candidate, code in variants:
            with self.assertRaisesRegex(ProtocolError, code):
                await bridge.publish(candidate)
        await bridge.publish(snapshot(3, 1))
        with self.assertRaisesRegex(ProtocolError, "stale_revision"):
            await bridge.publish(snapshot(2, 1))
        self.assertEqual(store.saves, 2)

    async def test_swallowed_write_error_keeps_last_good_and_allows_safe_retry(self) -> None:
        from spikes.ha_companion.custom_components.jukelet_bridge.protocol import ProtocolError

        store = MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: False)
        await bridge.publish(snapshot())
        store.swallow_failure = True
        with self.assertRaisesRegex(ProtocolError, "persistence_failed"):
            await bridge.publish(snapshot(2, 1))
        status = await bridge.status()
        self.assertEqual(status["active_revision"], 1)
        self.assertEqual(status["persistence"], "healthy")
        store.swallow_failure = False
        self.assertEqual((await bridge.publish(snapshot(2, 1)))["active_revision"], 2)

    async def test_corrupt_startup_and_unreadable_storage_require_recovery(self) -> None:
        from spikes.ha_companion.custom_components.jukelet_bridge.protocol import ProtocolError

        store = MemoryStore()
        store.data = {"invalid": "synthetic corrupt record"}
        bridge = Bridge(PUBLISHER, store, lambda: False)
        await bridge.start()
        self.assertEqual((await bridge.status())["persistence"], "degraded")
        with self.assertRaisesRegex(ProtocolError, "recovery_required"):
            await bridge.publish(snapshot())
        self.assertEqual(store.saves, 0)

    async def test_concurrent_publish_has_one_winner(self) -> None:
        import asyncio

        from spikes.ha_companion.custom_components.jukelet_bridge.protocol import ProtocolError

        store = MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: False)
        await bridge.publish(snapshot())
        results = await asyncio.gather(
            bridge.publish(snapshot(2, 1)), bridge.publish(snapshot(3, 1)), return_exceptions=True
        )
        self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
        self.assertEqual(sum(isinstance(item, ProtocolError) for item in results), 1)
        self.assertEqual(store.saves, 2)

    async def test_cancelled_client_does_not_cancel_save_or_overtake_readback(self) -> None:
        import asyncio

        entered, release = asyncio.Event(), asyncio.Event()

        class DelayedStore(MemoryStore):
            async def save(self, value: dict[str, Any]) -> None:
                entered.set()
                await release.wait()
                await super().save(value)

        store = DelayedStore()
        bridge = Bridge(PUBLISHER, store, lambda: False)
        caller = asyncio.create_task(bridge.publish(snapshot()))
        await entered.wait()
        caller.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await caller
        status = asyncio.create_task(bridge.status())
        await asyncio.sleep(0)
        self.assertFalse(status.done())
        release.set()
        result = await status
        self.assertEqual(result["active_revision"], 1)
        self.assertFalse(result["dispatch_enabled"])

    async def test_shutting_down_before_or_during_save_never_acknowledges_success(self) -> None:
        from spikes.ha_companion.custom_components.jukelet_bridge.protocol import ProtocolError

        stopping = True
        store = MemoryStore()
        bridge = Bridge(PUBLISHER, store, lambda: stopping)
        with self.assertRaisesRegex(ProtocolError, "shutting_down"):
            await bridge.publish(snapshot())
        self.assertEqual(store.saves, 0)
        stopping = False

        class StoppingStore(MemoryStore):
            async def save(self, value: dict[str, Any]) -> None:
                nonlocal stopping
                await super().save(value)
                stopping = True

        bridge = Bridge(PUBLISHER, StoppingStore(), lambda: stopping)
        with self.assertRaisesRegex(ProtocolError, "persistence_uncertain"):
            await bridge.publish(snapshot())
        self.assertEqual((await bridge.status())["persistence"], "degraded")

    async def test_ack_waits_for_readback_and_pending_publications_are_bounded(self) -> None:
        import asyncio

        from spikes.ha_companion.custom_components.jukelet_bridge.protocol import ProtocolError

        entered, release = asyncio.Event(), asyncio.Event()

        class ReadbackStore(MemoryStore):
            async def load(self) -> object:
                entered.set()
                await release.wait()
                return await super().load()

        bridge = Bridge(PUBLISHER, ReadbackStore(), lambda: False)
        callers = [asyncio.create_task(bridge.publish(snapshot())) for _ in range(4)]
        await entered.wait()
        self.assertTrue(all(not caller.done() for caller in callers))
        with self.assertRaisesRegex(ProtocolError, "busy"):
            await bridge.publish(snapshot())
        release.set()
        results = await asyncio.gather(*callers)
        self.assertTrue(all(result["active_revision"] == 1 for result in results))

    async def test_readback_error_or_unexpected_record_fences_further_writes(self) -> None:
        from spikes.ha_companion.custom_components.jukelet_bridge.protocol import ProtocolError

        class BrokenReadbackStore(MemoryStore):
            async def load(self) -> object:
                raise OSError("synthetic read failure")

        class UnexpectedStore(MemoryStore):
            async def save(self, value: dict[str, Any]) -> None:
                self.data = {"unexpected": True}

        for store in (BrokenReadbackStore(), UnexpectedStore()):
            bridge = Bridge(PUBLISHER, store, lambda: False)
            with self.assertRaisesRegex(ProtocolError, "persistence_uncertain"):
                await bridge.publish(snapshot())
            self.assertEqual((await bridge.status())["persistence"], "degraded")
            with self.assertRaisesRegex(ProtocolError, "recovery_required"):
                await bridge.publish(snapshot())
