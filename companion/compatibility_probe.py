"""Actual isolated cold API refusals before any pairing/history or handler writes."""

from __future__ import annotations

import asyncio
import functools
import importlib
import inspect
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from companion.probe_support import install_probe_component, probe_ha_version
from companion.tests.fixtures import snapshot


def invocation_mode_cases(hass: Any) -> tuple[tuple[Any, str, str], ...]:
    """Every non-awaited external call family; shared by cold and paired probes."""
    import probatio
    from homeassistant import config_entries, core, data_entry_flow
    from homeassistant.components import websocket_api
    from homeassistant.components.websocket_api import connection, decorators
    from homeassistant.helpers import storage

    return (
        *(
            (probatio, name, "schema_validation")
            for name in ("Schema", "All", "Required", "Optional", "In")
        ),
        (websocket_api, "async_register_command", "websocket_admin"),
        *(
            (decorators, name, "websocket_admin")
            for name in ("require_admin", "async_response", "websocket_command")
        ),
        *(
            (connection.ActiveConnection, name, "websocket_admin")
            for name in ("send_result", "send_error")
        ),
        *(
            (type(hass.bus), name, "tag_events_lifecycle")
            for name in ("async_listen", "async_listen_once")
        ),
        (core, "callback", "tag_events_lifecycle"),
        (type(hass.services), "has_service", "blocking_script_response"),
        (type(hass.states), "get", "blocking_script_response"),
        (storage, "Store", "atomic_private_store"),
        (type(hass), "async_add_executor_job", "atomic_private_store"),
        *(
            (config_entries.ConfigFlow, name, "config_flow")
            for name in ("async_show_form", "async_abort", "async_create_entry")
        ),
        *(
            (config_entries.OptionsFlow, name, "config_flow")
            for name in ("async_show_form", "async_show_menu", "async_abort", "async_create_entry")
        ),
        (data_entry_flow, "AbortFlow", "flow_abort_contract"),
        (config_entries.ConfigFlow, "_async_current_entries", "config_flow"),
        (config_entries.ConfigEntry, "async_on_unload", "config_flow"),
        *(
            (config_entries.ConfigEntries, name, "config_flow")
            for name in ("async_entries", "async_update_entry")
        ),
    )


