"""Attendance read models for the student and staff APIs (no writes here)."""

from __future__ import annotations

import csv
import io
import time
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.db.models import Count, Max, Q
from django.utils import timezone

from apps.core.errors import NotFound

from . import access, buffer, conf, policy
from .models import AttendancePolicy, AttendanceRecord, SessionAttendance

IST = ZoneInfo(conf.TIMEZONE_NAME)
MAX_MATRIX_SESSIONS = 120
MAX_PAGE_SIZE = 100
NOT_JOINED = "not_joined"


# --- helpers ----------------------------------------------------------------------------
def ist_date(value) -> str | None:
    if not value:
        return None
    return timezone.localtime(value, IST).date().isoformat()


def iso(value) -> str | None:
    return value.isoformat() if value else None


def _course_map(course_ids) -> dict[int, dict]:
    from apps.courses.models import Course

    ids = {int(pk) for pk in course_ids if pk}
    if not ids:
        return {}
    return {
        row["id"]: {"id": row["id"], "title": row["title"], "batch": row["batch"] or ""}
        for row in Course.objects.filter(pk__in=ids).values("id", "title", "batch")
    }


def _user_map(user_ids) -> dict[int, dict]:
    ids = {int(pk) for pk in user_ids if pk}
    if not ids:
        return {}
    rows = get_user_model().objects.filter(pk__in=ids).values("id", "full_name", "email")
    return {
        row["id"]: {"id": row["id"], "name": (row["full_name"] or "").strip() or row["email"], "email": row["email"]}
        for row in rows
    }


def recording_links(session_ids) -> dict[int, dict]:
    """Published class recordings: ``{session_id: {lecture_id, course_id, url}}``."""
    ids = [int(pk) for pk in session_ids if pk]
    if not ids:
        return {}
    try:
        from apps.realtime.recording.models import ClassRecording
    except Exception:  # noqa: BLE001
        return {}
    rows = (
        ClassRecording.objects.filter(
            session_id__in=ids,
            state=ClassRecording.STATE_PUBLISHED,
            lecture__isnull=False,
            lecture__is_published=True,
        )
        .order_by("published_at", "id")
        .values("session_id", "lecture_id", "lecture__section__course_id")
    )
    links = {}
    for row in rows:
        if row["session_id"] in links:
            continue
        course_id = row["lecture__section__course_id"]
        links[row["session_id"]] = {
            "lecture_id": row["lecture_id"],
            "course_id": course_id,
            "url": f"/learn/{course_id}?lesson={row['lecture_id']}",
        }
    return links


def rule_payload(policy_row=None) -> dict:
    policy_row = policy_row or AttendancePolicy.current()
    rule = policy.Rule.from_policy(policy_row)
    return {
        "present_min_minutes": rule.present_min_minutes,
        "short_session_percent": int(round(rule.short_session_ratio * 100)),
        "low_attendance_percent": int(policy_row.low_attendance_percent),
        "label": rule.label(),
        "explanation": (
            f"A class counts as attended when you were in the live class for at least {rule.present_min_minutes} "
            "minutes. Watching the recording later does not count. If a class ran shorter than that, "
            f"{int(round(rule.short_session_ratio * 100))}% of its live time counts."
        ),
    }


def _ratio(attended: int, total: int) -> float:
    return round(100.0 * attended / total, 1) if total else 0.0


