from collections.abc import Mapping

from django.core.exceptions import ValidationError


class InvalidRealtimeTransition(ValidationError):
    pass


SESSION_TRANSITIONS = {
    "scheduled": frozenset({"live", "ended"}),
    "live": frozenset({"ended"}),
    "ended": frozenset(),
}

STREAM_TRANSITIONS = {
    "idle": frozenset({"starting", "live", "stopped", "failed"}),
    "starting": frozenset({"live", "stopped", "failed"}),
    "live": frozenset({"stopped", "failed"}),
    "stopped": frozenset({"starting", "live", "failed"}),
    "failed": frozenset({"starting", "live", "stopped"}),
}


def _ensure_transition(
    *,
    current: object,
    target: object,
    transitions: Mapping[str, frozenset[str]],
    field_name: str,
) -> None:
    current = str(current or "").strip().lower()
    target = str(target or "").strip().lower()
    if current == target or target in transitions.get(current, frozenset()):
        return
    raise InvalidRealtimeTransition(
        {
            field_name: (
                f"Invalid realtime transition from '{current or 'unknown'}' "
                f"to '{target or 'unknown'}'."
            )
        }
    )


def ensure_session_transition(current: object, target: object) -> None:
    _ensure_transition(
        current=current,
        target=target,
        transitions=SESSION_TRANSITIONS,
        field_name="status",
    )


def ensure_stream_transition(current: object, target: object) -> None:
    _ensure_transition(
        current=current,
        target=target,
        transitions=STREAM_TRANSITIONS,
        field_name="stream_status",
    )
