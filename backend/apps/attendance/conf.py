"""Attendance and calendar settings (all overridable from Django settings / env).

Defaults follow the owner rules:

* a student is PRESENT for a live class when they were present for at least
  ``ATTENDANCE_PRESENT_MIN_MINUTES`` (40) minutes while the session was on air;
* a session that was on air for less than that is a "short session": present
  then means at least ``ATTENDANCE_SHORT_SESSION_RATIO`` (80 %) of its on-air
  time, and the session is flagged for staff;
* joined but below the bar = partial (not counted as attended); never joined =
  absent. Only live presence counts: recordings never do.

The admin can change the two thresholds at runtime (Attendance policy in the
Django admin); these settings are the defaults for that row.
"""

from __future__ import annotations

from django.conf import settings

FEATURE_KEY = "attendance"
TIMEZONE_NAME = "Asia/Kolkata"


def _int(name: str, default: int, *, minimum: int = 0, maximum: int | None = None) -> int:
    try:
        value = int(getattr(settings, name, default))
    except (TypeError, ValueError):
        value = default
    value = max(minimum, value)
    return min(maximum, value) if maximum is not None else value


def tracking_since():
    """Aware datetime from ``ATTENDANCE_TRACKING_SINCE`` (None when unset or invalid).

    Classes that went on air before it are never finalised: no live presence
    was recorded for them, so every student would be marked absent. A bare
    date or a naive datetime is read in IST."""
    from datetime import datetime

    from django.utils import timezone
    from django.utils.dateparse import parse_date, parse_datetime

    raw = str(getattr(settings, "ATTENDANCE_TRACKING_SINCE", "") or "").strip()
    if not raw:
        return None
    try:
        value = parse_datetime(raw)
        if value is None:
            day = parse_date(raw)
            value = datetime(day.year, day.month, day.day) if day else None
    except (TypeError, ValueError):
        value = None
    if value is None:
        return None
    if timezone.is_naive(value):
        from zoneinfo import ZoneInfo

        value = timezone.make_aware(value, ZoneInfo(TIMEZONE_NAME))
    return value


def from_course_id() -> int | None:
    """``ATTENDANCE_FROM_COURSE_ID``: only batches (courses) with an id at or
    above it are tracked and judged; None (unset, 0 or invalid) = every course.

    Owner rule (Nov 2026): attendance starts with Batch 4 (course 28); earlier
    batches are never tracked, finalised or shown."""
    try:
        value = int(str(getattr(settings, "ATTENDANCE_FROM_COURSE_ID", "") or "").strip() or 0)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def course_tracked(course_id) -> bool:
    """True when attendance applies to this course. Without a rule every class
    counts (even one with no batch); with a rule a class needs a batch >= it."""
    first = from_course_id()
    if first is None:
        return True
    try:
        return course_id is not None and int(course_id) >= first
    except (TypeError, ValueError):
        return False


def _float(name: str, default: float, *, minimum: float = 0.0, maximum: float = 1.0) -> float:
    try:
        value = float(getattr(settings, name, default))
    except (TypeError, ValueError):
        value = default
    return min(maximum, max(minimum, value))


def present_min_minutes() -> int:
    return _int("ATTENDANCE_PRESENT_MIN_MINUTES", 40, minimum=1, maximum=600)


def short_session_ratio() -> float:
    return _float("ATTENDANCE_SHORT_SESSION_RATIO", 0.80, minimum=0.05, maximum=1.0)


def low_attendance_percent() -> int:
    return _int("ATTENDANCE_LOW_PERCENT", 75, minimum=1, maximum=100)


def presence_interval_seconds() -> int:
    """How often the live page pings (the client contract)."""
    return 60


def first_ping_credit_seconds() -> int:
    """Credit for a ping with no previous ping/join on record (that minute)."""
    return _int("ATTENDANCE_FIRST_PING_CREDIT_SECONDS", 60, minimum=0, maximum=120)


def max_ping_credit_seconds() -> int:
    """A gap longer than this (tab hidden, offline) is not credited beyond it."""
    return _int("ATTENDANCE_MAX_PING_CREDIT_SECONDS", 90, minimum=60, maximum=300)


def flush_interval_seconds() -> int:
    return _int("ATTENDANCE_FLUSH_INTERVAL_SECONDS", 120, minimum=15, maximum=3600)


def finalize_delay_seconds() -> int:
    """Wait for the last presence pings after a class ends."""
    return _int("ATTENDANCE_FINALIZE_DELAY_SECONDS", 90, minimum=0, maximum=3600)


def finalize_sweep_interval_seconds() -> int:
    return _int("ATTENDANCE_FINALIZE_SWEEP_SECONDS", 300, minimum=30, maximum=86400)


def finalize_sweep_lookback_hours() -> int:
    return _int("ATTENDANCE_FINALIZE_LOOKBACK_HOURS", 72, minimum=1, maximum=24 * 30)


def online_window_seconds() -> int:
    """A student whose last ping is younger than this shows as "online now"."""
    return _int("ATTENDANCE_ONLINE_WINDOW_SECONDS", 150, minimum=60, maximum=900)


# --- calendar -----------------------------------------------------------------------
def calendar_horizon_days() -> int:
    """Calendar occurrences are materialised this far ahead."""
    return _int("CALENDAR_HORIZON_DAYS", 30, minimum=1, maximum=180)


def calendar_session_lead_hours() -> int:
    """A RealtimeSession is created for an occurrence starting within this many hours.

    Kept short by default so the existing "Live classes" list (scheduled +
    live sessions) does not fill up with weeks of future rows. Set it to
    ``CALENDAR_HORIZON_DAYS * 24`` to create every session up front.
    """
    return _int("CALENDAR_SESSION_LEAD_HOURS", 24, minimum=1, maximum=180 * 24)


def calendar_materialize_interval_seconds() -> int:
    return _int("CALENDAR_MATERIALIZE_INTERVAL_SECONDS", 600, minimum=60, maximum=86400)


def calendar_feed_past_days() -> int:
    return _int("CALENDAR_FEED_PAST_DAYS", 30, minimum=0, maximum=365)


def calendar_feed_future_days() -> int:
    return _int("CALENDAR_FEED_FUTURE_DAYS", 90, minimum=1, maximum=365)


def max_schedule_occurrences() -> int:
    return _int("CALENDAR_MAX_SCHEDULE_OCCURRENCES", 400, minimum=10, maximum=2000)


def rate(name: str, default: str) -> str:
    return str(getattr(settings, name, "") or default)
