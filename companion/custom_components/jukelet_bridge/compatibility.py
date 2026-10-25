"""Version policy and read-only prerequisite checks; evidence is maintained separately.

Checks establish callable shapes, never semantic proof of a future Core. The isolated
archive probes exercise the storage, admin, tag and script-completion semantics.
"""

from __future__ import annotations

import importlib
import inspect
import logging
import re
from dataclasses import asdict, dataclass
from typing import Any

_LOGGER = logging.getLogger(__name__)

MINIMUM_HA = "2026.10.3"
MAX_VERSION_LENGTH = 128
EVIDENCE_URL = "https://github.com/skoglump/jukelet/blob/main/docs/30-ha-compatibility.md"
# Add only reproduced incompatibilities, with a public issue and bounded reason.
# Evidence refreshes alone never require editing this runtime or rebuilding it.
KNOWN_INCOMPATIBLE: dict[str, str] = {}
_VERSION = re.compile(
    r"(?P<year>[1-9][0-9]{3})\.(?P<month>[1-9]|1[0-2])\."
    r"(?P<patch>0|[1-9][0-9]*)(?P<preview>b(?:0|[1-9][0-9]*)|\.dev(?:0|[1-9][0-9]*))?"
)


@dataclass(frozen=True)
class Compatibility:
    core_version: str | None
    state: str
    allowed: bool
    reason: str
    minimum: str = MINIMUM_HA
    evidence_url: str = EVIDENCE_URL

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def version_policy(value: object) -> Compatibility:
    """Stable releases may move forward; beta/dev are explicitly experimental."""
    match = (
        _VERSION.fullmatch(value)
        if type(value) is str and len(value) <= MAX_VERSION_LENGTH
        else None
    )
    if match is None:
        return Compatibility(None, "untested", False, "malformed_version")
    core = str(value)
    if core in KNOWN_INCOMPATIBLE:
        return Compatibility(core, "known_incompatible", False, KNOWN_INCOMPATIBLE[core])
    try:
        number = tuple(int(match[name]) for name in ("year", "month", "patch"))
    except ValueError:
        return Compatibility(None, "untested", False, "malformed_version")
    if number < (2026, 10, 3):
        return Compatibility(core, "below_minimum", False, "minimum_core_2026_10_3")
    if match["preview"]:
        return Compatibility(core, "untested", True, "experimental_beta_dev")
    # Do not claim 'tested' from a version string. See dated, artifact-specific results.
    return Compatibility(core, "expected_compatible", True, "check_dated_test_evidence")


def _bind_signature(function: Any, *args: Any, **kwargs: Any) -> bool:
    """Bind arguments only; every required call also selects an invocation contract."""
    if not callable(function):
        raise TypeError("required callable absent")
    inspect.signature(function).bind(*args, **kwargs)
    return True


def _call_implementation(function: Any) -> Any:
    # Calling a class invokes its metaclass; calling an object invokes __call__.
    if inspect.isclass(function):
        return type(function).__call__
    if not callable(function):
        return function
    return function.__call__


def _ordinary_sync(function: Any) -> None:
    if not callable(function):
        raise TypeError("required callable implementation absent")
    if (
        inspect.iscoroutinefunction(function)
        or inspect.isasyncgenfunction(function)
        or inspect.isgeneratorfunction(function)
    ):
        raise TypeError("required ordinary synchronous contract changed")


def _sync_accepts(function: Any, *args: Any, **kwargs: Any) -> bool:
    """Non-awaited callbacks/decorators/lookups must produce their result immediately."""
    _ordinary_sync(function)
    _ordinary_sync(_call_implementation(function))
    if inspect.isclass(function):
        _ordinary_sync(function.__new__)
        _ordinary_sync(function.__init__)
    return _bind_signature(function, *args, **kwargs)


def _constructor_accepts(function: Any, *args: Any, **kwargs: Any) -> bool:
    """Construct synchronously; declared callable schema validators are sync too."""
    _sync_accepts(function, *args, **kwargs)
    if inspect.isclass(function):
        _ordinary_sync(function.__call__)
    return True


def _awaitable_callback_accepts(function: Any, *args: Any, **kwargs: Any) -> bool:
    """The executor callback is sync and returns a Future; real Store probes await it.

    Signature/mode inspection cannot establish arbitrary return-value semantics.
    Never call the executor or schedule work merely to run preflight.
    """
    return _sync_accepts(function, *args, **kwargs)


