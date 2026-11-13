"""Realtime housekeeping run by the async worker (``process_async_jobs``).

Registered in ``RealtimeConfig.ready`` through ``apps.core.worker.register_periodic``;
each hook runs at most once per interval across all workers.

* ``realtime.chat_timeouts`` (30 s): when expired Owncast chat timeouts exist,
  publish one deduplicated outbox event whose handler re-enables those users.
  This used to run inline on every chat launch.
* ``realtime.obs_stream_health`` (5 s): the single writer of OBS
  ``stream_status``. Viewer GETs only read the cached Owncast status; this hook
  persists transitions with a compare-and-set UPDATE.
"""

from __future__ import annotations

import logging

from django.conf import settings
from django.utils import timezone

from apps.core.outbox import outbox_handler, publish

logger = logging.getLogger("apps.realtime.periodic")

EVENT_RELEASE_CHAT_TIMEOUTS = "realtime.release_chat_timeouts"
CHAT_TIMEOUTS_INTERVAL_SECONDS = 30
CHAT_TIMEOUTS_BATCH_SIZE = 50
CHAT_TIMEOUTS_OWNCAST_TIMEOUT_SECONDS = 4


def obs_stream_health_interval_seconds():
    return max(2, int(getattr(settings, "REALTIME_OBS_STREAM_HEALTH_INTERVAL_SECONDS", 5) or 5))


def schedule_chat_timeout_release(now=None):
    """Publish this interval's release event, only when there is work to do."""
    from .services import expired_owncast_chat_timeouts_queryset

    now = now or timezone.now()
    if not expired_owncast_chat_timeouts_queryset(now).exists():
        return None
    bucket = int(now.timestamp()) // CHAT_TIMEOUTS_INTERVAL_SECONDS
    return publish(
        EVENT_RELEASE_CHAT_TIMEOUTS,
        {"bucket": bucket},
        dedupe_key=f"realtime-chat-timeouts:{bucket}",
    )


@outbox_handler(EVENT_RELEASE_CHAT_TIMEOUTS, max_attempts=3)
def handle_release_chat_timeouts(event):
    from .services import OwncastConfigError, release_expired_owncast_chat_timeouts

    try:
        result = release_expired_owncast_chat_timeouts(
            timeout=CHAT_TIMEOUTS_OWNCAST_TIMEOUT_SECONDS,
            limit=CHAT_TIMEOUTS_BATCH_SIZE,
        )
    except OwncastConfigError as exc:
        # Not configured on this deployment: nothing to retry.
        logger.info("realtime: chat timeout release skipped: %s", exc)
        return None
    if result["released"] or result["errors"]:
        logger.info(
            "realtime: chat timeouts released=%s failed=%s checked=%s",
            result["released"],
            len(result["errors"]),
            result["checked"],
        )
    return result


def persist_obs_stream_health():
    """Refresh and persist stream_status for every running OBS session."""
    from .models import RealtimeSession
    from .services import refresh_obs_session_stream_health

    sessions = list(
        RealtimeSession.objects.filter(
            session_type=RealtimeSession.TYPE_BROADCASTING,
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            status__in=[RealtimeSession.STATUS_SCHEDULED, RealtimeSession.STATUS_LIVE],
        )
        .only("id", "session_type", "stream_service", "status", "stream_status", "updated_at")
        .order_by("-updated_at")[:20]
    )
    changed = 0
    for session in sessions:
        result = refresh_obs_session_stream_health(session, persist=True)
        if result.get("changed"):
            changed += 1
    return changed
