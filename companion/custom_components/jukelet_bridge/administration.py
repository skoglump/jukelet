"""HA-local administrator workflow; acknowledgments are never state readback."""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .dispatcher import ControlReview, Dispatcher
from .protocol import ProtocolError


@dataclass(frozen=True)
class ActionResult:
    outcome: str
    error: str | None
    observation: dict[str, Any] | None


class Administration:
    def __init__(self, current: Callable[[], Dispatcher | None]) -> None:
        self.current = current

    async def observe(self) -> dict[str, Any]:
        dispatcher = self.current()
        if dispatcher is None or dispatcher.closed:
            raise ProtocolError("not_ready")
        status = await dispatcher.bridge.status()
        if dispatcher is not self.current() or dispatcher.closed:
            raise ProtocolError("not_ready")
        return {"status": status, "diagnostics": dispatcher.operational_diagnostics()}

    async def act(
        self,
        action: str,
        reviewed: ControlReview,
        *,
        confirmed_stopped: bool = False,
        confirmed_legacy_disabled: bool = False,
    ) -> ActionResult:
        outcome, error = "uncertain", None
        try:
            dispatcher = self.current()
            if dispatcher is None:
                raise ProtocolError("not_ready")
            acknowledgment = await dispatcher.guarded_control(
                action,
                reviewed,
                confirmed_stopped=confirmed_stopped,
                confirmed_legacy_disabled=confirmed_legacy_disabled,
            )
            if (
                type(acknowledgment) is dict
                and acknowledgment.get("dispatch_enabled") is (action == "enable")
                and type(acknowledgment.get("dispatcher")) is dict
                and (
                    action != "reconcile"
                    or acknowledgment["dispatcher"].get("execution_uncertain") is False
                )
            ):
                outcome = "acknowledged"
        except ProtocolError as exc:
            outcome, error = "rejected", exc.code
        except Exception:
            # Never expose exception payloads; never retry an ambiguous action.
            pass
        try:
            observation = await self.observe()
        except Exception:
            return ActionResult("uncertain", "readback_unavailable", None)
        expected_enabled = action == "enable"
        diagnostics = observation["diagnostics"]
        if outcome == "acknowledged":
            if diagnostics["dispatch_enabled"] is expected_enabled and (
                action != "reconcile" or not diagnostics["execution_uncertain"]
            ):
                outcome = "confirmed"
            else:
                outcome, error = "uncertain", "state_mismatch"
        return ActionResult(outcome, error, observation)
