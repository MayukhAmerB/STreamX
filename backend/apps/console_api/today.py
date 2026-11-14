"""Console Home data: ``GET /api/console/today/`` (plan §3.4/§3.5, Appendix A.2).

OWNER: WS-C. One request answers "what should I do next" for the Learn
workspace and "what needs me as a teacher" for the Teach workspace, replacing
the 4-5 calls the old hub made. Every list is scoped to what the viewer can
already open elsewhere (the same access helpers the source endpoints use), so
this view never reveals a course, class, exam or report the viewer could not
reach directly.

Learn: ``next_up`` follows a fixed priority (the first that applies wins; the
rest become ``also`` rows, at most three):

1. ``live_now``    a class the viewer can join is live      -> "Join live"
2. ``exam_open``   an exam of their batch is open, not done -> "Start" (labs)
3. ``report_due``  a report is due within 72 hours          -> "Submit report"
4. ``resume``      an enrolled course with lessons left     -> "Resume"/"Start"
5. ``next_class``  ONLY with live-class access (approved live-class enrolment
                   or an active enrolment in its course)    -> countdown
6. ``browse``      no course at all                          -> "Browse courses"

Query budget (plan §7.5): at most 12 SQL queries for either workspace
(``tests/test_console_today.py`` measures it).
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db.models import Count, Exists, Min, OuterRef, Q
from django.utils import timezone

from apps.core import features
from apps.core.errors import PermissionDenied

from .permissions import is_staff_user

WORKSPACES = ("learn", "teach")
NEXT_UP_KINDS = ("live_now", "exam_open", "report_due", "resume", "next_class", "browse")

REPORT_DUE_NEXT_UP = timedelta(hours=72)  # a report due sooner than this is "Next up"
REPORT_DUE_ALSO = timedelta(days=7)  # ... and shows as an "Also this week" row until then
MAX_ALSO = 3
MAX_COURSES = 3
DISPLAY_TZ = ZoneInfo("Asia/Kolkata")

# Same artwork the frontend falls back to (utils/courseArtwork.js).
CATEGORY_ARTWORK = {
    "osint": "/course-art/osint-program-v2.webp",
    "web_pentesting": "/course-art/pentesting-program-v2.webp",
}

NOT_A_TEACHER = "Only teachers can open this page."


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _iso(value):
    return value.isoformat() if value else None


def _local(value):
    return timezone.localtime(value, DISPLAY_TZ)


def _clock(value) -> str:
    """"7:02 pm"."""
    local = _local(value)
    hour = local.hour % 12 or 12
    return f"{hour}:{local.minute:02d} {'am' if local.hour < 12 else 'pm'}"


def _day_time(value, now) -> str:
    """"Today 7:00 pm", "Tomorrow 7:00 pm" or "Fri 20 Nov, 7:00 pm" (IST)."""
    local, today = _local(value), _local(now).date()
    if local.date() == today:
        day = "Today"
    elif local.date() == today + timedelta(days=1):
        day = "Tomorrow"
    else:
        return f"{local.strftime('%a')} {local.day} {local.strftime('%b')}, {_clock(value)}"
    return f"{day} {_clock(value)}"


def _artwork(course, request=None):
    if course is None:
        return None
    try:
        url = course.get_thumbnail_url(request=request)
    except Exception:  # storage hiccup: fall back to the category art
        url = ""
    return url or CATEGORY_ARTWORK.get(str(course.category or "").lower()) or None


def _item(kind, title, subtitle, label, href, *, image=None, progress=None, starts_at=None, due_at=None):
    return {
        "kind": kind,
        "title": title,
        "subtitle": subtitle,
        "action": {"label": label, "href": href},
        "image": image,
        "progress": progress,
        "starts_at": _iso(starts_at),
        "due_at": _iso(due_at),
    }


def _also_row(entry) -> dict:
    """A Next-up candidate as an "Also this week" row (icon from ``kind``)."""
    label = entry["title"]
    if entry["kind"] == "resume":
        label = f"{entry['action']['label']} {entry['title']}"
    return {
        "kind": entry["kind"],
        "label": label,
        "due_at": entry["due_at"] or entry["starts_at"],
        "href": entry["action"]["href"],
    }


# ---------------------------------------------------------------------------
# Learn workspace
# ---------------------------------------------------------------------------
def _active_enrollments(user):
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment

    return list(
        Enrollment.objects.filter(user_id=user.pk)
        .filter(active_enrollment_q())
        .order_by("-enrolled_at", "-id")
        .values_list("course_id", flat=True)
    )


def _courses_with_progress(user, course_ids):
    from apps.courses.models import Course

    if not course_ids:
        return {}
    published = Q(sections__lectures__is_published=True)
    mine = Q(sections__lectures__progress_entries__user=user)
    rows = (
        Course.objects.filter(pk__in=course_ids)
        .select_related("report_policy")
        .annotate(
            lecture_count=Count("sections__lectures", filter=published, distinct=True),
            completed_lecture_count=Count(
                "sections__lectures__progress_entries",
                filter=published & mine & Q(sections__lectures__progress_entries__completed=True),
                distinct=True,
            ),
        )
    )
    return {course.pk: course for course in rows}


def _progress(course) -> float:
    total = int(getattr(course, "lecture_count", 0) or 0)
    if not total:
        return 0.0
    return round(min(1.0, int(course.completed_lecture_count or 0) / total), 4)


def _last_progress(user, course_ids):
    from apps.courses.models import LectureProgress

    if not course_ids:
        return None
    return (
        LectureProgress.objects.filter(
            user_id=user.pk, lecture__is_published=True, lecture__section__course_id__in=course_ids
        )
        .select_related("lecture", "lecture__section")
        .order_by("-updated_at", "-id")
        .first()
    )


def _live_class_ids(user):
    from apps.courses.access import accessible_live_class_ids_for_user

    return list(accessible_live_class_ids_for_user(user))


def _live_now(user, course_ids, live_class_ids, now, request):
    """The class the viewer can join right now (same rules as the session list + join)."""
    from apps.realtime.models import RealtimeSession
    from apps.realtime.schedule import attendee_join_max_live_hours

    queryset = RealtimeSession.objects.filter(status=RealtimeSession.STATUS_LIVE).select_related("linked_course")
    if not is_staff_user(user):
        queryset = queryset.filter(
            Q(host_id=user.pk)
            | Q(linked_course__instructor_id=user.pk)
            | Q(linked_course_id__in=course_ids)
            | Q(linked_live_class_id__in=live_class_ids)
            | Q(linked_course__isnull=True, linked_live_class__isnull=True)
        )
    # A broadcast is joinable while its feed is live or briefly reconnecting.
    queryset = queryset.filter(
        ~Q(session_type=RealtimeSession.TYPE_BROADCASTING)
        | Q(stream_status__in=[RealtimeSession.STREAM_LIVE, RealtimeSession.STREAM_INTERRUPTED])
    )
    max_hours = attendee_join_max_live_hours()
    if max_hours > 0:  # abandoned sessions (host never ended them) do not count
        queryset = queryset.filter(
            Q(host_id=user.pk) | Q(started_at__isnull=True) | Q(started_at__gte=now - timedelta(hours=max_hours))
        )
    session = queryset.order_by("-started_at", "-id").first()
    if session is None:
        return None
    started = f"Started {_clock(session.started_at)}" if session.started_at else "Live now"
    if session.stream_status == "interrupted":
        started = "Host reconnecting"
    return _item(
        "live_now",
        session.title or "Live class",
        started,
        "Join live",
        f"/join-live?session={session.pk}",
        image=_artwork(session.linked_course, request),
        starts_at=session.started_at,
    )


def _exam_open(user, course_ids, now, image=None):
    """An open exam of the viewer's batch that they have not finished."""
    from apps.ctf.eligibility import open_exam_filter
    from apps.ctf.models import CtfExam, CtfParticipation

    if not course_ids:
        return None
    finished = CtfParticipation.objects.filter(
        exam_id=OuterRef("pk"),
        user_id=user.pk,
        status__in=[CtfParticipation.STATUS_SUBMITTED, CtfParticipation.STATUS_EXPIRED],
    )
    exam = (
        CtfExam.objects.filter(open_exam_filter(now), eligible_courses__in=course_ids)
        .exclude(Exists(finished))
        .order_by("closes_at", "id")
        .distinct()
        .first()
    )
    if exam is None:
        return None
    subtitle = f"Closes {_day_time(exam.closes_at, now)}" if exam.closes_at else "Open now"
    href = str(getattr(settings, "CTF_LABS_EXAM_URL", "") or "/coursework/exams")
    return _item("exam_open", exam.title, subtitle, "Start exam", href, due_at=exam.closes_at, image=image)


