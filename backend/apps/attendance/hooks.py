"""Entry points other apps call. Every one is fail-safe: it never raises, never
touches the database on the hot path and never slows the caller down.

* ``on_live_join``          realtime join view (after access was granted);
* ``on_engagement_presence`` the legacy ``/api/engagement/live/<id>/presence/``
                            alias, so both endpoints feed attendance;
* session end               a ``post_save`` receiver in ``signals.py``.
"""

from __future__ import annotations

import logging

from .metrics import record_hook_failure

logger = logging.getLogger("apps.attendance.hooks")


def on_live_join(*, session, user, is_manager: bool = False) -> None:
    """A student entered a live class: start their attendance clock (Redis only)."""
    try:
        from . import access, presence

        if not access.enabled() or session is None or user is None or not getattr(user, "pk", None):
            return
        if is_manager:
            presence.remember_role(session.pk, user.pk, presence.ROLE_MANAGER)
            return
        if getattr(session, "status", None) != "live":
            return
        if not presence.session_tracked(session.pk):
            return  # batch excluded by ATTENDANCE_FROM_COURSE_ID
        presence.remember_role(session.pk, user.pk, presence.ROLE_ATTENDEE)
        presence.credit_join(int(session.pk), int(user.pk))
    except Exception:  # noqa: BLE001 - attendance must never break joining a class
        logger.exception("attendance.hook_failed hook=on_live_join")
        record_hook_failure("on_live_join")


def on_engagement_presence(session_id, user) -> None:
    """The engagement presence alias also records attendance (never raises)."""
    try:
        from . import access, presence

        if not access.enabled():
            return
        presence.ping(int(session_id), user)
    except Exception as exc:  # noqa: BLE001 - attendance must never break the engagement endpoint
        from apps.core.errors import DomainError

        if isinstance(exc, DomainError):  # not found / no access: engagement answers those itself
            return
        logger.exception("attendance.hook_failed hook=on_engagement_presence")
        record_hook_failure("on_engagement_presence")