def _async_accepts(function: Any, *args: Any, **kwargs: Any) -> bool:
    """Directly awaited coroutine APIs, including declared async callable wrappers."""
    if not (
        inspect.iscoroutinefunction(function)
        or inspect.iscoroutinefunction(_call_implementation(function))
    ):
        raise TypeError("required coroutine contract changed")
    return _bind_signature(function, *args, **kwargs)


def _exception_class(value: Any) -> bool:
    if not inspect.isclass(value) or not issubclass(value, Exception):
        raise TypeError("required exception class absent or incompatible")
    return True


def required_contracts(hass: Any) -> str | None:
    """Return a bounded failed contract name without touching stores or services."""
    checks: dict[str, Any] = {}
    try:
        const = importlib.import_module("homeassistant.const")
        core = importlib.import_module("homeassistant.core")
        entries = importlib.import_module("homeassistant.config_entries")
        storage = importlib.import_module("homeassistant.helpers.storage")
        websocket = importlib.import_module("homeassistant.components.websocket_api")
        decorators = importlib.import_module("homeassistant.components.websocket_api.decorators")
        connection = importlib.import_module("homeassistant.components.websocket_api.connection")
        schema = importlib.import_module("probatio")
        exceptions = importlib.import_module("homeassistant.exceptions")
        flow_api = importlib.import_module("homeassistant.data_entry_flow")
        checks = {
            "schema_validation": lambda: (
                _constructor_accepts(schema.Schema, {}),
                _constructor_accepts(schema.All, {}),
                _constructor_accepts(schema.Required, "publisher_id"),
                _constructor_accepts(schema.Required, "confirm_pairing", default=False),
                _constructor_accepts(schema.Optional, "timeout_seconds"),
                _constructor_accepts(schema.Optional, "confirmed_stopped", default=False),
                _constructor_accepts(schema.In, ["enable", "disable", "reconcile"]),
            ),
            "script_error_contract": lambda: _exception_class(exceptions.HomeAssistantError),
            "flow_abort_contract": lambda: (
                _exception_class(flow_api.AbortFlow),
                _constructor_accepts(
                    flow_api.AbortFlow,
                    "incompatible_core",
                    description_placeholders={"reason": "compatibility"},
                ),
            ),
            "config_flow": lambda: (
                _sync_accepts(
                    entries.ConfigFlow.async_show_form,
                    None,
                    step_id="user",
                    data_schema=None,
                    errors={},
                ),
                _sync_accepts(
                    entries.ConfigFlow.async_abort, None, reason="single_instance_allowed"
                ),
                _sync_accepts(
                    entries.ConfigFlow.async_abort,
                    None,
                    reason="incompatible_core",
                    description_placeholders={"reason": "compatibility"},
                ),
                _sync_accepts(
                    entries.ConfigFlow.async_create_entry, None, title="Jukelet", data={}
                ),
                _async_accepts(entries.ConfigFlow.async_set_unique_id, None, "jukelet_bridge"),
                _sync_accepts(entries.ConfigFlow._async_current_entries, None),
                _sync_accepts(
                    entries.OptionsFlow.async_show_form,
                    None,
                    step_id="recovery",
                    data_schema=None,
                    errors={},
                ),
                _sync_accepts(
                    entries.OptionsFlow.async_show_form,
                    None,
                    step_id="control_result",
                    data_schema=None,
                    description_placeholders={},
                ),
                _sync_accepts(
                    entries.OptionsFlow.async_show_form,
                    None,
                    step_id="confirm",
                    data_schema=None,
                    errors={},
                    description_placeholders={},
                ),
                _sync_accepts(
                    entries.OptionsFlow.async_show_menu,
                    None,
                    step_id="init",
                    menu_options=["recovery"],
                ),
                _sync_accepts(
                    entries.OptionsFlow.async_show_menu,
                    None,
                    step_id="playback",
                    menu_options=["refresh"],
                    description_placeholders={},
                ),
                _sync_accepts(entries.OptionsFlow.async_abort, None, reason="not_ready"),
                _sync_accepts(
                    entries.OptionsFlow.async_abort,
                    None,
                    reason="incompatible_core",
                    description_placeholders={"reason": "compatibility"},
                ),
                _sync_accepts(entries.OptionsFlow.async_create_entry, None, title="", data={}),
                _sync_accepts(entries.ConfigEntry.async_on_unload, None, lambda: None),
                _sync_accepts(hass.config_entries.async_entries, "jukelet_bridge"),
                _sync_accepts(hass.config_entries.async_update_entry, None, data={}),
                _async_accepts(hass.config_entries.async_reload, "entry"),
            ),
            "websocket_admin": lambda: (
                _sync_accepts(websocket.async_register_command, hass, lambda: None),
                _sync_accepts(decorators.require_admin, lambda: None),
                _sync_accepts(decorators.async_response, lambda: None),
                _sync_accepts(decorators.websocket_command, {}),
                _sync_accepts(connection.ActiveConnection.send_result, None, 1, {}),
                _sync_accepts(
                    connection.ActiveConnection.send_error, None, 1, "not_ready", "Read state"
                ),
            ),
            "atomic_private_store": lambda: (
                _constructor_accepts(
                    storage.Store,
                    hass,
                    1,
                    "jukelet_bridge.snapshot",
                    atomic_writes=True,
                    private=True,
                ),
                storage.Store.path,
                _awaitable_callback_accepts(hass.async_add_executor_job, lambda: None),
                _async_accepts(storage.Store.async_load, None),
                _async_accepts(storage.Store.async_save, None, {}),
            ),
            "tag_events_lifecycle": lambda: (
                _sync_accepts(hass.bus.async_listen, "tag_scanned", lambda event: None),
                _sync_accepts(
                    hass.bus.async_listen_once, const.EVENT_HOMEASSISTANT_STOP, lambda event: None
                ),
                _sync_accepts(core.callback, lambda: None),
                tuple(
                    getattr(core.CoreState, state)
                    for state in ("stopping", "final_write", "not_running")
                ),
            ),
            "blocking_script_response": lambda: (
                _sync_accepts(hass.services.has_service, "script", "synthetic"),
                _sync_accepts(hass.states.get, "script.synthetic"),
                _async_accepts(
                    hass.services.async_call,
                    "script",
                    "synthetic",
                    {},
                    blocking=True,
                    return_response=True,
                ),
            ),
        }
    except ImportError, AttributeError, TypeError, ValueError:
        return "required_core_imports"
    for name, check in checks.items():
        try:
            check()
        except AttributeError, TypeError, ValueError:
            return name
    return None


