"""Calendar-aware server resource profile (Phase 2, D4/D5).

The host ops agent applies ``ServerResourceProfile.profile`` with
``docker update --cpus`` (no restarts). Before Phase 2 an admin had to pick
"Broadcast" by hand before every class. With
``REALTIME_AUTO_RESOURCE_PROFILE=1`` the ``realtime.resource_profile`` hook
(60 s, plus a nudge on Go Live / OBS prepare) chooses it:

* broadcast  a broadcast session is live with a feed starting/live/
             interrupted, or the weekly class window is near
             (15 min before the start to 10 min after the end);
* meeting    a meeting session is live and no broadcast needs the cores;
* content    nothing live for 10 minutes;
* hold       otherwise (just after a class ended): no change.

A manual choice in the admin is respected until the automatic decision
changes (the hook only writes when its own decision differs from the last
one it wrote).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from . import lifecycle

logger = logging.getLogger("ops.realtime")

LAST_AUTO_DECISION_KEY = "realtime:auto-profile:last"
PRE_CLASS_LEAD = timedelta(minutes=15)
POST_CLASS_HOLD = timedelta(minutes=10)
REVERT_AFTER_SECONDS = 600


def auto_profile_enabled() -> bool:
    return bool(getattr(settings, "REALTIME_AUTO_RESOURCE_PROFILE", False))


def in_class_window(now=None) -> bool:
    from .schedule import (
        LIVE_CLASS_END_TIME,
        LIVE_CLASS_START_TIME,
        LIVE_CLASS_TIMEZONE,
        LIVE_CLASS_WEEKDAYS,
    )

    local = (now or timezone.now()).astimezone(LIVE_CLASS_TIMEZONE)
    if local.weekday() not in LIVE_CLASS_WEEKDAYS:
        return False
    start = datetime.combine(local.date(), LIVE_CLASS_START_TIME, tzinfo=LIVE_CLASS_TIMEZONE) - PRE_CLASS_LEAD
    end = datetime.combine(local.date(), LIVE_CLASS_END_TIME, tzinfo=LIVE_CLASS_TIMEZONE) + POST_CLASS_HOLD
    return start <= local < end


def desired_profile(now=None) -> str | None:
    """The profile the schedule and live sessions want, or None to hold."""
    from .models import RealtimeSession, ServerResourceProfile

    live = RealtimeSession.objects.filter(status=RealtimeSession.STATUS_LIVE)
    broadcast_active = live.filter(
        session_type=RealtimeSession.TYPE_BROADCASTING,
        stream_status__in=[
            RealtimeSession.STREAM_STARTING,
            RealtimeSession.STREAM_LIVE,
            RealtimeSession.STREAM_INTERRUPTED,
        ],
    ).exists()
    if broadcast_active:
        return ServerResourceProfile.PROFILE_BROADCAST
    meeting_live = live.filter(session_type=RealtimeSession.TYPE_MEETING).exists()
    if meeting_live:
        return ServerResourceProfile.PROFILE_MEETING
    if in_class_window(now):
        return ServerResourceProfile.PROFILE_BROADCAST
    idle_for = lifecycle.seconds_since_live_activity(now)
    if idle_for is not None and idle_for < REVERT_AFTER_SECONDS:
        return None
    return ServerResourceProfile.PROFILE_CONTENT


def apply_auto_resource_profile(now=None) -> str | None:
    """Write the desired profile when the automatic decision changed. Returns it."""
    if not auto_profile_enabled():
        return None
    from .models import ServerResourceProfile

    desired = desired_profile(now)
    if desired is None:
        return None
    try:
        last = cache.get(LAST_AUTO_DECISION_KEY)
    except Exception:  # noqa: BLE001
        last = None
    if last == desired:
        return None
    profile = ServerResourceProfile.get_solo()
    if profile.profile != desired:
        previous = profile.profile
        profile.profile = desired
        profile.updated_by = None
        profile.save(update_fields=["profile", "updated_by", "updated_at"])
        logger.info("resource profile set automatically: %s -> %s", previous, desired)
    try:
        cache.set(LAST_AUTO_DECISION_KEY, desired, timeout=24 * 3600)
    except Exception:  # noqa: BLE001
        pass
    return desired


def nudge_resource_profile() -> str | None:
    """Called on Go Live / OBS prepare so the cores arrive before the feed."""
    try:
        return apply_auto_resource_profile()
    except Exception:  # noqa: BLE001
        logger.warning("automatic resource profile failed", exc_info=True)
        return None
