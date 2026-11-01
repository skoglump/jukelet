"""Explicit disposable-only HA services; never part of an app/bridge package.

The coordinator installs this source only in the named, generated HA OS fixture.
It has no provider credentials, network client, generic action or storage access.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .policy import (
    DOMAIN,
    ENTITY_ID,
    SCRIPT_ID,
    SERVICES,
    FixtureState,
    SyntheticUnavailable,
    control_request,
    fixture_config,
)


async def async_setup(hass: Any, config: dict[str, Any]) -> bool:
    if (
        not fixture_config(config.get(DOMAIN))
        or hass.services.async_services().get("spotifyplus")
        or hass.states.get(ENTITY_ID) is not None
        or DOMAIN in hass.data
    ):
        return False
    import probatio  # type: ignore[import-not-found]
    from homeassistant.components import tag, websocket_api  # type: ignore[import-not-found]
    from homeassistant.components.websocket_api.decorators import (  # type: ignore[import-not-found]
        async_response,
        require_admin,
        websocket_command,
    )
    from homeassistant.core import SupportsResponse, callback  # type: ignore[import-not-found]
    from homeassistant.exceptions import HomeAssistantError  # type: ignore[import-not-found]
    from homeassistant.helpers.service import (  # type: ignore[import-not-found]
        async_set_service_schema,
    )

    state = FixtureState()

    def metadata_handler(name: str) -> Any:
        async def metadata(call: Any) -> dict[str, Any]:
            try:
                return state.metadata(name, dict(call.data))
            except ValueError, SyntheticUnavailable:
                raise HomeAssistantError("Synthetic metadata request unavailable") from None

        return metadata

    for name, fields in SERVICES.items():
        hass.services.async_register(
            "spotifyplus", name, metadata_handler(name), supports_response=SupportsResponse.ONLY
        )
        async_set_service_schema(
            hass,
            "spotifyplus",
            name,
            {
                "name": "Synthetic Jukelet62 " + name,
                "fields": {field: {"required": field != "exclude_items"} for field in fields},
            },
        )

    def observe(event: Any) -> None:
        data = event.data
        if data.get("domain") == "script" and data.get("service") == SCRIPT_ID.split(".")[1]:
            variables = data.get("service_data")
            state.observe_script_call(
                dict(variables) if isinstance(variables, Mapping) else variables
            )

    hass.bus.async_listen("call_service", callback(observe))
    hass.states.async_set(
        ENTITY_ID, "idle", {"friendly_name": "Synthetic Jukelet62 metadata", "synthetic": True}
    )

    async def control(_hass: Any, connection: Any, msg: dict[str, Any]) -> None:
        try:
            request = control_request(
                {key: value for key, value in msg.items() if key not in {"id", "type"}}
            )
            if request["action"] == "metadata":
                state.mode = request["mode"]
            elif request["action"] == "scan":
                await tag.async_scan_tag(hass, request["tag_id"], request["reader_id"])
        except ValueError:
            connection.send_error(msg["id"], "invalid_fixture_control", "Synthetic control refused")
            return
        connection.send_result(msg["id"], state.status())

    command = websocket_command(
        {
            "type": "jukelet_acceptance/control",
            probatio.Required("action"): str,
            probatio.Optional("mode"): str,
            probatio.Optional("tag_id"): str,
        }
    )(require_admin(async_response(control)))
    websocket_api.async_register_command(hass, command)
    hass.data[DOMAIN] = state
    return True