def _report_candidates(user, courses, course_ids, now, art=None):
    """Reports due within a week: instructor tasks and self-service weeks."""
    from apps.reports.models import ReportSubmission, ReportTask
    from apps.reports.weekly import anchor_for, is_self_service
    from apps.reports.weeks import week_for

    if not course_ids:
        return []
    found = []

    # Instructor-created tasks (legacy flow): open, due within a week, not handed in.
    tasks = list(
        ReportTask.objects.filter(
            course_id__in=course_ids,
            status=ReportTask.STATUS_PUBLISHED,
            due_at__gt=now,
            due_at__lte=now + REPORT_DUE_ALSO,
        )
        .exclude(origin=ReportTask.ORIGIN_AUTO)
        .filter(Q(opens_at__isnull=True) | Q(opens_at__lte=now))
        .order_by("due_at", "id")[:10]
    )
    if tasks:
        handed_in = set(
            ReportSubmission.objects.filter(student_id=user.pk, task__in=tasks)
            .exclude(status__in=[ReportSubmission.STATUS_NOT_SUBMITTED, ReportSubmission.STATUS_RETURNED])
            .values_list("task_id", flat=True)
        )
        for task in tasks:
            if task.pk not in handed_in:
                found.append((task.due_at, task.title, f"/reports/tasks/{task.pk}", task.course_id))

    # Self-service courses: the current week is due at its deadline unless a report went in.
    weeks = {}
    for course in courses:
        enabled, policy = is_self_service(course)
        if not enabled:
            continue
        week = week_for(policy, now, anchor=anchor_for(course))
        if week.status_at(now) == "open" and week.due_at - now <= REPORT_DUE_ALSO:
            weeks[course.pk] = week
    if weeks:
        done = set(
            ReportSubmission.objects.filter(
                student_id=user.pk,
                task__origin=ReportTask.ORIGIN_AUTO,
                task__course_id__in=list(weeks),
                task__week_start__in={week.week_start for week in weeks.values()},
            )
            .exclude(status=ReportSubmission.STATUS_NOT_SUBMITTED)
            .values_list("task__course_id", "task__week_start")
        )
        for course_id, week in weeks.items():
            if (course_id, week.week_start) not in done:
                found.append((week.due_at, week.label(), "/reports", course_id))

    found.sort(key=lambda row: row[0])
    return [
        _item(
            "report_due",
            title,
            f"Due {_day_time(due_at, now)}",
            "Submit report",
            href,
            due_at=due_at,
            image=(art or {}).get(course_id),
        )
        for due_at, title, href, course_id in found
    ]