def compatibility(hass: Any) -> Compatibility:
    """Shared setup/pairing decision; failed contracts never authorize persistence."""
    try:
        core_version = importlib.import_module("homeassistant.const").__version__
    except ImportError, AttributeError:
        return Compatibility(None, "known_incompatible", False, "required_core_imports")
    policy = version_policy(core_version)
    if not policy.allowed:
        return policy
    failed = required_contracts(hass)
    if failed:
        return Compatibility(policy.core_version, "known_incompatible", False, failed)
    return policy


def repair_message(result: Compatibility) -> str:
    return (
        f"Jukelet compatibility: {result.state}; {result.reason}. "
        f"Minimum Core {MINIMUM_HA}. Keep dispatch disabled and preserve pairing/stores; "
        f"check the dated matrix and use a tested Core/integration pair: {EVIDENCE_URL}"
    )


def abort_incompatible_flow(flow: Any, result: Compatibility) -> Any:
    """Use HA's abort facilities without calling a known-incompatible helper.

    If HA's own result helper and AbortFlow machinery are both unavailable,
    log and raise a bounded setup error. Never construct raw HA result/storage data.
    """
    message = repair_message(result)
    _LOGGER.error("%s", message)
    try:
        _sync_accepts(
            flow.async_abort,
            reason="incompatible_core",
            description_placeholders={"reason": message},
        )
    except AttributeError, TypeError, ValueError:
        pass
    else:
        try:
            response = flow.async_abort(
                reason="incompatible_core", description_placeholders={"reason": message}
            )
            if (
                isinstance(response, dict)
                and response.get("type") == "abort"
                and response.get("reason") == "incompatible_core"
                and (response.get("description_placeholders") or {}).get("reason") == message
            ):
                return response
            if inspect.iscoroutine(response):
                response.close()
        except Exception:
            # A changed presentation helper cannot authorize or initialize pairing.
            pass
    try:
        abort_type = importlib.import_module("homeassistant.data_entry_flow").AbortFlow
        _exception_class(abort_type)
        _constructor_accepts(
            abort_type, "incompatible_core", description_placeholders={"reason": message}
        )
    except ImportError, AttributeError, TypeError, ValueError:
        raise RuntimeError(message) from None
    raise abort_type("incompatible_core", description_placeholders={"reason": message})
