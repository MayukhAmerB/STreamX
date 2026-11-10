"""Server-side, de-duplicated lecture view counting.

A view is counted at most once per viewer per lecture per (local) day. The
count is an admin-only metric; nothing here is returned to API clients.
"""

import hashlib
import logging
from datetime import datetime, time, timedelta

from django.conf import settings
from django.core.cache import cache
from django.db import DatabaseError
from django.utils import timezone

from config.client_ip import resolve_client_ip

from .models import LectureView

logger = logging.getLogger("ops.performance")


def _viewer_identity(request):
    user = getattr(request, "user", None)
    if user is not None and getattr(user, "is_authenticated", False):
        return f"u:{user.id}", user
    client_ip = resolve_client_ip(request)
    if not client_ip:
        return "", None
    # Anonymous preview viewers: store only a salted hash, never the address.
    digest = hashlib.sha256(f"{settings.SECRET_KEY}:lecture-view:{client_ip}".encode("utf-8")).hexdigest()
    return f"a:{digest[:40]}", None


def _seconds_until_tomorrow(now):
    local_now = timezone.localtime(now)
    tomorrow = datetime.combine(local_now.date() + timedelta(days=1), time.min, tzinfo=local_now.tzinfo)
    return max(60, int((tomorrow - local_now).total_seconds()) + 60)


def record_lecture_view(*, lecture, request):
    """Count one view; returns True only when a new view row was stored."""
    viewer_key, user = _viewer_identity(request)
    if not viewer_key:
        return False
    now = timezone.now()
    view_date = timezone.localdate(now)
    cache_key = f"lecture-view:{lecture.id}:{viewer_key}:{view_date.isoformat()}"
    try:
        # Signed playback URLs are refreshed often; skip the DB when we already counted today.
        if not cache.add(cache_key, 1, timeout=_seconds_until_tomorrow(now)):
            return False
    except Exception:  # cache outages must never block playback
        pass
    try:
        _, created = LectureView.objects.get_or_create(
            lecture=lecture,
            viewer_key=viewer_key,
            view_date=view_date,
            defaults={"user": user},
        )
    except DatabaseError:
        logger.warning("Lecture view tracking failed. lecture_id=%s", lecture.id, exc_info=True)
        return False
    return created
