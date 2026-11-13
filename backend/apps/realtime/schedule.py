from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone


LIVE_CLASS_TIMEZONE_NAME = "Asia/Kolkata"
LIVE_CLASS_TIMEZONE = ZoneInfo(LIVE_CLASS_TIMEZONE_NAME)
LIVE_CLASS_WEEKDAYS = (4, 5, 6)  # Friday, Saturday, Sunday
LIVE_CLASS_START_TIME = time(hour=19, minute=0)
LIVE_CLASS_END_TIME = time(hour=20, minute=0)
LIVE_CLASS_SCHEDULE_LABEL = "Friday, Saturday and Sunday, 7:00 PM to 8:00 PM IST"


def _localize(value):
    current = value or timezone.now()
    if timezone.is_naive(current):
        current = timezone.make_aware(current, LIVE_CLASS_TIMEZONE)
    return current.astimezone(LIVE_CLASS_TIMEZONE)


def _window_for_date(local_date):
    start = datetime.combine(local_date, LIVE_CLASS_START_TIME, tzinfo=LIVE_CLASS_TIMEZONE)
    end = datetime.combine(local_date, LIVE_CLASS_END_TIME, tzinfo=LIVE_CLASS_TIMEZONE)
    return start, end


def get_live_class_schedule_snapshot(now=None):
    local_now = _localize(now)
    is_scheduled_day = local_now.weekday() in LIVE_CLASS_WEEKDAYS
    today_start, today_end = _window_for_date(local_now.date())
    is_open = bool(is_scheduled_day and today_start <= local_now < today_end)

    next_start = None
    next_end = None
    for day_offset in range(8):
        candidate_date = local_now.date() + timedelta(days=day_offset)
        if candidate_date.weekday() not in LIVE_CLASS_WEEKDAYS:
            continue
        candidate_start, candidate_end = _window_for_date(candidate_date)
        if candidate_end <= local_now:
            continue
        next_start = candidate_start
        next_end = candidate_end
        break

    return {
        "timezone": LIVE_CLASS_TIMEZONE_NAME,
        "timezone_label": "IST",
        "days": ["Friday", "Saturday", "Sunday"],
        "start_time": "19:00",
        "end_time": "20:00",
        "label": LIVE_CLASS_SCHEDULE_LABEL,
        "is_open": is_open,
        "next_start": next_start.isoformat() if next_start else None,
        "next_end": next_end.isoformat() if next_end else None,
        "server_time": local_now.isoformat(),
    }


# A live session older than this is treated as abandoned for attendees: the
# host forgot to end it, so it must not stay an unmoderated, joinable room
# forever. Long enough for any overrun, rejoin or make-up class. Hosts,
# instructors and admins are not bound by it. 0 disables the bound.
DEFAULT_ATTENDEE_JOIN_MAX_LIVE_HOURS = 6


def attendee_join_max_live_hours():
    try:
        hours = float(getattr(settings, "REALTIME_ATTENDEE_JOIN_MAX_LIVE_HOURS", DEFAULT_ATTENDEE_JOIN_MAX_LIVE_HOURS))
    except (TypeError, ValueError):
        hours = DEFAULT_ATTENDEE_JOIN_MAX_LIVE_HOURS
    return max(0.0, hours)


def live_session_is_stale(session, *, now=None):
    """True when a live session started longer ago than the attendee bound."""
    if getattr(session, "status", None) != getattr(session, "STATUS_LIVE", "live"):
        return False
    started_at = getattr(session, "started_at", None)
    max_hours = attendee_join_max_live_hours()
    if not started_at or max_hours <= 0:
        return False
    return (now or timezone.now()) - started_at > timedelta(hours=max_hours)


def attendee_can_join_live_session(session, *, now=None):
    """An attendee may join while the host has the session live, within a bound.

    The session's live state is authoritative, not the weekly wall-clock window:
    rejoining a meeting that overruns 20:00 IST, or a make-up class on another
    day, must work. A broadcast stays joinable while its encoder is briefly
    offline; the player shows a waiting state until the video returns. A
    session live for more than ``REALTIME_ATTENDEE_JOIN_MAX_LIVE_HOURS``
    (default 6) is treated as abandoned (the host never ended it) and no longer
    admits attendees.
    """
    return session.status == session.STATUS_LIVE and not live_session_is_stale(session, now=now)