# --- student ------------------------------------------------------------------------------
def student_summary(user) -> dict:
    policy_row = AttendancePolicy.current()
    rows = list(
        AttendanceRecord.objects.filter(user=user, finalized_at__isnull=False)
        .order_by("-class_start", "-id")
        .values_list("status", "course_id")
    )
    statuses = [status for status, _course in rows]
    attended = sum(1 for status in statuses if policy.counts_as_attended(status))
    total = sum(1 for status in statuses if policy.counts_in_total(status))
    current, best = policy.streaks(statuses)
    per_course: dict[int | None, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for status, course_id in rows:
        per_course[course_id][status] += 1
    courses = _course_map(per_course.keys())
    breakdown = []
    for course_id, counts in per_course.items():
        course_total = counts[policy.PRESENT] + counts[policy.PARTIAL] + counts[policy.ABSENT]
        breakdown.append(
            {
                "course": courses.get(course_id) or {"id": course_id, "title": "Other classes", "batch": ""},
                "attended": counts[policy.PRESENT],
                "total": course_total,
                "partial": counts[policy.PARTIAL],
                "absent": counts[policy.ABSENT],
                "excused": counts[policy.EXCUSED],
                "percent": _ratio(counts[policy.PRESENT], course_total),
            }
        )
    breakdown.sort(key=lambda item: (str(item["course"]["title"]).lower(), item["course"]["id"] or 0))
    percent = _ratio(attended, total)
    return {
        "rule": rule_payload(policy_row),
        "attended": attended,
        "total": total,
        "partial": statuses.count(policy.PARTIAL),
        "absent": statuses.count(policy.ABSENT),
        "excused": statuses.count(policy.EXCUSED),
        "percent": percent,
        "low_attendance": bool(total and percent < policy_row.low_attendance_percent),
        "streak": {"current": current, "best": best},
        "courses": breakdown,
    }


def _summary_map(session_ids) -> dict[int, SessionAttendance]:
    return {row.session_ref_id: row for row in SessionAttendance.objects.filter(session_ref_id__in=session_ids)}


def student_classes(user, *, course_id=None, status=None, page=1, page_size=25) -> dict:
    queryset = AttendanceRecord.objects.filter(user=user, finalized_at__isnull=False)
    if course_id:
        queryset = queryset.filter(course_id=course_id)
    if status in AttendanceRecord.STATUSES:
        queryset = queryset.filter(status=status)
    total = queryset.count()
    page_size = max(1, min(MAX_PAGE_SIZE, int(page_size or 25)))
    page = max(1, int(page or 1))
    rows = list(queryset.order_by("-class_start", "-id")[(page - 1) * page_size : page * page_size])
    session_ids = [row.session_ref_id for row in rows]
    summaries = _summary_map(session_ids)
    courses = _course_map(row.course_id for row in rows)
    recordings = recording_links(session_ids)
    results = []
    for row in rows:
        summary = summaries.get(row.session_ref_id)
        results.append(
            {
                "id": row.pk,
                "session_id": row.session_ref_id,
                "date": ist_date(row.class_start),
                "starts_at": iso(row.class_start),
                "title": row.title,
                "course": courses.get(row.course_id),
                "status": row.status,
                "minutes_present": row.minutes_present,
                "on_air_minutes": int(row.on_air_seconds or 0) // 60,
                "percent": float(row.percent or 0),
                "short_session": bool(summary and summary.short_session),
                "excused_reason": row.override_reason if row.status == policy.EXCUSED else "",
                "recording": recordings.get(row.session_ref_id),
            }
        )
    return {
        "results": results,
        "pagination": {
            "page": page,
            "page_size": page_size,
            "count": total,
            "pages": max(1, (total + page_size - 1) // page_size),
        },
    }


# --- staff --------------------------------------------------------------------------------
def _scoped(queryset, scope, field="course_id"):
    if scope is access.ALL:
        return queryset
    return queryset.filter(**{f"{field}__in": sorted(scope)})


def _parse_day(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)).date()
    except ValueError:
        return None


def _day_bounds(day_from, day_to):
    start = datetime.combine(day_from, datetime.min.time(), tzinfo=IST) if day_from else None
    end = datetime.combine(day_to, datetime.max.time(), tzinfo=IST) if day_to else None
    return start, end


def staff_sessions(scope, *, course_id=None, day_from=None, day_to=None, short_only=False, page=1, page_size=25) -> dict:
    from apps.realtime.models import RealtimeSession

    if course_id:
        access.require_course_in_scope(scope, course_id)
    queryset = _scoped(SessionAttendance.objects.filter(finalized_at__isnull=False), scope)
    if course_id:
        queryset = queryset.filter(course_id=course_id)
    start, end = _day_bounds(_parse_day(day_from), _parse_day(day_to))
    if start:
        queryset = queryset.filter(class_start__gte=start)
    if end:
        queryset = queryset.filter(class_start__lte=end)
    if short_only:
        queryset = queryset.filter(short_session=True)
    total = queryset.count()
    page_size = max(1, min(MAX_PAGE_SIZE, int(page_size or 25)))
    page = max(1, int(page or 1))
    rows = list(queryset.order_by("-class_start", "-id")[(page - 1) * page_size : page * page_size])
    courses = _course_map([row.course_id for row in rows])

    live_queryset = RealtimeSession.objects.filter(status=RealtimeSession.STATUS_LIVE).select_related("linked_live_class")
    if scope is not access.ALL:
        live_queryset = live_queryset.filter(
            Q(linked_course_id__in=sorted(scope)) | Q(linked_live_class__linked_course_id__in=sorted(scope))
        )
    if course_id:
        live_queryset = live_queryset.filter(
            Q(linked_course_id=course_id) | Q(linked_live_class__linked_course_id=course_id)
        )
    live_sessions = list(live_queryset.order_by("-started_at")[:20])
    live_courses = _course_map(access.session_course_id(session) for session in live_sessions)
    return {
        "live": [
            {
                "session_id": session.pk,
                "title": session.title,
                "course": live_courses.get(access.session_course_id(session)),
                "started_at": iso(session.started_at),
                "status": "live",
            }
            for session in live_sessions
        ],
        "results": [
            {
                "session_id": row.session_ref_id,
                "title": row.title,
                "course": courses.get(row.course_id),
                "date": ist_date(row.class_start),
                "starts_at": iso(row.class_start),
                "on_air_minutes": int(row.on_air_seconds or 0) // 60,
                "threshold_minutes": int(row.threshold_seconds or 0) // 60,
                "short_session": row.short_session,
                "counts": {
                    "roster": row.roster_count,
                    "present": row.present_count,
                    "partial": row.partial_count,
                    "absent": row.absent_count,
                    "excused": row.excused_count,
                },
                "attendance_percent": _ratio(row.present_count, row.roster_count - row.excused_count),
                "finalized_at": iso(row.finalized_at),
                "status": "ended",
            }
            for row in rows
        ],
        "pagination": {
            "page": page,
            "page_size": page_size,
            "count": total,
            "pages": max(1, (total + page_size - 1) // page_size),
        },
    }


def session_roster(session_id, scope) -> dict:
    from apps.realtime.models import RealtimeSession

    session = RealtimeSession.objects.select_related("linked_live_class", "linked_course").filter(pk=session_id).first()
    summary = SessionAttendance.objects.filter(session_ref_id=session_id).first()
    if session is None and summary is None:
        raise NotFound("Class not found.", code="attendance_session_not_found")
    course_id = access.session_course_id(session) if session is not None else summary.course_id
    access.require_course_in_scope(scope, course_id)
    records = {row.user_id: row for row in AttendanceRecord.objects.filter(session_ref_id=session_id)}
    is_live = bool(session is not None and session.status == RealtimeSession.STATUS_LIVE)
    rule = policy.Rule.from_policy(AttendancePolicy.current())
    user_ids = set(records)
    pending, last_seen = {}, {}
    if is_live:
        managers = access.session_managers(session, session.linked_course)
        user_ids.update(
            access.roster_user_ids(
                course_id=course_id, live_class_id=session.linked_live_class_id, exclude_ids=managers
            )
        )
        pending = {
            user_id: values
            for (pending_session, user_id), values in buffer.pending_snapshot().items()
            if pending_session == int(session_id)
        }
        user_ids.update(pending)
        last_seen = buffer.last_seen_many(int(session_id), user_ids)
    users = _user_map(user_ids)
    now_ts = time.time()
    rows = []
    for user_id in user_ids:
        record = records.get(user_id)
        seconds = int(getattr(record, "seconds_present", 0) or 0) + int((pending.get(user_id) or {}).get("sec", 0) or 0)
        joined = bool((record and record.first_joined_at) or user_id in pending or user_id in last_seen)
        if record is not None and record.finalized_at:
            status = record.status
        elif record is not None and record.manual_override:
            status = record.status
        elif is_live:
            if not joined:
                status = NOT_JOINED
            else:
                status = policy.PRESENT if seconds >= rule.present_min_seconds else policy.PARTIAL
        else:
            status = record.status if record else NOT_JOINED
        seen = last_seen.get(user_id)
        first_pending = (pending.get(user_id) or {}).get("first")
        first_joined = getattr(record, "first_joined_at", None)
        if first_joined is None and first_pending:
            first_joined = datetime.fromtimestamp(first_pending, tz=IST)
        rows.append(
            {
                "user": users.get(user_id) or {"id": user_id, "name": f"User {user_id}", "email": ""},
                "record_id": getattr(record, "pk", None),
                "status": status,
                "seconds_present": seconds,
                "minutes_present": seconds // 60,
                "percent": float(getattr(record, "percent", 0) or 0),
                "first_joined_at": iso(first_joined),
                "last_seen_at": iso(datetime.fromtimestamp(seen, tz=IST)) if seen else iso(getattr(record, "last_seen_at", None)),
                "online": bool(is_live and seen and now_ts - seen <= conf.online_window_seconds()),
                "manual_override": bool(record and record.manual_override),
                "override_reason": getattr(record, "override_reason", "") if record and record.manual_override else "",
            }
        )
    rows.sort(key=lambda row: (str(row["user"]["name"]).lower(), row["user"]["id"]))
    course = _course_map([course_id]).get(course_id)
    return {
        "session": {
            "id": int(session_id),
            "title": session.title if session is not None else summary.title,
            "course": course,
            "status": session.status if session is not None else "ended",
            "started_at": iso(session.started_at) if session is not None else iso(summary.class_start),
            "ended_at": iso(session.ended_at) if session is not None else None,
        },
        "live": is_live,
        "summary": None
        if summary is None
        else {
            "on_air_minutes": summary.on_air_seconds // 60,
            "threshold_minutes": summary.threshold_seconds // 60,
            "short_session": summary.short_session,
            "finalized_at": iso(summary.finalized_at),
            "counts": {
                "roster": summary.roster_count,
                "present": summary.present_count,
                "partial": summary.partial_count,
                "absent": summary.absent_count,
                "excused": summary.excused_count,
            },
        },
        "rule": rule_payload(),
        "rows": rows,
    }


def batch_matrix(scope, *, course_id, day_from=None, day_to=None) -> dict:
    access.require_course_in_scope(scope, course_id)
    course = _course_map([course_id]).get(int(course_id))
    if course is None:
        raise NotFound("Batch not found.", code="attendance_course_not_found")
    sessions_qs = SessionAttendance.objects.filter(course_id=course_id, finalized_at__isnull=False)
    start, end = _day_bounds(_parse_day(day_from), _parse_day(day_to))
    if start:
        sessions_qs = sessions_qs.filter(class_start__gte=start)
    if end:
        sessions_qs = sessions_qs.filter(class_start__lte=end)
    sessions = list(sessions_qs.order_by("-class_start", "-id")[:MAX_MATRIX_SESSIONS])
    sessions.reverse()
    session_ids = [row.session_ref_id for row in sessions]
    cells: dict[int, dict[int, str]] = defaultdict(dict)
    for user_id, session_ref_id, status in AttendanceRecord.objects.filter(session_ref_id__in=session_ids).values_list(
        "user_id", "session_ref_id", "status"
    ):
        cells[user_id][session_ref_id] = status
    student_ids = set(cells) | set(access.roster_user_ids(course_id=course_id))
    users = _user_map(student_ids)
    students = []
    for user_id in student_ids:
        row_cells = [cells[user_id].get(session_id) for session_id in session_ids]
        attended = sum(1 for status in row_cells if status == policy.PRESENT)
        total = sum(1 for status in row_cells if status and policy.counts_in_total(status))
        students.append(
            {
                "user": users.get(user_id) or {"id": user_id, "name": f"User {user_id}", "email": ""},
                "cells": row_cells,
                "attended": attended,
                "total": total,
                "percent": _ratio(attended, total),
            }
        )
    students.sort(key=lambda row: (str(row["user"]["name"]).lower(), row["user"]["id"]))
    return {
        "course": course,
        "sessions": [
            {
                "session_id": row.session_ref_id,
                "date": ist_date(row.class_start),
                "title": row.title,
                "short_session": row.short_session,
            }
            for row in sessions
        ],
        "students": students,
        "truncated": sessions_qs.count() > MAX_MATRIX_SESSIONS,
        "rule": rule_payload(),
    }


def low_attendance(scope, *, course_id=None, threshold=None, min_classes: int = 1) -> dict:
    policy_row = AttendancePolicy.current()
    threshold = int(threshold if threshold is not None else policy_row.low_attendance_percent)
    if course_id:
        access.require_course_in_scope(scope, course_id)
    queryset = _scoped(AttendanceRecord.objects.filter(finalized_at__isnull=False, course_id__isnull=False), scope)
    if course_id:
        queryset = queryset.filter(course_id=course_id)
    aggregates = list(
        queryset.exclude(status=policy.EXCUSED)
        .values("user_id", "course_id")
        .annotate(
            total=Count("id"),
            attended=Count("id", filter=Q(status=policy.PRESENT)),
            absent=Count("id", filter=Q(status=policy.ABSENT)),
            last_class=Max("class_start"),
        )
    )
    flagged = [
        row
        for row in aggregates
        if row["total"] >= max(1, int(min_classes)) and _ratio(row["attended"], row["total"]) < threshold
    ]
    users = _user_map(row["user_id"] for row in flagged)
    courses = _course_map(row["course_id"] for row in flagged)
    results = [
        {
            "user": users.get(row["user_id"]) or {"id": row["user_id"], "name": f"User {row['user_id']}", "email": ""},
            "course": courses.get(row["course_id"]),
            "attended": row["attended"],
            "total": row["total"],
            "absent": row["absent"],
            "percent": _ratio(row["attended"], row["total"]),
            "last_class": ist_date(row["last_class"]),
        }
        for row in flagged
    ]
    results.sort(key=lambda row: (row["percent"], str(row["user"]["name"]).lower()))
    return {"threshold": threshold, "results": results}


# --- CSV ------------------------------------------------------------------------------------------
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _cell(value) -> str:
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(_FORMULA_PREFIXES) else text


def to_csv(header: list[str], rows) -> str:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow([_cell(item) for item in header])
    for row in rows:
        writer.writerow([_cell(item) for item in row])
    return out.getvalue()


def _identity_cells(rows, course_id=None) -> list[list]:
    """Owner rule: roll number, real name, handle, stats lead every attendance export row."""
    from apps.users import identity

    users = [{"id": row["user"]["id"]} for row in rows]
    return [identity.identity_cells(block) for block in identity.identity_blocks([(user, None) for user in users], course_id=course_id)]


def _course_id(data: dict):
    course = data.get("course")
    return course.get("id") if isinstance(course, dict) else None


def roster_csv(data: dict) -> str:
    from apps.users.identity import IDENTITY_HEADER

    who = _identity_cells(data["rows"])
    return to_csv(
        [*IDENTITY_HEADER, "Email", "Status", "Minutes present", "Percent of live time", "First joined", "Last seen", "Override reason"],
        (
            [
                *ident,
                row["user"]["email"],
                row["status"],
                row["minutes_present"],
                row["percent"],
                row["first_joined_at"] or "",
                row["last_seen_at"] or "",
                row["override_reason"],
            ]
            for row, ident in zip(data["rows"], who, strict=True)
        ),
    )


def matrix_csv(data: dict) -> str:
    from apps.users.identity import IDENTITY_HEADER

    who = _identity_cells(data["students"], _course_id(data))
    header = [*IDENTITY_HEADER, "Email"] + [f"{item['date']} {item['title']}" for item in data["sessions"]] + [
        "Attended",
        "Total",
        "Percent",
    ]
    return to_csv(
        header,
        (
            [*ident, row["user"]["email"], *[cell or "" for cell in row["cells"]], row["attended"], row["total"], row["percent"]]
            for row, ident in zip(data["students"], who, strict=True)
        ),
    )


def low_attendance_csv(data: dict) -> str:
    from apps.users.identity import IDENTITY_HEADER

    who = _identity_cells(data["results"])
    return to_csv(
        [*IDENTITY_HEADER, "Email", "Batch", "Attended", "Total", "Absent", "Percent", "Last class"],
        (
            [
                *ident,
                row["user"]["email"],
                (row["course"] or {}).get("title", ""),
                row["attended"],
                row["total"],
                row["absent"],
                row["percent"],
                row["last_class"] or "",
            ]
            for row, ident in zip(data["results"], who, strict=True)
        ),
    )
