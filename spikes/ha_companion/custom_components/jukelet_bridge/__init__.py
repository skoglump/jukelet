"""Isolated Jukelet companion feasibility prototype; never enables dispatch."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from homeassistant.components.websocket_api.connection import ActiveConnection
    from homeassistant.core import HomeAssistant

DOMAIN = "jukelet_bridge"


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    # Deferred imports keep the deterministic contract suite HA-independent.
    import probatio
    from homeassistant.components import websocket_api
    from homeassistant.components.websocket_api.decorators import (
        async_response,
        require_admin,
        websocket_command,
    )
    from homeassistant.core import CoreState

    from .bridge import Bridge
    from .ha_store import HAStore
    from .protocol import ProtocolError

    bridge = Bridge(
        config[DOMAIN]["publisher_id"],
        HAStore(hass),
        lambda: hass.state in (CoreState.stopping, CoreState.final_write, CoreState.not_running),
    )
    await bridge.start()
    hass.data[DOMAIN] = bridge

    @websocket_command(probatio.All(probatio.Schema({"type": "jukelet_bridge/status"})))
    @require_admin
    @async_response
    async def status(
        hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
    ) -> None:
        connection.send_result(msg["id"], await bridge.status())

    @websocket_command({"type": "jukelet_bridge/publish", probatio.Required("snapshot"): dict})
    @require_admin
    @async_response
    async def publish(
        hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
    ) -> None:
        try:
            result = await bridge.publish(msg["snapshot"])
        except ProtocolError as exc:
            connection.send_error(msg["id"], exc.code, "Snapshot not acknowledged; read status.")
        else:
            connection.send_result(msg["id"], result)

    websocket_api.async_register_command(hass, status)
    websocket_api.async_register_command(hass, publish)
    return True