def _resume(courses_by_id, ordered_ids, last, request):
    """The course to continue: the last one opened with lessons left, else the newest unfinished."""
    candidates = [courses_by_id[pk] for pk in ordered_ids if pk in courses_by_id]
    if not candidates:
        return None
    last_course_id = last.lecture.section.course_id if last else None
    unfinished = [course for course in candidates if _progress(course) < 1.0]
    course = next((item for item in unfinished if item.pk == last_course_id), None) or (
        unfinished[0] if unfinished else candidates[0]
    )
    progress = _progress(course)
    started = progress > 0 or (last is not None and last_course_id == course.pk)
    lesson = last.lecture.title if (last is not None and last_course_id == course.pk) else ""
    if progress >= 1.0:
        label, subtitle = "Review", "Course complete"
    elif started:
        label, subtitle = "Resume", (f"Last: {lesson}" if lesson else f"{round(progress * 100)}% complete")
    else:
        label, subtitle = "Start", "Not started yet"
    return _item(
        "resume",
        course.title,
        subtitle,
        label,
        f"/learn/{course.pk}",
        image=_artwork(course, request),
        progress=progress,
    )


def _next_class(live_class_ids, now, image=None):
    """Next weekly class window, only for viewers with live-class access."""
    from apps.realtime.schedule import get_live_class_schedule_snapshot

    if not live_class_ids:
        return None
    snapshot = get_live_class_schedule_snapshot(now)
    if not snapshot.get("next_start"):
        return None
    starts_at = datetime.fromisoformat(snapshot["next_start"])
    return _item(
        "next_class",
        "Next live class",
        _day_time(starts_at, now),
        "Live classes",
        "/join-live",
        starts_at=starts_at,
        image=image,
    )