async def probe(directory: Path) -> None:
    import probatio
    from homeassistant import config_entries, const, core, data_entry_flow, exceptions
    from homeassistant.components import websocket_api
    from homeassistant.core import HomeAssistant
    from homeassistant.helpers import storage

    install_probe_component(directory)
    sys.path.insert(0, str(directory))
    component = importlib.import_module("custom_components.jukelet_bridge")
    policy = importlib.import_module("custom_components.jukelet_bridge.compatibility")
    flow_module = importlib.import_module("custom_components.jukelet_bridge.config_flow")
    hass = HomeAssistant(str(directory))
    hass.config_entries = config_entries.ConfigEntries(hass, {})
    assert policy.compatibility(hass).allowed
    publisher = snapshot()["publisher_id"]
    native_abort = data_entry_flow.AbortFlow
    case_number = 0
    case_directory = directory

    def fresh_case() -> tuple[Any, Path]:
        nonlocal case_number
        case_number += 1
        case = directory / f"case-{case_number}"
        case.mkdir()
        install_probe_component(case)
        instance = HomeAssistant(str(case))
        instance.config_entries = config_entries.ConfigEntries(instance, {})
        return instance, case

    failures: list[dict[str, str]] = []
    tested: list[str] = []

    async def refusal(name: str, expected_reason: str, *, framework_error: bool = False) -> None:
        # No credential store is read. Only the absence of companion-owned paths is checked.
        before_handlers = dict(hass.data.get("websocket_api", {}))
        try:
            assessment = policy.compatibility(hass)
        except Exception as exc:
            failures.append({"case": name, "failure": "preflight_" + type(exc).__name__})
        else:
            if assessment.allowed or assessment.reason != expected_reason:
                failures.append({"case": name, "failure": f"preflight: {assessment.reason}"})
        for operation in ("setup", "pairing_form", "pairing", "entry_setup", "recovery"):
            try:
                if operation == "setup":
                    result = await component.async_setup(hass, {})
                    assert result is False, "setup not refused"
                elif operation == "entry_setup":
                    result = await component.async_setup_entry(
                        hass, SimpleNamespace(version=1, data={"publisher_id": publisher})
                    )
                    assert result is False, "entry setup not refused"
                else:
                    flow = (
                        flow_module.ConfigFlow()
                        if operation in {"pairing_form", "pairing"}
                        else flow_module.RecoveryFlow()
                    )
                    flow.hass = hass
                    flow.context = {"source": "user"}
                    if operation == "pairing_form":
                        result = await flow.async_step_user()
                    elif operation == "pairing":
                        result = await flow.async_step_user(
                            {"publisher_id": publisher, "confirm_pairing": True}
                        )
                    else:
                        result = await flow.async_step_init()
                    assert result["type"] == "abort" and result["reason"] == "incompatible_core", (
                        result
                    )
                    assert expected_reason in result["description_placeholders"]["reason"]
            except native_abort as exc:
                if exc.reason != "incompatible_core" or expected_reason not in (
                    exc.description_placeholders or {}
                ).get("reason", ""):
                    failures.append(
                        {"case": name, "operation": operation, "failure": "bad native abort"}
                    )
            except Exception as exc:
                if (
                    framework_error
                    and operation in {"pairing_form", "pairing", "recovery"}
                    and isinstance(exc, RuntimeError)
                    and expected_reason in str(exc)
                    and policy.EVIDENCE_URL in str(exc)
                ):
                    continue
                failures.append(
                    {"case": name, "operation": operation, "failure": type(exc).__name__}
                )
        if dict(hass.data.get("websocket_api", {})) != before_handlers:
            failures.append({"case": name, "failure": "partial handler registration"})
        if any(
            (case_directory / ".storage" / key).exists()
            for key in (
                "jukelet_bridge.history",
                "jukelet_bridge.snapshot",
                "jukelet_bridge.execution",
            )
        ):
            failures.append({"case": name, "failure": "companion store written before refusal"})
        tested.append(name)

    for name in ("Schema", "All", "Required", "Optional", "In"):
        hass, case_directory = fresh_case()
        with patch.object(probatio, name, None):
            await refusal("schema." + name, "schema_validation")
    hass, case_directory = fresh_case()
    with patch.object(config_entries.ConfigFlow, "_async_current_entries", None):
        await refusal("config_flow.current_entries", "config_flow")

    # Match the actual declared callable modes and all production keyword forms.
    def sync_unique_id(
        self: Any, unique_id: str | None = None, *, raise_on_progress: bool = True
    ) -> None:
        return None

    def sync_reload(self: Any, entry_id: str) -> bool:
        return True

    def narrow_form(self: Any, *, step_id: str | None = None) -> None:
        return None

    def narrow_menu(self: Any, *, step_id: str | None = None, menu_options: Any) -> None:
        return None

    def narrow_abort(self: Any, *, reason: str) -> None:
        return None

    async def async_create_entry(self: Any, *, title: str, data: Any) -> None:
        return None

    async def async_presentation(self: Any, *args: Any, **kwargs: Any) -> None:
        return None

    def form_without_errors(
        self: Any,
        *,
        step_id: str | None = None,
        data_schema: Any = None,
        description_placeholders: Any = None,
    ) -> None:
        return None

    def form_without_placeholders(
        self: Any, *, step_id: str | None = None, data_schema: Any = None, errors: Any = None
    ) -> None:
        return None

    for owner, attribute, replacement, label in (
        (config_entries.ConfigFlow, "async_set_unique_id", sync_unique_id, "sync_unique_id"),
        (config_entries.ConfigEntries, "async_reload", sync_reload, "sync_reload"),
        (config_entries.ConfigFlow, "async_show_form", narrow_form, "config_form_keywords"),
        (config_entries.OptionsFlow, "async_show_form", narrow_form, "options_form_keywords"),
        (config_entries.OptionsFlow, "async_show_menu", narrow_menu, "options_menu_keywords"),
        (config_entries.ConfigFlow, "async_abort", narrow_abort, "config_abort_keywords"),
        (config_entries.OptionsFlow, "async_abort", narrow_abort, "options_abort_keywords"),
        (
            config_entries.ConfigFlow,
            "async_create_entry",
            async_create_entry,
            "async_entry_factory",
        ),
        (config_entries.ConfigFlow, "async_show_form", form_without_errors, "config_form_errors"),
        (config_entries.OptionsFlow, "async_show_form", form_without_errors, "options_form_errors"),
        (
            config_entries.OptionsFlow,
            "async_show_form",
            form_without_placeholders,
            "options_form_placeholders",
        ),
        (config_entries.ConfigFlow, "async_show_form", async_presentation, "async_config_form"),
        (config_entries.ConfigFlow, "async_abort", async_presentation, "async_config_abort"),
        (config_entries.OptionsFlow, "async_show_form", async_presentation, "async_options_form"),
        (config_entries.OptionsFlow, "async_show_menu", async_presentation, "async_options_menu"),
        (config_entries.OptionsFlow, "async_abort", async_presentation, "async_options_abort"),
        (
            config_entries.OptionsFlow,
            "async_create_entry",
            async_create_entry,
            "async_options_entry",
        ),
        (config_entries.ConfigFlow, "async_abort", None, "config_abort_missing"),
        (config_entries.OptionsFlow, "async_abort", None, "options_abort_missing"),
    ):
        hass, case_directory = fresh_case()
        with patch.object(owner, attribute, replacement):
            await refusal("config_flow." + label, "config_flow")
    # Preserve complete signatures: only the declared invocation mode changes.
    mode_cases = invocation_mode_cases(hass)
    for owner, attribute, expected_reason in mode_cases:
        original = getattr(owner, attribute)

        @functools.wraps(original)
        async def asynchronous_replacement(*args: Any, **kwargs: Any) -> None:
            return None

        hass, case_directory = fresh_case()
        with patch.object(owner, attribute, asynchronous_replacement):
            await refusal("mode." + attribute, expected_reason)

    class AsyncCallback:
        def __init__(self, signature: inspect.Signature) -> None:
            self.__signature__ = signature

        async def __call__(self, *args: Any, **kwargs: Any) -> None:
            return None

    hass, case_directory = fresh_case()
    with patch.object(
        websocket_api,
        "async_register_command",
        AsyncCallback(inspect.signature(websocket_api.async_register_command)),
    ):
        await refusal("mode.async_callable_registration", "websocket_admin")

    original_store = storage.Store

    class AsyncStore(original_store):
        async def __init__(self, *args: Any, **kwargs: Any) -> None:
            return None

    hass, case_directory = fresh_case()
    with patch.object(storage, "Store", AsyncStore):
        await refusal("mode.async_constructor_init", "atomic_private_store")

    class AsyncAbort(native_abort):
        async def __init__(self, *args: Any, **kwargs: Any) -> None:
            return None

    hass, case_directory = fresh_case()
    with patch.object(data_entry_flow, "AbortFlow", AsyncAbort):
        await refusal("mode.async_abort_constructor", "flow_abort_contract")

    for owner, attribute, expected_reason in (
        (storage.Store, "async_load", "atomic_private_store"),
        (storage.Store, "async_save", "atomic_private_store"),
        (type(hass.services), "async_call", "blocking_script_response"),
    ):
        original = getattr(owner, attribute)

        @functools.wraps(original)
        def synchronous_replacement(*args: Any, **kwargs: Any) -> None:
            return None

        hass, case_directory = fresh_case()
        with patch.object(owner, attribute, synchronous_replacement):
            await refusal("mode.sync_" + attribute, expected_reason)

    for name, invalid in (("none", None), ("object_class", object), ("str_class", str)):
        hass, case_directory = fresh_case()
        with patch.object(exceptions, "HomeAssistantError", invalid):
            await refusal("HomeAssistantError." + name, "script_error_contract")
    hass, case_directory = fresh_case()
    with patch.object(exceptions, "HomeAssistantError"):
        del exceptions.HomeAssistantError
        await refusal("HomeAssistantError.missing", "script_error_contract")
    hass, case_directory = fresh_case()
    with (
        patch.object(exceptions, "ConfigEntryError", None),
        patch.object(const, "__version__", "2026.10.2"),
    ):
        await refusal("optional_error_class.below_minimum", "minimum_core_2026_10_3")
    hass, case_directory = fresh_case()
    with (
        patch.object(config_entries.ConfigFlow, "async_abort", None),
        patch.object(config_entries.OptionsFlow, "async_abort", None),
        patch.object(data_entry_flow, "AbortFlow", None),
    ):
        await refusal(
            "config_flow.framework_abort_unavailable", "flow_abort_contract", framework_error=True
        )
    for prefix in ("2026.10.", "2026.11.0b", "2026.11.0.dev"):
        hass, case_directory = fresh_case()
        with patch.object(const, "__version__", prefix + "9" * 5000):
            await refusal("version.oversized", "malformed_version")
    hass, case_directory = fresh_case()
    # Annotation-only symbols must not become runtime imports before pairing.
    with patch.object(core, "HomeAssistant"):
        del core.HomeAssistant
        importlib.import_module("custom_components.jukelet_bridge.ha_playback")
        importlib.import_module("custom_components.jukelet_bridge.ha_store")
        assert policy.compatibility(hass).allowed
    tested.append("HomeAssistant.annotation_only_cold_imports")
    print(
        json.dumps(
            {
                "scope": "actual_isolated_HA_cold_refusals_synthetic_inputs",
                "core": probe_ha_version(),
                "tested": tested,
                "failures": failures,
            },
            indent=2,
        )
    )
    assert not failures, failures


def main() -> None:
    assert len(sys.argv) == 1, "No targets, credentials or existing configuration accepted"
    probe_ha_version()
    with tempfile.TemporaryDirectory(prefix="jukelet-cold-compatibility-") as root:
        asyncio.run(probe(Path(root)))


if __name__ == "__main__":
    main()
