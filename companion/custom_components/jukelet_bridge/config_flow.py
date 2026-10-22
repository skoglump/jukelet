"""Explicit first pairing and reviewed owner recovery; never an assignment editor."""

import json
from typing import Any

import probatio as vol
from homeassistant import config_entries
from homeassistant.config_entries import ConfigFlowResult
from homeassistant.core import callback

from . import DOMAIN, SUPPORTED_HA, create_bridge
from .protocol import MAX_BYTES, ProtocolError, valid_publisher, validate_snapshot


class ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        from homeassistant.const import __version__

        if __version__ != SUPPORTED_HA:
            return self.async_abort(reason="unsupported_version")
        await self.async_set_unique_id(DOMAIN)
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        errors = {}
        if user_input is not None:
            if not valid_publisher(user_input["publisher_id"]):
                errors["base"] = "invalid_publisher"
            elif user_input.get("confirm_pairing") is not True:
                errors["base"] = "confirmation_required"
            else:
                bridge = create_bridge(self.hass, user_input["publisher_id"])
                try:
                    if user_input.get("reattach_existing") is True:
                        await bridge.reattach()
                    else:
                        await bridge.initialize()
                except Exception:
                    errors["base"] = "recovery_required"
                else:
                    return self.async_create_entry(
                        title="Jukelet bridge", data={"publisher_id": user_input["publisher_id"]}
                    )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required("publisher_id"): str,
                    vol.Required("confirm_pairing", default=False): bool,
                    vol.Required("reattach_existing", default=False): bool,
                }
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> config_entries.OptionsFlow:
        return RecoveryFlow()


class RecoveryFlow(config_entries.OptionsFlow):
    _precondition: str | None = None
    _snapshot: dict[str, Any] | None = None

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        bridge = self.hass.data.get(DOMAIN)
        if bridge is None:
            return self.async_abort(reason="not_ready")
        errors = {}
        if user_input is not None:
            try:
                raw = user_input["snapshot_json"]
                if len(raw.encode("utf-8")) > MAX_BYTES:
                    raise ProtocolError("snapshot_too_large")

                def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
                    result: dict[str, Any] = {}
                    for key, value in items:
                        if key in result:
                            raise ValueError("duplicate field")
                        result[key] = value
                    return result

                self._snapshot = validate_snapshot(json.loads(raw, object_pairs_hook=pairs))
                self._precondition = (await bridge.recovery_view())["precondition"]
            except ValueError, UnicodeError, RecursionError:
                errors["base"] = "invalid_snapshot"
            else:
                return await self.async_step_confirm()
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required("snapshot_json"): str,
                }
            ),
            errors=errors,
        )

    async def async_step_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        bridge = self.hass.data.get(DOMAIN)
        if bridge is None or self._snapshot is None or self._precondition is None:
            return self.async_abort(reason="not_ready")
        errors = {}
        if user_input is not None:
            if user_input.get("confirm_recovery") is not True:
                errors["base"] = "confirmation_required"
            else:
                try:
                    await bridge.recover(self._snapshot, self._precondition)
                except ProtocolError:
                    return self.async_abort(reason="recovery_rejected")
                return self.async_create_entry(title="", data={})
        view = await bridge.recovery_view()
        return self.async_show_form(
            step_id="confirm",
            data_schema=vol.Schema(
                {
                    vol.Required("confirm_recovery", default=False): bool,
                }
            ),
            errors=errors,
            description_placeholders={
                "publisher": self._snapshot["publisher_id"],
                "revision": str(self._snapshot["revision"]),
                "checksum": self._snapshot["payload_checksum"],
                "count": str(len(self._snapshot["payload"]["mappings"])),
                "current": str(view["status"]["active_revision"]),
                "floor": str(view["revision_floor"])
                if view["revision_floor"] is not None
                else "unknown",
            },
        )
