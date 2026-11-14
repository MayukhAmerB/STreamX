"""Live presence: pings, join and leave (Redis only, no database writes).

Credit is measured by wall clock between a student's consecutive presence
events for the same session (ping, join or leave), capped at
``ATTENDANCE_MAX_PING_CREDIT_SECONDS`` so a long gap (tab hidden, offline) is
not credited. Only events while the session is live count: watching a
recording afterwards never adds attendance.

The session status and the student's access decision are cached briefly, so
a steady stream of pings costs no database query at all.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from django.core.cache import cache

from . import buffer, conf

logger = logging.getLogger("apps.attendance.presence")

STATUS_CACHE_SECONDS = 30
ACCESS_CACHE_SECONDS = 300

ROLE_ATTENDEE = 1
ROLE_MANAGER = 2
ROLE_DENIED = 3


@dataclass(frozen=True)
class PingResult:
    counted: bool
    credited_seconds: int
    reason: str = ""

    def as_dict(self) -> dict:
        data = {"counted": self.counted, "credited_seconds": self.credited_seconds}
        if self.reason:
            data["reason"] = self.reason
        return data


def _status_key(session_id) -> str:
    return f"att:st:{int(session_id)}"


def _role_key(session_id, user_id) -> str:
    return f"att:role:{int(session_id)}:{int(user_id)}"


def session_status(session_id) -> str:
    """"live" | "scheduled" | "ended" | "missing" (cached 30 s)."""
    key = _status_key(session_id)
    try:
        status = cache.get(key)
    except Exception:  # noqa: BLE001
        status = None
    if status is None:
        from apps.realtime.models import RealtimeSession

        status = RealtimeSession.objects.filter(pk=session_id).values_list("status", flat=True).first() or "missing"
        try:
            cache.set(key, status, timeout=STATUS_CACHE_SECONDS)
        except Exception:  # noqa: BLE001
            pass
    return status


def forget_session_status(session_id) -> None:
    try:
        cache.delete(_status_key(session_id))
    except Exception:  # noqa: BLE001
        pass


def viewer_role(session_id, user) -> int:
    """Attendee, manager (host/staff/instructor: not counted) or denied (cached 5 min)."""
    key = _role_key(session_id, user.pk)
    try:
        role = cache.get(key)
    except Exception:  # noqa: BLE001
        role = None
    if role is None:
        from apps.realtime.domain import get_access_decision
        from apps.realtime.models import RealtimeSession

        session = RealtimeSession.objects.with_related().filter(pk=session_id).first()
        if session is None:
            return ROLE_DENIED
        decision = get_access_decision(session, user)
        if not decision.allowed:
            role = ROLE_DENIED
        elif decision.is_host or decision.is_admin or decision.is_instructor_owner:
            role = ROLE_MANAGER
        else:
            role = ROLE_ATTENDEE
        try:
            cache.set(key, role, timeout=ACCESS_CACHE_SECONDS)
        except Exception:  # noqa: BLE001
            pass
    return int(role)


def remember_role(session_id, user_id, role: int) -> None:
    try:
        cache.set(_role_key(session_id, user_id), int(role), timeout=ACCESS_CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        pass


def _credit(previous: float | None, now_ts: float, *, first_credit: int) -> int:
    if previous is None:
        return first_credit
    elapsed = now_ts - float(previous)
    if elapsed <= 0:
        return 0
    return int(round(min(conf.max_ping_credit_seconds(), elapsed)))


def credit_ping(session_id: int, user_id: int, *, now_ts: float | None = None) -> int:
    """Record one presence ping for a live session (caller checked access)."""
    now_ts = time.time() if now_ts is None else float(now_ts)
    previous = buffer.swap_last_seen(session_id, user_id, now_ts)
    credit = _credit(previous, now_ts, first_credit=conf.first_ping_credit_seconds())
    buffer.record(session_id, user_id, seconds=credit, ts=now_ts)
    return credit


def credit_join(session_id: int, user_id: int, *, now_ts: float | None = None) -> int:
    """A join starts (or resumes) the clock; it credits the gap since a recent ping only."""
    now_ts = time.time() if now_ts is None else float(now_ts)
    previous = buffer.swap_last_seen(session_id, user_id, now_ts)
    credit = _credit(previous, now_ts, first_credit=0)
    buffer.record(session_id, user_id, seconds=credit, ts=now_ts)
    return credit


def credit_leave(session_id: int, user_id: int, *, now_ts: float | None = None) -> int:
    """Leaving credits the time since the last ping and stops the clock."""
    now_ts = time.time() if now_ts is None else float(now_ts)
    previous = buffer.swap_last_seen(session_id, user_id, now_ts)
    credit = _credit(previous, now_ts, first_credit=0)
    if credit or previous is not None:
        buffer.record(session_id, user_id, seconds=credit, ts=now_ts)
    buffer.clear_last_seen(session_id, user_id)
    return credit


def ping(session_id: int, user, *, kind: str = "ping") -> PingResult:
    """Validate and record a ping/leave from the attendance API.

    Raises ``NotFound`` / ``PermissionDenied`` (domain errors) for a missing
    session or a viewer without access; a class that is not live is answered
    with ``counted: False``.
    """
    from apps.core.errors import NotFound, PermissionDenied

    status = session_status(session_id)
    if status == "missing":
        raise NotFound("Live class not found.", code="live_session_not_found")
    role = viewer_role(session_id, user)
    if role == ROLE_DENIED:
        raise PermissionDenied("You do not have access to this class.", code="live_session_forbidden")
    if status != "live":
        return PingResult(False, 0, "not_live")
    if role == ROLE_MANAGER:
        return PingResult(False, 0, "host_or_staff")
    if kind == "leave":
        return PingResult(True, credit_leave(int(session_id), user.pk))
    return PingResult(True, credit_ping(int(session_id), user.pk))
