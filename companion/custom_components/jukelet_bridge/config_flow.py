"""Explicit first pairing and reviewed owner recovery; never an assignment editor."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from homeassistant import config_entries
from homeassistant.core import callback

from . import DISPATCHER, DOMAIN, create_bridge
from .administration import Administration
from .compatibility import abort_incompatible_flow, compatibility
from .dispatcher import ControlReview
from .protocol import MAX_BYTES, ProtocolError, valid_publisher, validate_snapshot

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigFlowResult


class ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        assessment = compatibility(self.hass)
        if not assessment.allowed:
            return abort_incompatible_flow(self, assessment)
        import probatio as vol

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

    _review: ControlReview | None = None
    _observation: dict[str, Any] | None = None
    _action: str | None = None
    _outcome: str = ""

    def _admin(self) -> Administration:
        # HA protects both options-flow creation and continuation with its
        # administrator HTTP boundary. No app authentication is accepted here.
        return Administration(lambda: self.hass.data.get(DISPATCHER))

    def _description(self) -> dict[str, str]:
        if self._observation is None:
            return {"state": "Current state unavailable. Refresh before any further action."}
        diagnostic = self._observation["diagnostics"]
        status = self._observation["status"]
        explanations = {
            "startup": "Disabled after startup, reload or restart by design.",
            "administrator_disabled": "Deliberately disabled by an administrator.",
            "snapshot_changed": "Snapshot changed; dispatch remains disabled.",
            "readiness_lost": "Readiness was lost; explicit review is required.",
            "execution_uncertain": "Previous startup work may still have effects or be running.",
        }
        readiness = {
            "snapshot_unavailable": (
                "A healthy matching persisted snapshot is unavailable; inspect "
                "publication/recovery."
            ),
            "snapshot_invalid": "The snapshot is invalid; inspect publication/recovery.",
            "preference_conflict": (
                "Saved shuffle preferences conflict with album/playlist rules; review assignments."
            ),
            "execution_uncertain": (
                "Execution is uncertain. Reconcile only after establishing all "
                "previous work stopped."
            ),
            "profile_unconfigured": "The local startup script profile is not configured.",
            "script_unavailable_or_running": (
                "The configured single-mode startup script is unavailable or running."
            ),
            "shutting_down": "The companion is stopping; wait and refresh after restart.",
        }
        reason = diagnostic["readiness_error"]
        ready_text = readiness.get(
            reason, "Ready at observation." if reason is None else "Readiness unknown."
        )
        state = (
            f"Observed {diagnostic['observed_at']}. Dispatch: "
            f"{'enabled' if diagnostic['dispatch_enabled'] else 'disabled'}. "
            f"Busy: {diagnostic['busy']}. "
            f"Execution uncertain: {diagnostic['execution_uncertain']}. "
            f"{explanations.get(diagnostic['pause_reason'], 'No known pause reason.')} "
            f"{ready_text} "
            f"Persistence: {status['persistence']}; active revision: {status['active_revision']}; "
            f"checksum: {status['active_checksum']}. Playback independently unverified."
        )
        return {"state": state}

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        assessment = compatibility(self.hass)
        if not assessment.allowed:
            return abort_incompatible_flow(self, assessment)
        return self.async_show_menu(step_id="init", menu_options=["playback", "recovery"])

    async def async_step_playback(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        self._review, self._action = None, None
        try:
            self._observation = await self._admin().observe()
        except Exception:
            self._observation = None
        return self.async_show_menu(
            step_id="playback",
            menu_options=["refresh", "disable", "enable", "reconcile"],
            description_placeholders=self._description(),
        )

    async def async_step_refresh(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self.async_step_playback()

    async def _confirm_control(
        self, action: str, user_input: dict[str, Any] | None
    ) -> ConfigFlowResult:
        import probatio as vol

        errors = {}
        field = {
            "enable": "confirm_legacy_disabled",
            "reconcile": "confirm_all_stopped",
            "disable": "confirm_disable",
        }[action]
        if self._action != action or self._review is None:
            if user_input is not None:
                return self.async_abort(reason="control_not_ready")
            dispatcher = self.hass.data.get(DISPATCHER)
            if dispatcher is None or dispatcher.closed:
                return self.async_abort(reason="control_not_ready")
            try:
                self._review = await dispatcher.review_control()
                self._observation = await self._admin().observe()
            except Exception:
                self._review, self._observation = None, None
                return self.async_abort(reason="control_not_ready")
            self._action = action
        if user_input is not None:
            if user_input.get(field) is not True:
                errors["base"] = "confirmation_required"
            else:
                result = await self._admin().act(
                    action,
                    self._review,
                    confirmed_stopped=action == "reconcile",
                    confirmed_legacy_disabled=action == "enable",
                )
                self._observation = result.observation
                self._outcome = {
                    "confirmed": "Action confirmed by independent state readback.",
                    "rejected": (
                        "Action rejected. No retry was performed; refresh and review "
                        "before any new intent."
                    ),
                    "uncertain": (
                        "Action outcome uncertain. No retry was performed. The readback "
                        "below is a separate observation, not proof the action was acknowledged."
                    ),
                }[result.outcome]
                if result.error in {
                    "busy",
                    "stale_state",
                    "confirmation_required",
                    "not_ready",
                    "readback_unavailable",
                    "state_mismatch",
                }:
                    self._outcome += " Reason: " + result.error.replace("_", " ") + "."
                self._review, self._action = None, None
                return await self.async_step_control_result()
        return self.async_show_form(
            step_id=action,
            data_schema=vol.Schema({vol.Required(field, default=False): bool}),
            errors=errors,
            description_placeholders=self._description(),
        )

    async def async_step_enable(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._confirm_control("enable", user_input)

    async def async_step_disable(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._confirm_control("disable", user_input)

    async def async_step_reconcile(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        return await self._confirm_control("reconcile", user_input)

    async def async_step_control_result(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        import probatio as vol

        if user_input is not None:
            return await self.async_step_playback()
        return self.async_show_form(
            step_id="control_result",
            data_schema=vol.Schema({}),
            description_placeholders={**self._description(), "outcome": self._outcome},
        )

    async def async_step_recovery(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        import probatio as vol

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
            step_id="recovery",
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
        import probatio as vol

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
