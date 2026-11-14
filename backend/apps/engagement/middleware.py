"""``X-Engagement`` response header for XP-earning requests.

The signal receivers note "this request queued an XP-earning event for user
N (about P XP)". Only for such requests does this middleware add::

    X-Engagement: {"xp": 130, "level": {...}, "streak": {...}, "pending_xp": 20, "version": 7}

The snapshot comes from the cache the worker refreshes after every award (no
database query); when it is missing the header carries ``pending_xp`` only.
Every other request pays one context-variable set/reset and nothing else,
and a failure here never changes the response.
"""

from __future__ import annotations

import json
import logging

from django.core.cache import cache

from .metrics import record_hook_failure
from .signals import pending_awards

logger = logging.getLogger("apps.engagement.middleware")

HEADER = "X-Engagement"


class EngagementSnapshotMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        token = pending_awards.set({})
        try:
            response = self.get_response(request)
            pending = pending_awards.get() or {}
        finally:
            pending_awards.reset(token)
        if not pending:
            return response
        try:
            user = getattr(request, "user", None)
            user_id = getattr(user, "pk", None) if getattr(user, "is_authenticated", False) else None
            if user_id in pending and 200 <= int(getattr(response, "status_code", 500)) < 300:
                response[HEADER] = json.dumps(header_value(user_id, pending[user_id]), separators=(",", ":"))
        except Exception:  # noqa: BLE001 - informative only
            record_hook_failure("snapshot_header")
            logger.debug("engagement header failed", exc_info=True)
        return response


def header_value(user_id: int, pending_xp: int) -> dict:
    from .services import snapshot_cache_key

    value = {"pending_xp": int(pending_xp)}
    snapshot = cache.get(snapshot_cache_key(user_id))
    if isinstance(snapshot, dict):
        value.update(
            xp=snapshot.get("xp", 0),
            level=snapshot.get("level"),
            streak={
                "current": (snapshot.get("streak") or {}).get("current", 0),
                "alive": (snapshot.get("streak") or {}).get("alive", False),
            },
            version=snapshot.get("version", 0),
        )
    return value
