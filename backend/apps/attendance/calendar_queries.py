"""Calendar read models: a student's classes, the staff calendar, the public
"Live classes" list and the personal iCalendar feed token."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core import signing
from django.db.models import Q
from django.utils import timezone

from . import access, conf
from .models import AttendanceRecord, CalendarFeedToken, ScheduledClass, SessionAttendance
from .queries import _course_map, recording_links

IST = ZoneInfo(conf.TIMEZONE_NAME)
FEED_SALT = "attendance.calendar-feed"
MAX_RANGE_DAYS = 120
DEFAULT_AD_HOC_MINUTES = 60


def frontend_origin() -> str:
    return str(getattr(settings, "FRONTEND_PUBLIC_ORIGIN", "") or getattr(settings, "FRONTEND_URL", "") or "").rstrip("/")


def parse_range(start_text, end_text, *, now=None, default_days: int = 35) -> tuple[datetime, datetime]:
    """``from``/``to`` (ISO dates or datetimes, IST when naive), at most 120 days."""
    now = now or timezone.now()

    def _parse(text):
        if not text:
            return None
        try:
            value = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
        except ValueError:
            return None
        if timezone.is_naive(value):
            value = value.replace(tzinfo=IST)
        return value

    start = _parse(start_text)
    end = _parse(end_text)
    if start is None:
        today = timezone.localtime(now, IST).date()
        start = datetime.combine(today - timedelta(days=7), datetime.min.time(), tzinfo=IST)
    if end is None or end <= start:
        end = start + timedelta(days=default_days)
    if (end - start).days > MAX_RANGE_DAYS:
        end = start + timedelta(days=MAX_RANGE_DAYS)
    return start, end


def _host_name(user) -> str:
    if user is None:
        return ""
    return (getattr(user, "full_name", "") or "").strip() or "Instructor"


def _status(*, cancelled: bool, session, ends_at, now) -> str:
    if cancelled:
        return "cancelled"
    if session is not None:
        if session.status == "live":
            return "live"
        if session.status == "ended":
            return "ended"
    if ends_at <= now:
        return "ended"
    return "upcoming"


def _join_path(course_id) -> str:
    return f"/courses/{course_id}/live" if course_id else "/join-live"


def _session_course_id(session):
    return session.linked_course_id or getattr(session.linked_live_class, "linked_course_id", None)


def build_events(*, occurrences, ad_hoc_sessions, now, viewer=None, include_attendance=False, staff=False) -> list[dict]:
    session_ids = [row.session_id for row in occurrences if row.session_id] + [session.pk for session in ad_hoc_sessions]
    recordings = recording_links(session_ids)
    attendance = {}
    if include_attendance and viewer is not None and session_ids:
        attendance = dict(
            AttendanceRecord.objects.filter(
                user=viewer, session_ref_id__in=session_ids, finalized_at__isnull=False
            ).values_list("session_ref_id", "status")
        )
    summaries = {}
    if staff and session_ids:
        summaries = {
            row.session_ref_id: row for row in SessionAttendance.objects.filter(session_ref_id__in=session_ids)
        }
    course_ids = {row.course_id for row in occurrences} | {_session_course_id(session) for session in ad_hoc_sessions}
    courses = _course_map(course_ids)
    events = []
    for row in occurrences:
        session = row.session
        status = _status(
            cancelled=row.status == ScheduledClass.STATUS_CANCELLED, session=session, ends_at=row.ends_at, now=now
        )
        starts_at = row.starts_at
        ends_at = row.ends_at
        events.append(
            {
                "id": f"occ-{row.pk}",
                "uid": f"occ-{row.pk}",
                "session_id": row.session_id,
                "schedule_id": row.schedule_id,
                "title": row.title,
                "note": row.note,
                "kind": row.kind,
                "course": courses.get(row.course_id),
                "live_class_id": row.live_class_id,
                "starts_at": starts_at,
                "ends_at": ends_at,
                "host": {"id": row.host_id, "name": _host_name(row.host)} if staff else {"name": _host_name(row.host)},
                "status": status,
                "attendance": attendance.get(row.session_id),
                "can_join": status == "live",
                "join_path": _join_path(row.course_id),
                "recording": recordings.get(row.session_id),
                "manually_edited": row.manually_edited if staff else None,
                "counts": _counts(summaries.get(row.session_id)) if staff else None,
                "updated_at": row.updated_at,
            }
        )
    for session in ad_hoc_sessions:
        course_id = _session_course_id(session)
        live_class = session.linked_live_class
        minutes = int(getattr(live_class, "class_duration_minutes", 0) or DEFAULT_AD_HOC_MINUTES)
        starts_at = session.started_at or session.created_at
        ends_at = session.ended_at or (starts_at + timedelta(minutes=minutes))
        status = _status(cancelled=False, session=session, ends_at=ends_at, now=now)
        events.append(
            {
                "id": f"session-{session.pk}",
                "uid": f"session-{session.pk}",
                "session_id": session.pk,
                "schedule_id": None,
                "title": session.title,
                "note": "",
                "kind": "session",
                "course": courses.get(course_id),
                "live_class_id": session.linked_live_class_id,
                "starts_at": starts_at,
                "ends_at": ends_at,
                "host": {"id": session.host_id, "name": _host_name(session.host)} if staff else {"name": _host_name(session.host)},
                "status": status,
                "attendance": attendance.get(session.pk),
                "can_join": status == "live",
                "join_path": _join_path(course_id),
                "recording": recordings.get(session.pk),
                "manually_edited": None,
                "counts": _counts(summaries.get(session.pk)) if staff else None,
                "updated_at": session.updated_at,
            }
        )
    events.sort(key=lambda item: (item["starts_at"], item["id"]))
    return events


def _counts(summary):
    if summary is None:
        return None
    return {
        "roster": summary.roster_count,
        "present": summary.present_count,
        "partial": summary.partial_count,
        "absent": summary.absent_count,
        "excused": summary.excused_count,
        "short_session": summary.short_session,
    }


def serialize_event(event: dict) -> dict:
    data = {key: value for key, value in event.items() if key not in ("uid", "updated_at") and value is not None}
    data["starts_at"] = event["starts_at"].isoformat()
    data["ends_at"] = event["ends_at"].isoformat()
    data["date"] = timezone.localtime(event["starts_at"], IST).date().isoformat()
    data["timezone"] = conf.TIMEZONE_NAME
    for key in ("attendance", "recording", "session_id"):
        data.setdefault(key, None)
    return data


def _occurrence_queryset(start, end):
    return ScheduledClass.objects.filter(starts_at__lt=end, ends_at__gt=start).select_related("host", "session")


def _ad_hoc_queryset(start, end):
    from apps.realtime.models import RealtimeSession

    return (
        RealtimeSession.objects.filter(scheduled_class__isnull=True, started_at__isnull=False)
        .filter(started_at__lt=end)
        .filter(Q(ended_at__isnull=True) | Q(ended_at__gt=start))
        .select_related("host", "linked_live_class")
    )


def student_events(user, start, end, *, now=None) -> list[dict]:
    now = now or timezone.now()
    course_ids = access.student_course_ids(user)
    live_class_ids = access.student_live_class_ids(user)
    if not course_ids and not live_class_ids:
        return []
    occurrences = list(
        _occurrence_queryset(start, end).filter(Q(course_id__in=course_ids) | Q(live_class_id__in=live_class_ids))
    )
    sessions = list(
        _ad_hoc_queryset(start, end).filter(
            Q(linked_course_id__in=course_ids) | Q(linked_live_class_id__in=live_class_ids)
        )
    )
    return build_events(occurrences=occurrences, ad_hoc_sessions=sessions, now=now, viewer=user, include_attendance=True)


def staff_events(scope, start, end, *, course_id=None, host_id=None, now=None) -> list[dict]:
    now = now or timezone.now()
    occurrences = _occurrence_queryset(start, end)
    sessions = _ad_hoc_queryset(start, end)
    if scope is not access.ALL:
        occurrences = occurrences.filter(course_id__in=sorted(scope))
        sessions = sessions.filter(
            Q(linked_course_id__in=sorted(scope)) | Q(linked_live_class__linked_course_id__in=sorted(scope))
        )
    if course_id:
        access.require_course_in_scope(scope, course_id)
        occurrences = occurrences.filter(course_id=course_id)
        sessions = sessions.filter(Q(linked_course_id=course_id) | Q(linked_live_class__linked_course_id=course_id))
    if host_id:
        occurrences = occurrences.filter(host_id=host_id)
        sessions = sessions.filter(host_id=host_id)
    return build_events(
        occurrences=list(occurrences[:2000]), ad_hoc_sessions=list(sessions[:500]), now=now, staff=True
    )


def public_upcoming(*, limit: int = 12, now=None) -> list[dict]:
    """Upcoming classes of published courses (no personal data beyond the host's name)."""
    now = now or timezone.now()
    rows = list(
        ScheduledClass.objects.filter(
            status=ScheduledClass.STATUS_SCHEDULED, ends_at__gt=now, course__is_published=True
        )
        .select_related("course", "host", "session")
        .order_by("starts_at", "id")[: max(1, min(50, int(limit)))]
    )
    return [
        {
            "id": f"occ-{row.pk}",
            "title": row.title,
            "course": {"id": row.course_id, "title": row.course.title, "slug": row.course.slug, "batch": row.course.batch or ""},
            "starts_at": row.starts_at.isoformat(),
            "ends_at": row.ends_at.isoformat(),
            "date": timezone.localtime(row.starts_at, IST).date().isoformat(),
            "timezone": conf.TIMEZONE_NAME,
            "host": {"name": _host_name(row.host)},
            "status": "live" if row.session is not None and row.session.status == "live" else "upcoming",
            "kind": row.kind,
        }
        for row in rows
    ]


# --- iCalendar feed --------------------------------------------------------------------------------
def _signer():
    return signing.Signer(salt=FEED_SALT)


def feed_token(feed: CalendarFeedToken) -> str:
    return _signer().sign(f"{feed.user_id}.{feed.nonce}")


def resolve_feed_token(token: str) -> CalendarFeedToken | None:
    try:
        value = _signer().unsign(str(token or ""))
    except signing.BadSignature:
        return None
    user_part, _sep, nonce = value.partition(".")
    if not user_part.isdigit() or not nonce:
        return None
    feed = CalendarFeedToken.objects.select_related("user").filter(user_id=int(user_part)).first()
    if feed is None or not feed.active or feed.nonce != nonce or not feed.user.is_active:
        return None
    return feed


def ics_events(events: list[dict]) -> list[dict]:
    origin = frontend_origin()
    items = []
    for event in events:
        course = event.get("course") or {}
        description = [f"Batch: {course.get('title', '')}".strip()] if course else []
        host = (event.get("host") or {}).get("name")
        if host:
            description.append(f"Host: {host}")
        if event.get("note"):
            description.append(str(event["note"]))
        join_url = f"{origin}{event['join_path']}" if origin else ""
        if join_url:
            description.append(f"Join: {join_url}")
        updated_at = event.get("updated_at")
        items.append(
            {
                "uid": event["uid"],
                "title": event["title"],
                "starts_at": event["starts_at"],
                "ends_at": event["ends_at"],
                "cancelled": event["status"] == "cancelled",
                "description": "\n".join(description),
                "location": "Al Syed Initiative live classroom",
                "url": join_url,
                "updated_at": updated_at,
                "sequence": int(updated_at.timestamp()) // 60 % 2_000_000_000 if updated_at else 0,
            }
        )
    return items
