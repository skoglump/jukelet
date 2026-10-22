"""Jukelet's inert, explicitly paired Home Assistant snapshot bridge."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.core import HomeAssistant

    from .bridge import Bridge

DOMAIN = "jukelet_bridge"
SUPPORTED_HA = "2026.10.2"
HISTORY_KEY = "jukelet_bridge.history"


def create_bridge(hass: HomeAssistant, publisher: str) -> Bridge:
    from homeassistant.core import CoreState

    from .bridge import Bridge
    from .ha_store import HAStore

    return Bridge(
        publisher,
        HAStore(hass),
        lambda: hass.state in (CoreState.stopping, CoreState.final_write, CoreState.not_running),
        HAStore(hass, HISTORY_KEY),
    )


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    if DOMAIN in config:
        return False  # No automatic prototype/YAML migration or first-caller pairing.
    import probatio
    from homeassistant.components import websocket_api
    from homeassistant.components.websocket_api.connection import ActiveConnection
    from homeassistant.components.websocket_api.decorators import (
        async_response,
        require_admin,
        websocket_command,
    )

    from .protocol import ProtocolError

    @websocket_command(probatio.All(probatio.Schema({"type": "jukelet_bridge/status"})))
    @require_admin
    @async_response
    async def status(
        hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
    ) -> None:
        bridge = hass.data.get(DOMAIN)
        if bridge is None:
            connection.send_error(msg["id"], "not_ready", "Bridge is not loaded.")
        else:
            connection.send_result(msg["id"], await bridge.status())

    @websocket_command({"type": "jukelet_bridge/publish", probatio.Required("snapshot"): dict})
    @require_admin
    @async_response
    async def publish(
        hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
    ) -> None:
        bridge = hass.data.get(DOMAIN)
        if bridge is None:
            connection.send_error(msg["id"], "not_ready", "Bridge is not loaded.")
            return
        try:
            result = await bridge.publish(msg["snapshot"])
        except ProtocolError as exc:
            connection.send_error(msg["id"], exc.code, "Snapshot not acknowledged; read status.")
        else:
            connection.send_result(msg["id"], result)

    websocket_api.async_register_command(hass, status)
    websocket_api.async_register_command(hass, publish)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    from homeassistant.const import EVENT_HOMEASSISTANT_STOP, __version__

    if __version__ != SUPPORTED_HA or entry.version != 1:
        return False
    bridge = create_bridge(hass, entry.data["publisher_id"])
    await bridge.start()
    hass.data[DOMAIN] = bridge

    async def stop(event: Any) -> None:
        await bridge.close()

    entry.async_on_unload(hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, stop))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    bridge = hass.data.pop(DOMAIN, None)
    if bridge is not None:
        await bridge.close()
    return True