def _browse():
    return _item(
        "browse",
        "You're not enrolled yet",
        "Pick a course to start learning.",
        "Browse courses",
        "/courses",
        image=CATEGORY_ARTWORK["osint"],
    )


def build_learn(user, *, now=None, request=None) -> dict:
    now = now or timezone.now()
    course_ids = _active_enrollments(user)
    courses_by_id = _courses_with_progress(user, course_ids)
    last = _last_progress(user, course_ids)
    live_class_ids = _live_class_ids(user)

    # Course art for cards that have no picture of their own (newest course first).
    art = {pk: _artwork(course, request) for pk, course in courses_by_id.items()}
    main_art = next((art[pk] for pk in course_ids if art.get(pk)), None)

    candidates = []
    for entry in (
        _live_now(user, course_ids, live_class_ids, now, request),
        _exam_open(user, course_ids, now, image=main_art),
    ):
        if entry:
            candidates.append(entry)
    reports = _report_candidates(user, list(courses_by_id.values()), course_ids, now, art=art)
    urgent = [entry for entry in reports if _parse(entry["due_at"]) - now <= REPORT_DUE_NEXT_UP]
    candidates.extend(urgent)
    resume = _resume(courses_by_id, course_ids, last, request)
    if resume:
        candidates.append(resume)
    upcoming = _next_class(live_class_ids, now, image=main_art)
    if upcoming:
        candidates.append(upcoming)
    # Reports due later this week never outrank the course to continue.
    candidates.extend(entry for entry in reports if entry not in urgent)

    next_up = candidates[0] if candidates else _browse()
    also = [_also_row(entry) for entry in candidates[1 : 1 + MAX_ALSO]]
    courses = [
        {
            "id": course.pk,
            "title": course.title,
            "progress": _progress(course),
            "href": f"/learn/{course.pk}",
            "image": art.get(course.pk),
        }
        for course in (courses_by_id[pk] for pk in course_ids if pk in courses_by_id)
    ][:MAX_COURSES]
    return {"workspace": "learn", "next_up": next_up, "also": also, "courses": courses, "teach": None}


def _parse(value):
    return datetime.fromisoformat(value) if isinstance(value, str) else value


# ---------------------------------------------------------------------------
# Teach workspace
# ---------------------------------------------------------------------------
def require_teacher(user) -> None:
    """Staff always; non-staff instructors only while ``teaching`` is on."""
    if is_staff_user(user):
        return
    if str(getattr(user, "role", "")).strip().lower() != "instructor":
        raise PermissionDenied(NOT_A_TEACHER, code="not_a_teacher")
    features.require("teaching")


def _to_grade(user, root):
    from apps.reports.access import gradable_courses
    from apps.reports.models import ReportSubmission

    stats = ReportSubmission.objects.filter(
        task__course__in=gradable_courses(user), status__in=ReportSubmission.AWAITING_GRADING
    ).aggregate(count=Count("id"), oldest=Min("submitted_at"))
    return {"count": int(stats["count"] or 0), "oldest_at": _iso(stats["oldest"]), "href": f"{root}/grading"}


