"""HA transport shared by the explicit local dispatcher and isolated probes."""

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .playback import ScriptFailed, ScriptUnavailable


class HAScriptTransport:
    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def invoke(self, script: str, variables: dict[str, Any]) -> object:
        """Use the adapter's locally allowlisted direct script service, once."""
        service = script.removeprefix("script.")
        if not self._hass.services.has_service("script", service):
            raise ScriptUnavailable
        try:
            return await self._hass.services.async_call(
                "script",
                service,
                variables,
                blocking=True,
                return_response=True,
            )
        except HomeAssistantError:
            # Includes nested missing services and races after the preflight check;
            # neither proves that the script had no partial side effects.
            raise ScriptFailed from None
