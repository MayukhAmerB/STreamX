"""Report weeks, computed on the server in IST (no admin pre-creation).

A course's week ends at its policy deadline (default Sunday 23:59 IST, the end
of that minute). The week an instant belongs to is the one whose deadline is
the next deadline at or after that instant, so:

* Sunday 23:59:59.999 IST  -> still this week (on time);
* Monday 00:00:00 IST      -> next week; last week is now in its late window
  (``grace_hours`` after the deadline, default 48 h at -10 % per started day).

``week_start`` is the first day of the week in IST (the day after the previous
deadline's day: Monday for a Sunday deadline). Week numbers count from the
course's ``start_date`` (its week is week 1); without a start date there is no
number and the label uses the dates.

Pure functions of (policy, instant): easy to property-test across the boundary.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.conf import settings

DAY = timedelta(days=1)
WEEK = timedelta(days=7)


def report_tz():
    return ZoneInfo(str(getattr(settings, "REPORTS_TIME_ZONE", "Asia/Kolkata") or "Asia/Kolkata"))


@dataclass(frozen=True)
class Week:
    week_start: date
    due_at: datetime
    late_until: datetime
    number: int | None

    @property
    def week_end(self) -> date:
        return self.week_start + timedelta(days=6)

    @property
    def key(self) -> str:
        return self.week_start.isoformat()

    def label(self) -> str:
        start, end = self.week_start, self.week_end
        if start.month == end.month:
            span = f"{start.day}–{end.day} {end.strftime('%b')}"
        else:
            span = f"{start.day} {start.strftime('%b')} – {end.day} {end.strftime('%b')}"
        return f"Week {self.number} · {span}" if self.number else f"Week of {span}"

    def status_at(self, at: datetime) -> str:
        """'open' (on time) | 'late' (grace window) | 'closed' | 'future'."""
        if at <= self.due_at:
            return "open" if at >= self.opens_at else "future"
        if at <= self.late_until:
            return "late"
        return "closed"

    @property
    def opens_at(self) -> datetime:
        return self.due_at - WEEK

    def minutes_late(self, at: datetime) -> int:
        if at <= self.due_at:
            return 0
        return int(math.ceil((at - self.due_at).total_seconds() / 60.0))

    def days_late(self, at: datetime) -> int:
        minutes = self.minutes_late(at)
        return int(math.ceil(minutes / (24 * 60.0))) if minutes else 0


def _due_moment(day: date, due_time: time, tz) -> datetime:
    """The deadline on ``day``: ``due_time`` through the end of that minute
    (23:59 means "until 23:59:59.999999")."""
    moment = datetime.combine(day, due_time.replace(tzinfo=None), tzinfo=tz)
    if due_time.second == 0 and due_time.microsecond == 0:
        moment += timedelta(seconds=59, microseconds=999999)
    return moment


def week_for(policy, at: datetime, *, anchor: date | None = None) -> Week:
    """The week ``at`` belongs to under ``policy`` (due_weekday, due_time, grace_hours)."""
    tz = report_tz()
    local = at.astimezone(tz)
    offset = (int(policy.due_weekday) - local.weekday()) % 7
    due_day = local.date() + timedelta(days=offset)
    due = _due_moment(due_day, policy.due_time, tz)
    if due < local:
        due_day += WEEK
        due = _due_moment(due_day, policy.due_time, tz)
    return _build(policy, due_day, due, anchor)


def week_starting(policy, week_start: date, *, anchor: date | None = None) -> Week:
    due_day = week_start + timedelta(days=6)
    return _build(policy, due_day, _due_moment(due_day, policy.due_time, report_tz()), anchor)


def previous_week(policy, week: Week, *, anchor: date | None = None) -> Week:
    return week_starting(policy, week.week_start - WEEK, anchor=anchor)


def _build(policy, due_day: date, due: datetime, anchor: date | None) -> Week:
    week_start = due_day - timedelta(days=6)
    late_until = due + timedelta(hours=int(policy.grace_hours or 0))
    return Week(
        week_start=week_start, due_at=due, late_until=late_until, number=week_number(policy, week_start, anchor)
    )


def week_number(policy, week_start: date, anchor: date | None) -> int | None:
    if anchor is None:
        return None
    anchor_week = week_for(policy, datetime.combine(anchor, time(0, 0), tzinfo=report_tz())).week_start
    number = (week_start - anchor_week).days // 7 + 1
    return number if number >= 1 else None


def penalty_percent(policy, days_late: int) -> Decimal:
    """Total percent deducted for ``days_late`` started days (never above 100)."""
    if days_late <= 0:
        return Decimal("0")
    return min(Decimal("100"), Decimal(policy.late_penalty_percent_per_day or 0) * days_late)


def selectable_weeks(policy, at: datetime, *, anchor: date | None = None) -> dict:
    """What a student may submit for at ``at``: always the current week, plus
    last week while it is in its late window. Past and future weeks are refused."""
    current = week_for(policy, at, anchor=anchor)
    previous = previous_week(policy, current, anchor=anchor)
    return {"current": current, "previous": previous if previous.status_at(at) == "late" else None}
