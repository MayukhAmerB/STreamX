"""Attendance and calendar background work (autodiscovered by ``CoreConfig.ready``).

Each handler is idempotent, so an outbox retry is harmless.
"""

from __future__ import annotations

import logging

from apps.core.outbox import outbox_handler

from .signals import EVENT_FINALIZE, EVENT_FLUSH, EVENT_MATERIALIZE, EVENT_MATERIALIZE_SCHEDULE, EVENT_SWEEP

logger = logging.getLogger("apps.attendance.outbox")


@outbox_handler(EVENT_FLUSH, max_attempts=3)
def handle_flush(event):
    from . import flush

    stats = flush.flush()
    if stats["batches"]:
        logger.info("attendance.flush %s", stats)
    return stats


@outbox_handler(EVENT_FINALIZE, max_attempts=8)
def handle_finalize(event):
    from . import access, services

    if not access.enabled():
        return None
    summary = services.finalize_session((event.payload or {}).get("session_id"))
    return {"session_id": getattr(summary, "session_ref_id", None)}


@outbox_handler(EVENT_SWEEP, max_attempts=3)
def handle_sweep(event):
    from . import access, services

    if not access.enabled():
        return None
    done = services.finalize_pending_sessions()
    if done:
        logger.info("attendance.finalize_sweep finalised=%s", done)
    return {"finalized": done}


@outbox_handler(EVENT_MATERIALIZE, max_attempts=3)
def handle_materialize(event):
    from . import access, scheduling

    if not access.enabled():
        return None
    stats = scheduling.materialize_all()
    logger.info("calendar.materialize %s", stats)
    return stats


@outbox_handler(EVENT_MATERIALIZE_SCHEDULE, max_attempts=6)
def handle_materialize_schedule(event):
    from . import access, scheduling
    from .models import ClassSchedule

    if not access.enabled():
        return None
    payload = event.payload or {}
    schedule = ClassSchedule.objects.select_related("course", "live_class").filter(pk=payload.get("schedule_id")).first()
    if schedule is None:
        return None
    return scheduling.materialize_schedule(schedule, notify=bool(payload.get("notify")))
