"""Session-end hook: a class that ends is finalised ~90 s later (fail-safe).

A ``post_save`` receiver on ``RealtimeSession`` (no code in the realtime app
changes). ``end_session`` saves the row with ``status=ended`` inside its
transaction; this receiver inserts one deduplicated outbox event in its own
savepoint, so a database error here rolls back only that row, never the End.
Ends written with ``QuerySet.update`` (no signal) are caught by the periodic
finalise sweep.
"""

from __future__ import annotations

import logging

from django.core.cache import cache
from django.db import transaction
from django.db.models.signals import post_save
from django.dispatch import receiver

from .metrics import record_hook_failure

logger = logging.getLogger("apps.attendance.signals")

EVENT_FINALIZE = "attendance.finalize_session"
EVENT_FLUSH = "attendance.flush"
EVENT_SWEEP = "attendance.finalize_sweep"
EVENT_MATERIALIZE = "calendar.materialize"
EVENT_MATERIALIZE_SCHEDULE = "calendar.materialize_schedule"
MARKER_TTL_SECONDS = 24 * 3600


def publish_finalize(session_id: int) -> None:
    from apps.core.outbox import publish

    from . import conf

    with transaction.atomic():
        publish(
            EVENT_FINALIZE,
            {"session_id": int(session_id)},
            dedupe_key=f"att-finalize:{int(session_id)}",
            delay_seconds=conf.finalize_delay_seconds(),
        )


def _forget_status(session_id) -> None:
    from .presence import forget_session_status

    forget_session_status(session_id)


@receiver(post_save, sender="realtime.RealtimeSession", dispatch_uid="attendance.session_saved")
def session_saved(sender, instance, **kwargs):
    try:
        if instance.status != "ended" or not instance.started_at or not instance.ended_at:
            return
        marker = f"att:mk:finalize:{instance.pk}"
        try:
            if cache.get(marker):
                return
        except Exception:  # noqa: BLE001
            pass
        from .access import enabled

        _forget_status(instance.pk)
        if not enabled():
            return
        publish_finalize(instance.pk)

        def _mark():
            try:
                cache.set(marker, 1, timeout=MARKER_TTL_SECONDS)
            except Exception:  # noqa: BLE001
                pass

        transaction.on_commit(_mark)
    except Exception:  # noqa: BLE001 - attendance must never break ending a class
        logger.exception("attendance.signal_failed receiver=session_saved")
        record_hook_failure("session_saved")
