"""Class calendar: occurrences from a schedule, materialisation, notifications.

``generate_occurrences`` is pure (used by the preview endpoint and the
materialiser): weekdays between the start and end dates at the schedule's
local time (``Asia/Kolkata`` has no daylight saving, so a 19:00 class is
always 13:30 UTC), minus cancelled dates, with rescheduled dates moved and
extra classes added.

``materialize_schedule`` runs from the worker (every 10 min, and right after
a schedule is saved). It is idempotent:

* one ``ScheduledClass`` per occurrence key (unique), updated in place;
* a ``RealtimeSession`` is created through the existing creation service
  (``session_payload_for_create``) only for occurrences starting within
  ``CALENDAR_SESSION_LEAD_HOURS``; an active, unlinked session of the same
  live class is adopted instead of creating a duplicate;
* manual edits win: a generated session someone edited is never changed
  again, and one someone deleted is never re-created;
* past and already-started occurrences are never modified.
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone

from . import conf
from .models import WEEKDAY_NAMES, ClassSchedule, ScheduledClass, ScheduleException

logger = logging.getLogger("apps.attendance.scheduling")

PLACEHOLDER = re.compile(r"\{(course|batch|live_class|n|date|weekday)\}")
SHORT_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


@dataclass
class ScheduleSpec:
    title_pattern: str
    start_date: date
    end_date: date
    weekdays: list[int]
    start_time: object  # datetime.time
    duration_minutes: int
    timezone: str = conf.TIMEZONE_NAME
    course_title: str = ""
    batch: str = ""
    live_class_title: str = ""
    schedule_id: int | None = None

    @property
    def tz(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.timezone or conf.TIMEZONE_NAME)
        except Exception:  # noqa: BLE001
            return ZoneInfo(conf.TIMEZONE_NAME)


@dataclass
class ExceptionSpec:
    kind: str
    date: date
    new_start: datetime | None = None
    duration_minutes: int | None = None
    title: str = ""
    note: str = ""
    id: int | None = None


@dataclass
class Occurrence:
    key: str
    original_date: date
    kind: str
    status: str
    starts_at: datetime
    ends_at: datetime
    title: str
    note: str = ""
    number: int | None = None
    exception_id: int | None = None
    extra: dict = field(default_factory=dict)

    def as_dict(self, tz: ZoneInfo) -> dict:
        local = timezone.localtime(self.starts_at, tz)
        return {
            "key": self.key,
            "date": local.date().isoformat(),
            "weekday": WEEKDAY_NAMES[local.weekday()],
            "starts_at": self.starts_at.isoformat(),
            "ends_at": self.ends_at.isoformat(),
            "local_time": local.strftime("%H:%M"),
            "kind": self.kind,
            "status": self.status,
            "title": self.title,
            "note": self.note,
            "number": self.number,
        }


def spec_from_schedule(schedule: ClassSchedule) -> ScheduleSpec:
    course = schedule.course
    live_class = schedule.live_class
    return ScheduleSpec(
        title_pattern=schedule.title_pattern,
        start_date=schedule.start_date,
        end_date=schedule.end_date,
        weekdays=list(schedule.weekdays or []),
        start_time=schedule.start_time,
        duration_minutes=int(schedule.duration_minutes or 60),
        timezone=schedule.timezone or conf.TIMEZONE_NAME,
        course_title=getattr(course, "title", "") or "",
        batch=getattr(course, "batch", "") or "",
        live_class_title=getattr(live_class, "title", "") or "",
        schedule_id=schedule.pk,
    )


def exceptions_from_rows(rows) -> list[ExceptionSpec]:
    return [
        ExceptionSpec(
            kind=row.kind,
            date=row.date,
            new_start=row.new_start,
            duration_minutes=row.duration_minutes,
            title=row.title or "",
            note=row.note or "",
            id=row.pk,
        )
        for row in rows
    ]


def render_title(pattern: str, *, spec: ScheduleSpec, number: int | None, local: datetime) -> str:
    values = {
        "course": spec.course_title,
        "batch": spec.batch,
        "live_class": spec.live_class_title,
        "n": "" if number is None else str(number),
        "date": f"{local.day} {local.strftime('%b')}",
        "weekday": WEEKDAY_NAMES[local.weekday()],
    }
    text = PLACEHOLDER.sub(lambda match: values[match.group(1)], pattern or "")
    text = " ".join(text.split()).strip(" ·-")
    return (text or spec.course_title or "Live class")[:255]


def _aware(value: datetime, tz: ZoneInfo) -> datetime:
    if timezone.is_naive(value):
        return value.replace(tzinfo=tz)
    return value


def generate_occurrences(spec: ScheduleSpec, exceptions: list[ExceptionSpec], *, limit: int | None = None) -> list[Occurrence]:
    """Every occurrence of the schedule (cancelled ones included), sorted by start."""
    tz = spec.tz
    limit = limit or conf.max_schedule_occurrences()
    weekdays = {int(day) for day in spec.weekdays or [] if 0 <= int(day) <= 6}
    cancelled = {exc.date for exc in exceptions if exc.kind == ScheduleException.KIND_CANCELLED}
    moved = {exc.date: exc for exc in exceptions if exc.kind == ScheduleException.KIND_RESCHEDULED and exc.new_start}
    duration = timedelta(minutes=max(1, int(spec.duration_minutes or 60)))
    prefix = f"s{spec.schedule_id}" if spec.schedule_id else "preview"
    items: list[Occurrence] = []
    day = spec.start_date
    while day <= spec.end_date and len(items) < limit:
        if day.weekday() in weekdays:
            start = datetime.combine(day, spec.start_time, tzinfo=tz)
            occ = Occurrence(
                key=f"{prefix}:{day.isoformat()}",
                original_date=day,
                kind=ScheduledClass.KIND_REGULAR,
                status=ScheduledClass.STATUS_SCHEDULED,
                starts_at=start,
                ends_at=start + duration,
                title="",
            )
            if day in cancelled:
                occ.status = ScheduledClass.STATUS_CANCELLED
                match = next((exc for exc in exceptions if exc.kind == ScheduleException.KIND_CANCELLED and exc.date == day), None)
                occ.note = getattr(match, "note", "") or ""
                occ.exception_id = getattr(match, "id", None)
            elif day in moved:
                exc = moved[day]
                new_start = _aware(exc.new_start, tz)
                occ.kind = ScheduledClass.KIND_RESCHEDULED
                occ.starts_at = new_start
                occ.ends_at = new_start + timedelta(minutes=int(exc.duration_minutes or spec.duration_minutes or 60))
                occ.note = exc.note
                occ.exception_id = exc.id
                occ.extra["title"] = exc.title
            items.append(occ)
        day += timedelta(days=1)
    for index, exc in enumerate(exc for exc in exceptions if exc.kind == ScheduleException.KIND_EXTRA and exc.new_start):
        if len(items) >= limit:
            break
        new_start = _aware(exc.new_start, tz)
        items.append(
            Occurrence(
                key=f"{prefix}:x{exc.id if exc.id else index + 1}",
                original_date=timezone.localtime(new_start, tz).date(),
                kind=ScheduledClass.KIND_EXTRA,
                status=ScheduledClass.STATUS_SCHEDULED,
                starts_at=new_start,
                ends_at=new_start + timedelta(minutes=int(exc.duration_minutes or spec.duration_minutes or 60)),
                title="",
                note=exc.note,
                exception_id=exc.id,
                extra={"title": exc.title},
            )
        )
    items.sort(key=lambda item: (item.starts_at, item.key))
    number = 0
    for occ in items:
        if occ.status != ScheduledClass.STATUS_CANCELLED:
            number += 1
            occ.number = number
        local = timezone.localtime(occ.starts_at, tz)
        custom = str(occ.extra.get("title") or "").strip()
        occ.title = custom[:255] if custom else render_title(spec.title_pattern, spec=spec, number=occ.number, local=local)
        occ.starts_at = occ.starts_at.astimezone(dt_timezone.utc)
        occ.ends_at = occ.ends_at.astimezone(dt_timezone.utc)
    return items


# --- materialisation ------------------------------------------------------------------------------
def session_fingerprint(session) -> str:
    raw = "|".join(
        str(value)
        for value in (
            session.title,
            session.host_id,
            session.session_type,
            session.stream_service,
            session.linked_live_class_id,
        )
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _find_adoptable_session(row: ScheduledClass, schedule: ClassSchedule):
    """An unlinked session of the same live class made for this occurrence (never duplicate).

    Adopted: a scheduled (not yet started) session created by hand shortly
    before this occurrence, or one that went live inside its time window.
    """
    from django.db.models import Q

    from apps.realtime.models import RealtimeSession

    created_after = row.starts_at - timedelta(hours=conf.calendar_session_lead_hours() + 24)
    window_start = row.starts_at - timedelta(hours=2)
    window_end = row.ends_at + timedelta(hours=1)
    return (
        RealtimeSession.objects.filter(linked_live_class_id=schedule.live_class_id, scheduled_class__isnull=True)
        .filter(
            Q(status=RealtimeSession.STATUS_SCHEDULED, started_at__isnull=True, created_at__gte=created_after)
            | Q(started_at__gte=window_start, started_at__lte=window_end)
        )
        .order_by("-created_at")
        .first()
    )


def _ensure_session(row: ScheduledClass, schedule: ClassSchedule, *, now) -> str:
    """Create (or adopt) the RealtimeSession for an upcoming occurrence."""
    from apps.realtime.domain import session_payload_for_create
    from apps.realtime.models import RealtimeSession

    with transaction.atomic():
        row = ScheduledClass.objects.select_for_update().get(pk=row.pk)
        if row.session_id or row.session_created_at or row.manually_edited or row.status != ScheduledClass.STATUS_SCHEDULED:
            return "skipped"
        adopted = _find_adoptable_session(row, schedule)
        if adopted is not None:
            row.session = adopted
            row.session_created_at = now
            row.manually_edited = True  # someone made it by hand: never change it
            row.session_fingerprint = session_fingerprint(adopted)
            row.save(update_fields=["session", "session_created_at", "manually_edited", "session_fingerprint", "updated_at"])
            return "adopted"
        payload = session_payload_for_create(
            {
                "title": row.title,
                "description": schedule.description or row.note or "",
                "session_type": schedule.session_type,
                "stream_service": schedule.stream_service
                if schedule.session_type == RealtimeSession.TYPE_BROADCASTING
                else RealtimeSession.STREAM_SERVICE_ALSYED,
                "linked_live_class": schedule.live_class,
                "status": RealtimeSession.STATUS_SCHEDULED,
            }
        )
        session = RealtimeSession.objects.create(host=row.host or schedule.host, **payload)
        row.session = session
        row.session_created_at = now
        row.session_fingerprint = session_fingerprint(session)
        row.save(update_fields=["session", "session_created_at", "session_fingerprint", "updated_at"])
    return "created"


def _sync_session(row: ScheduledClass, schedule: ClassSchedule) -> str:
    """Keep an untouched generated session in step with its occurrence."""
    session = row.session
    if session is None or row.manually_edited:
        return "skipped"
    if session.status != session.STATUS_SCHEDULED:
        return "skipped"  # live or ended: history, never touched
    if session_fingerprint(session) != row.session_fingerprint:
        row.manually_edited = True
        row.save(update_fields=["manually_edited", "updated_at"])
        return "manual"
    if row.status == ScheduledClass.STATUS_CANCELLED:
        if session.started_at is None:
            session.delete()  # never on air and untouched: nothing to keep
            row.refresh_from_db(fields=["session"])
            return "deleted"
        return "skipped"
    host_id = row.host_id or schedule.host_id
    if session.title != row.title or session.host_id != host_id:
        session.title = row.title
        session.host_id = host_id
        session.save(update_fields=["title", "host", "updated_at"])
        row.session_fingerprint = session_fingerprint(session)
        row.save(update_fields=["session_fingerprint", "updated_at"])
        return "updated"
    return "unchanged"


@dataclass
class Change:
    kind: str  # added | cancelled | rescheduled | restored
    title: str
    starts_at: datetime
    previous_start: datetime | None = None
    note: str = ""


def materialize_schedule(schedule: ClassSchedule, *, now=None, notify: bool = False) -> dict:
    now = now or timezone.now()
    tz = schedule.tz
    horizon_end = timezone.localtime(now, tz).date() + timedelta(days=conf.calendar_horizon_days())
    lead_end = now + timedelta(hours=conf.calendar_session_lead_hours())
    first_run = schedule.last_materialized_at is None
    occurrences = []
    if schedule.is_active:
        occurrences = [
            occ
            for occ in generate_occurrences(spec_from_schedule(schedule), exceptions_from_rows(schedule.exceptions.all()))
            if occ.ends_at > now and timezone.localtime(occ.starts_at, tz).date() <= horizon_end
        ]
    existing = {
        row.occurrence_key: row
        for row in ScheduledClass.objects.filter(schedule=schedule, ends_at__gt=now).select_related("session")
    }
    stats = {"created": 0, "updated": 0, "cancelled": 0, "sessions_created": 0, "sessions_adopted": 0, "sessions_deleted": 0}
    changes: list[Change] = []
    touched: list[ScheduledClass] = []
    host_id = schedule.host_id
    for occ in occurrences:
        row = existing.pop(occ.key, None)
        if row is None:
            row = ScheduledClass.objects.filter(occurrence_key=occ.key).select_related("session").first()
            if row is not None and row.ends_at <= now:
                continue  # an already finished occurrence: history
        if row is None:
            row = ScheduledClass.objects.create(
                schedule=schedule,
                occurrence_key=occ.key,
                original_date=occ.original_date,
                kind=occ.kind,
                status=occ.status,
                title=occ.title,
                note=occ.note,
                course_id=schedule.course_id,
                live_class_id=schedule.live_class_id,
                host_id=host_id,
                starts_at=occ.starts_at,
                ends_at=occ.ends_at,
            )
            stats["created"] += 1
            if occ.status == ScheduledClass.STATUS_SCHEDULED and (not first_run or occ.kind == ScheduledClass.KIND_EXTRA):
                changes.append(Change("added", occ.title, occ.starts_at, note=occ.note))
            elif occ.status == ScheduledClass.STATUS_CANCELLED and not first_run:
                changes.append(Change("cancelled", occ.title, occ.starts_at, note=occ.note))
            touched.append(row)
            continue
        if row.starts_at <= now and row.status == ScheduledClass.STATUS_SCHEDULED:
            touched.append(row)
            continue  # already started: never moved or renamed
        previous = (row.status, row.starts_at, row.ends_at, row.title, row.note, row.kind, row.host_id)
        if row.status != occ.status:
            changes.append(
                Change(
                    "cancelled" if occ.status == ScheduledClass.STATUS_CANCELLED else "restored",
                    occ.title,
                    occ.starts_at,
                    note=occ.note,
                )
            )
        elif row.starts_at != occ.starts_at and occ.status == ScheduledClass.STATUS_SCHEDULED:
            changes.append(Change("rescheduled", occ.title, occ.starts_at, previous_start=row.starts_at, note=occ.note))
        row.status, row.starts_at, row.ends_at = occ.status, occ.starts_at, occ.ends_at
        row.title, row.note, row.kind = occ.title, occ.note, occ.kind
        row.course_id, row.live_class_id, row.host_id = schedule.course_id, schedule.live_class_id, host_id
        if previous != (row.status, row.starts_at, row.ends_at, row.title, row.note, row.kind, row.host_id):
            row.save()
            stats["updated"] += 1
        touched.append(row)
    for row in existing.values():
        # No longer generated (weekday removed, dates shortened, extra deleted, schedule paused).
        if row.status == ScheduledClass.STATUS_CANCELLED or row.starts_at <= now:
            continue
        row.status = ScheduledClass.STATUS_CANCELLED
        row.save(update_fields=["status", "updated_at"])
        stats["cancelled"] += 1
        changes.append(Change("cancelled", row.title, row.starts_at))
        touched.append(row)
    for row in touched:
        if row.session_id:
            result = _sync_session(row, schedule)
            if result == "deleted":
                stats["sessions_deleted"] += 1
        elif row.status == ScheduledClass.STATUS_SCHEDULED and now - timedelta(hours=1) <= row.starts_at <= lead_end:
            result = _ensure_session(row, schedule, now=now)
            if result == "created":
                stats["sessions_created"] += 1
            elif result == "adopted":
                stats["sessions_adopted"] += 1
    ClassSchedule.objects.filter(pk=schedule.pk).update(last_materialized_at=now)
    schedule.last_materialized_at = now
    if notify and (changes or first_run):
        notify_changes(schedule, changes, first_run=first_run, now=now)
    stats["changes"] = len(changes)
    return stats


def materialize_all(*, now=None, limit: int = 200) -> dict:
    now = now or timezone.now()
    today = timezone.localtime(now, ZoneInfo(conf.TIMEZONE_NAME)).date()
    totals: dict[str, int] = {"schedules": 0}
    schedules = (
        ClassSchedule.objects.filter(end_date__gte=today - timedelta(days=1))
        .select_related("course", "live_class")
        .order_by("pk")[:limit]
    )
    for schedule in schedules:
        try:
            stats = materialize_schedule(schedule, now=now, notify=False)
        except Exception:  # noqa: BLE001 - one broken schedule must not stop the rest
            logger.exception("calendar.materialize failed schedule_id=%s", schedule.pk)
            continue
        totals["schedules"] += 1
        for key, value in stats.items():
            totals[key] = totals.get(key, 0) + int(value)
    return totals


# --- notifications --------------------------------------------------------------------------------
def _when(value: datetime, tz: ZoneInfo) -> str:
    local = timezone.localtime(value, tz)
    hour = local.strftime("%I:%M %p").lstrip("0")
    return f"{SHORT_WEEKDAYS[local.weekday()]} {local.day} {local.strftime('%b')}, {hour} IST"


def describe_changes(schedule: ClassSchedule, changes: list[Change], *, first_run: bool) -> tuple[str, str]:
    tz = schedule.tz
    course = getattr(schedule.course, "title", "") or "your batch"
    if first_run and not [change for change in changes if change.kind != "added"]:
        days = ", ".join(SHORT_WEEKDAYS[day] for day in sorted(schedule.weekdays or []))
        local_time = datetime.combine(schedule.start_date, schedule.start_time).strftime("%I:%M %p").lstrip("0")
        return (
            "Class schedule published",
            f"{course}: live classes every {days} at {local_time} IST, from "
            f"{schedule.start_date.day} {schedule.start_date.strftime('%b')}. See your calendar.",
        )
    lines = []
    for change in changes[:4]:
        if change.kind == "cancelled":
            lines.append(f"Cancelled: {change.title} ({_when(change.starts_at, tz)}).")
        elif change.kind == "rescheduled":
            lines.append(f"Moved: {change.title} is now {_when(change.starts_at, tz)}.")
        elif change.kind == "restored":
            lines.append(f"Back on: {change.title} ({_when(change.starts_at, tz)}).")
        else:
            lines.append(f"New class: {change.title} ({_when(change.starts_at, tz)}).")
        if change.note:
            lines[-1] = lines[-1][:-1] + f" — {change.note}."
    if len(changes) > 4:
        lines.append(f"And {len(changes) - 4} more change(s). See your calendar.")
    return f"Class schedule changed: {course}"[:180], " ".join(lines)


def notify_changes(schedule: ClassSchedule, changes: list[Change], *, first_run: bool, now=None) -> None:
    """One notification to the batch (fail-safe; deduplicated per change set)."""
    try:
        from apps.notifications.models import Notification
        from apps.notifications.services import create_notification

        from .access import roster_user_ids

        title, body = describe_changes(schedule, changes, first_run=first_run)
        if not body:
            return
        digest = hashlib.sha256(
            "|".join(f"{c.kind}:{c.title}:{c.starts_at.isoformat()}" for c in changes).encode("utf-8")
            + f"|first={first_run}|v={schedule.version}".encode()
        ).hexdigest()[:20]
        create_notification(
            kind=Notification.KIND_ANNOUNCEMENT,
            title=title,
            body=body,
            recipients=roster_user_ids(course_id=schedule.course_id, live_class_id=schedule.live_class_id),
            event_key=f"calendar:{schedule.pk}:{digest}",
            action_url="/calendar",
            course=schedule.course,
            live_class=schedule.live_class,
        )
    except Exception:  # noqa: BLE001 - a notification failure never blocks the schedule
        logger.exception("calendar.notify failed schedule_id=%s", schedule.pk)
