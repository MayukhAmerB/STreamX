"""Compare-and-set state transitions for ClassRecording.

Every transition is a single conditional UPDATE (``WHERE state IN allowed``),
so retries, double-clicks and two workers racing each other can never apply
the same transition twice. ``transition`` returns False when the row was not
in a state that allows the move (including "already there").
"""

import logging

from django.utils import timezone

from config.audit import log_security_event

from .models import ClassRecording

logger = logging.getLogger("ops.realtime")

R = ClassRecording
TRANSITIONS = {
    # Found on disk by the import scan; an admin picks the module to publish it.
    R.STATE_IMPORTED: {R.STATE_FINALIZING},
    R.STATE_RECORDING: {R.STATE_FINALIZING, R.STATE_FAILED},
    R.STATE_FINALIZING: {R.STATE_PROCESSING, R.STATE_FAILED},
    R.STATE_PROCESSING: {R.STATE_PUBLISHED, R.STATE_FAILED},
    # Retry paths: re-run finalize (no lecture yet) or re-check processing.
    R.STATE_FAILED: {R.STATE_FINALIZING, R.STATE_PROCESSING},
    R.STATE_PUBLISHED: set(),
}


def allowed_sources_for(to_state):
    return [from_state for from_state, targets in TRANSITIONS.items() if to_state in targets]


def can_transition(from_state, to_state):
    return to_state in TRANSITIONS.get(from_state, set())


def transition(recording, to_state, *, error="", reason="", request=None, **field_updates):
    """Move ``recording`` to ``to_state`` atomically; returns True if applied."""
    if to_state not in TRANSITIONS:
        raise ValueError(f"Unknown class recording state: {to_state}")
    from_state = recording.state
    updates = dict(field_updates)
    updates["state"] = to_state
    updates["updated_at"] = timezone.now()
    updates["error"] = str(error or "")[:4000] if to_state == R.STATE_FAILED else str(error or "")
    applied = bool(
        ClassRecording.objects.filter(pk=recording.pk, state__in=allowed_sources_for(to_state)).update(**updates)
    )
    if not applied:
        return False
    for field_name, value in updates.items():
        setattr(recording, field_name, value)
    log_transition(recording, from_state, to_state, reason=reason, request=request)
    return True


def log_transition(recording, from_state, to_state, *, reason, request):
    payload = {
        "recording_id": recording.pk,
        "session_id": recording.session_id,
        "lecture_id": recording.lecture_id,
        "source": recording.source,
        "from_state": from_state,
        "to_state": to_state,
        "reason": reason,
    }
    if to_state == R.STATE_FAILED:
        payload["error"] = (recording.error or "")[:500]
        logger.warning("CLASS_RECORDING_STATE %s", payload)
    else:
        logger.info("CLASS_RECORDING_STATE %s", payload)
    log_security_event("realtime.class_recording_state_changed", request=request, **payload)
