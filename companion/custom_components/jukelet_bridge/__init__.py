"""Explicitly paired bridge and administratively activated local dispatcher."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.core import HomeAssistant

    from .bridge import Bridge

DOMAIN = "jukelet_bridge"
SUPPORTED_HA = "2026.10.2"
HISTORY_KEY = "jukelet_bridge.history"
DISPATCHER = "jukelet_dispatcher"
FENCE_KEY = "jukelet_bridge.execution"


def normalize_tag_event(value: object) -> dict[str, str] | None:
    """Detach the supported HA envelope into the strict internal scan schema."""
    from .playback import _text

    if (
        type(value) is not dict
        or set(value) - {"tag_id", "name", "device_id"}
        or not _text(value.get("tag_id"))
        or (value.get("name") is not None and type(value["name"]) is not str)
        or (value.get("device_id") is not None and not _text(value["device_id"]))
    ):
        return None
    event = {"tag_id": value["tag_id"]}
    if value.get("device_id") is not None:
        event["device_id"] = value["device_id"]
    return event


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

    @websocket_command(
        {
            "type": "jukelet_bridge/dispatch",
            probatio.Required("action"): probatio.In(["enable", "disable", "reconcile"]),
            probatio.Optional("confirmed_stopped", default=False): bool,
        }
    )
    @require_admin
    @async_response
    async def dispatch(
        hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
    ) -> None:
        dispatcher = hass.data.get(DISPATCHER)
        if dispatcher is None:
            connection.send_error(msg["id"], "not_ready", "Dispatcher is not loaded.")
            return
        try:
            result = await dispatcher.control(msg["action"], msg["confirmed_stopped"])
        except Exception:
            connection.send_error(
                msg["id"], "dispatch_rejected", "Read status; reconcile readiness."
            )
        else:
            connection.send_result(msg["id"], result)

    @websocket_command(
        {
            "type": "jukelet_bridge/configure_dispatch",
            probatio.Required("profiles"): dict,
            probatio.Optional("timeout_seconds"): object,
        }
    )
    @require_admin
    @async_response
    async def configure(
        hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
    ) -> None:
        from .ha_playback import HAScriptTransport
        from .playback import PlaybackAdapter

        dispatcher = hass.data.get(DISPATCHER)
        if dispatcher is None:
            connection.send_error(msg["id"], "not_ready", "Dispatcher is not loaded.")
            return
        async with dispatcher.control_lock:
            if dispatcher.enabled or dispatcher.busy or dispatcher.closed:
                connection.send_error(msg["id"], "busy", "Disable dispatch before configuring.")
                return
            try:
                timeout = msg.get("timeout_seconds", dispatcher.timeout)
                PlaybackAdapter(HAScriptTransport(hass), msg["profiles"], timeout=timeout)
            except ProtocolError as exc:
                connection.send_error(msg["id"], exc.code, "Invalid local configuration.")
                return
            entry = hass.config_entries.async_entries(DOMAIN)[0]
            hass.config_entries.async_update_entry(
                entry,
                data={
                    **entry.data,
                    "playback_profiles": dict(msg["profiles"]),
                    "playback_timeout": timeout,
                },
            )
            await dispatcher.close()
        await hass.config_entries.async_reload(entry.entry_id)
        connection.send_result(msg["id"], await hass.data[DOMAIN].status())

    @websocket_command({"type": "jukelet_bridge/dispatch_config"})
    @require_admin
    @async_response
    async def dispatch_config(
        hass: HomeAssistant, connection: ActiveConnection, msg: dict[str, Any]
    ) -> None:
        dispatcher = hass.data.get(DISPATCHER)
        if dispatcher is None or dispatcher.closed:
            connection.send_error(msg["id"], "not_ready", "Dispatcher is not loaded.")
            return
        connection.send_result(
            msg["id"],
            {"profiles": dict(dispatcher.profiles), "timeout_seconds": dispatcher.timeout},
        )

    websocket_api.async_register_command(hass, dispatch)
    websocket_api.async_register_command(hass, configure)
    websocket_api.async_register_command(hass, dispatch_config)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    from homeassistant.const import EVENT_HOMEASSISTANT_STOP, __version__
    from homeassistant.core import callback

    from .dispatcher import Dispatcher
    from .ha_playback import HAScriptTransport
    from .ha_store import HAStore
    from .protocol import ProtocolError

    if __version__ != SUPPORTED_HA or entry.version != 1:
        return False
    bridge = create_bridge(hass, entry.data["publisher_id"])

    def script_ready(script: str) -> bool:
        state = hass.states.get(script)
        return (
            hass.services.has_service("script", script.removeprefix("script."))
            and state is not None
            and state.state == "off"
            and state.attributes.get("mode") == "single"
        )

    try:
        dispatcher = Dispatcher(
            bridge,
            HAScriptTransport(hass),
            entry.data.get("playback_profiles", {}),
            HAStore(hass, FENCE_KEY),
            script_ready,
            timeout=entry.data.get("playback_timeout", 30.0),
        )
    except ProtocolError:
        return False  # Invalid persisted local configuration must not load or enable.
    await bridge.start()
    hass.data[DOMAIN] = bridge
    await dispatcher.start()
    hass.data[DISPATCHER] = dispatcher

    @callback
    def scan(event: Any) -> None:
        dispatcher.scan(normalize_tag_event(dict(event.data)))

    entry.async_on_unload(hass.bus.async_listen("tag_scanned", scan))

    async def stop(event: Any) -> None:
        await dispatcher.close()
        await bridge.close()

    entry.async_on_unload(hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, stop))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    dispatcher = hass.data.get(DISPATCHER)
    if dispatcher is not None:
        await dispatcher.close()
        hass.data.pop(DISPATCHER, None)
    bridge = hass.data.pop(DOMAIN, None)
    if bridge is not None:
        await bridge.close()
    return True
