"""Monthly CTF scheduler: open, close, finalise and deliver XP without SSH.

The periodic hook (registered in ``CtfConfig.ready``) runs a few EXISTS
queries and, only when something is due, publishes one deduplicated
``ctf.season.tick`` outbox event. Every step is idempotent (compare-and-set
updates, unique reward rows, engagement idempotency keys), so two workers or
a retried event never open, finalise or award twice. Nothing runs while the
``monthly_ctf`` switch is off.
"""

from __future__ import annotations

import logging

from django.conf import settings
from django.utils import timezone

from apps.core import features
from apps.core.outbox import outbox_handler, publish

from . import season_services as services
from .season_models import CtfSeason

logger = logging.getLogger("apps.ctf.seasons.scheduler")

EVENT_TICK = "ctf.season.tick"


def interval_seconds() -> int:
    return max(15, int(getattr(settings, "CTF_SEASON_SCHEDULER_INTERVAL_SECONDS", 60) or 60))


def has_work(now=None) -> bool:
    now = now or timezone.now()
    due = (
        CtfSeason.objects.filter(status=CtfSeason.STATUS_SCHEDULED, opens_at__lte=now).exists()
        or CtfSeason.objects.filter(
            status__in=(CtfSeason.STATUS_OPEN, CtfSeason.STATUS_SCHEDULED), closes_at__lte=now
        ).exists()
        or CtfSeason.objects.filter(
            status=CtfSeason.STATUS_CLOSED, auto_finalise=True, finalised_at__isnull=True
        ).exists()
    )
    # Pending XP only counts while the engagement ledger can accept it,
    # otherwise an idle site would publish a no-op tick every interval.
    return due or (features.is_enabled("engagement") and services.xp_pending_exists())


def schedule_tick(now=None):
    """Periodic hook: publish this interval's tick only when something is due."""
    if not services.is_enabled():
        return None
    now = now or timezone.now()
    if not has_work(now):
        return None
    bucket = int(now.timestamp()) // interval_seconds()
    return publish(EVENT_TICK, {"bucket": bucket}, dedupe_key=f"ctf-season-tick:{bucket}")


def run(now=None) -> dict:
    if not services.is_enabled():
        return {"skipped": 1}
    now = now or timezone.now()
    stats = {
        "closed": services.close_due(now),
        "opened": services.open_due(now),
    }
    stats["finalised"] = services.finalise_due(now)
    stats["xp"] = services.deliver_xp(now=now)
    return stats


@outbox_handler(EVENT_TICK, max_attempts=3)
def handle_tick(event):
    stats = run()
    if any(value for key, value in stats.items() if key != "skipped"):
        logger.info("ctf season scheduler: %s", stats)
    return stats


@outbox_handler(services.EVENT_DELIVER_XP, max_attempts=6)
def handle_deliver_xp(event):
    return services.deliver_xp(event.payload.get("season_id"))
