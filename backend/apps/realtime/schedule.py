from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

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


def attendee_can_join_live_session(session, *, now=None):
    if session.status != session.STATUS_LIVE:
        return False
    if session.session_type == session.TYPE_BROADCASTING:
        # The host's explicit broadcast state is authoritative, including
        # delayed or make-up classes outside the normal weekly window.
        return True
    return bool(get_live_class_schedule_snapshot(now=now)["is_open"])