def _host_next(user, root, now):
    """The viewer's next class to host: a live one first, else a scheduled one."""
    from apps.realtime.models import RealtimeSession
    from apps.realtime.schedule import get_live_class_schedule_snapshot

    mine = Q(host_id=user.pk) | Q(linked_course__instructor_id=user.pk)
    session = (
        RealtimeSession.objects.filter(mine, status__in=[RealtimeSession.STATUS_LIVE, RealtimeSession.STATUS_SCHEDULED])
        .order_by("status", "-started_at", "-id")  # "live" sorts before "scheduled"
        .only("id", "status", "started_at")
        .first()
    )
    if session is None:
        return {"session_id": None, "starts_at": None, "href": f"{root}/classes"}
    if session.status == RealtimeSession.STATUS_LIVE:
        starts_at = _iso(session.started_at)
    else:
        starts_at = get_live_class_schedule_snapshot(now).get("next_start")
    return {"session_id": session.pk, "starts_at": starts_at, "href": f"{root}/classes/{session.pk}/studio"}


def _recordings(user, root, staff):
    from apps.realtime.recording.models import ClassRecording

    scope = ClassRecording.objects.all()
    if not staff:
        scope = scope.filter(Q(session__host_id=user.pk) | Q(module__course__instructor_id=user.pk))
    stats = scope.aggregate(
        processing=Count(
            "id", filter=Q(state__in=[ClassRecording.STATE_FINALIZING, ClassRecording.STATE_PROCESSING])
        ),
        to_publish=Count(
            "id",
            filter=(Q(hold_unpublished=True) | Q(needs_review=True))
            & ~Q(state__in=[ClassRecording.STATE_PUBLISHED, ClassRecording.STATE_FAILED]),
        ),
    )
    href = "/console/admin/recordings" if staff else f"{root}/recordings"
    return {"processing": int(stats["processing"] or 0), "to_publish": int(stats["to_publish"] or 0), "href": href}


def _exams_open(user, root, staff, now):
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment
    from apps.ctf.eligibility import open_exam_filter
    from apps.ctf.models import CtfExam, CtfParticipation

    exams = CtfExam.objects.filter(open_exam_filter(now))
    if not staff:
        exams = exams.filter(eligible_courses__instructor_id=user.pk)
    rows = list(exams.distinct().values_list("id", "slug"))
    if not rows:
        return {"count": 0, "submitted": 0, "eligible": 0, "href": f"{root}/exams"}
    exam_ids = [exam_id for exam_id, _slug in rows]
    submitted = (
        CtfParticipation.objects.filter(
            exam_id__in=exam_ids, status=CtfParticipation.STATUS_SUBMITTED, is_staff_preview=False
        )
        .values("user_id", "exam_id")
        .distinct()
        .count()
    )
    eligible = (
        Enrollment.objects.filter(course__ctf_exams__in=exam_ids)
        .filter(active_enrollment_q())
        .values("user_id", "course__ctf_exams")
        .distinct()
        .count()
    )
    href = f"{root}/exams/{rows[0][1]}" if len(rows) == 1 else f"{root}/exams"
    return {"count": len(rows), "submitted": submitted, "eligible": eligible, "href": href}


def build_teach(user, *, now=None) -> dict:
    require_teacher(user)
    now = now or timezone.now()
    staff = is_staff_user(user)
    root = "/console/admin" if staff else "/console/teach"
    return {
        "workspace": "teach",
        "next_up": None,
        "also": [],
        "courses": [],
        "teach": {
            "to_grade": _to_grade(user, root),
            "host_next": _host_next(user, root, now),
            "recordings": _recordings(user, root, staff),
            "exams_open": _exams_open(user, root, staff, now),
        },
    }


def build_today(user, workspace: str = "learn", *, now=None, request=None) -> dict:
    if workspace == "teach":
        return build_teach(user, now=now)
    return build_learn(user, now=now, request=request)
