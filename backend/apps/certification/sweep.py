"""Safety net: decide every ended certification-exam participation that has no decision yet.

Covers participations ended by bulk updates (time over, exam window closed)
and any decision whose immediate event was lost. The periodic hook runs one
EXISTS query and, only when something is due, publishes one deduplicated
``certification.sweep`` outbox event whose handler decides up to
``BATCH`` participations.
"""

from __future__ import annotations

import logging

from django.conf import settings
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from apps.core.outbox import outbox_handler, publish

logger = logging.getLogger("apps.certification")

EVENT_SWEEP = "certification.sweep"
BATCH = 500


def enabled() -> bool:
    return bool(getattr(settings, "CERTIFICATION_ENABLED", True))


def interval_seconds() -> int:
    return max(15, int(getattr(settings, "CERTIFICATION_SWEEP_INTERVAL_SECONDS", 60) or 60))


def undecided(now=None):
    from apps.ctf.models import CtfExam, CtfParticipation

    from .models import CertificationDecision

    now = now or timezone.now()
    ended = (
        Q(status__in=[CtfParticipation.STATUS_SUBMITTED, CtfParticipation.STATUS_EXPIRED])
        | Q(deadline_at__lte=now)
        | Q(exam__status=CtfExam.STATUS_CLOSED)
        | Q(exam__closes_at__lte=now)
    )
    decided = CertificationDecision.objects.filter(exam_id=OuterRef("exam_id"), user_id=OuterRef("user_id"))
    return (
        CtfParticipation.objects.filter(ended, is_staff_preview=False, exam__certification_policy__is_enabled=True)
        .annotate(decided=Exists(decided))
        .filter(decided=False)
    )


def schedule_sweep(now=None):
    if not enabled():
        return None
    now = now or timezone.now()
    if not undecided(now).exists():
        return None
    bucket = int(now.timestamp()) // interval_seconds()
    return publish(EVENT_SWEEP, {"bucket": bucket}, dedupe_key=f"cert-sweep:{bucket}")


def run_sweep(now=None) -> int:
    from .services import decide_participation

    decided = 0
    for participation_id in undecided(now).order_by("pk").values_list("pk", flat=True)[:BATCH]:
        try:
            if decide_participation(participation_id) is not None:
                decided += 1
        except Exception:  # noqa: BLE001 - one bad row must not stop the others
            logger.exception("certification.sweep_failed participation=%s", participation_id)
    return decided


@outbox_handler(EVENT_SWEEP, max_attempts=3)
def handle_sweep(event):
    decided = run_sweep()
    if decided:
        logger.info("certification.sweep decided=%s", decided)
    return decided
