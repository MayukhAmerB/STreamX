"""Self-service weekly reports: the student names a target, the week is automatic.

Nobody creates or publishes a task each week. A course's ``ReportPolicy``
(``self_service=True``) defines the deadline (default Sunday 23:59 IST), the
late window (48 h at -10 % per started day), marks and file rules. The week's
``ReportTask`` (``origin="auto"``) is created on first use, race-free thanks to
the partial unique constraint ``(course, week_start) WHERE origin='auto'``.

A student's report for one target is a ``ReportSubmission`` keyed by
``(task, student, target_key)``; ``target_key`` comes from
``apps.core.textnorm.target_key``, so "Acme Pvt Ltd" and "acme" are the same
target (409 ``duplicate_target`` with the existing report to open), and a
near-duplicate ("Acme Crop") needs an explicit "it is a different target"
confirmation, stored for the grader.

Files upload as soon as they are picked and are scanned asynchronously
(``scanning.py``); Submit is refused until every file is clean.
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from apps.core.errors import Conflict, NotFound, ValidationFailed
from apps.core.outbox import publish
from apps.core.textnorm import (
    NEAR_DUPLICATE_THRESHOLD,
    clean_display,
    near_duplicates,
    target_key,
    trigram_comparable,
)
from apps.courses.access import accessible_course_ids_for_user, user_has_course_access
from apps.courses.models import Course

from . import scanning, services
from .models import ReportFile, ReportPolicy, ReportSubmission, ReportTask
from .weeks import Week, selectable_weeks, week_for, week_starting

logger = logging.getLogger("apps.reports.weekly")

EVENT_RECEIPT = "reports.submission_receipt"
TARGET_MIN_LENGTH = 2
TARGET_MAX_LENGTH = 200
WEEK_CURRENT = "current"
WEEK_PREVIOUS = "previous"
DISABLED_REASON = "Reports are not enabled for this course."


def undo_seconds():
    return max(0, int(getattr(settings, "REPORTS_UNDO_SECONDS", 15)))


# ---------------------------------------------------------------------------
# Policy and weeks
# ---------------------------------------------------------------------------
def policy_for(course):
    try:
        return course.report_policy
    except ReportPolicy.DoesNotExist:
        return None


def is_self_service(course):
    policy = policy_for(course)
    return bool(policy and policy.self_service), policy


def anchor_for(course):
    return getattr(course, "start_date", None)


def week_task_defaults(course, policy, week: Week, now):
    title = f"{week.label()} reports"
    return {
        "title": title[:200],
        "brief": policy.brief,
        "opens_at": None,
        "due_at": week.due_at,
        "late_policy": ReportTask.LATE_ALLOWED if policy.grace_hours else ReportTask.LATE_NOT_ALLOWED,
        "late_until": week.late_until if policy.grace_hours else None,
        "late_penalty_percent_per_day": policy.late_penalty_percent_per_day,
        "max_marks": policy.max_marks,
        "allowed_file_types": list(policy.allowed_file_types or []),
        "max_files": policy.max_files,
        "max_file_size_mb": policy.max_file_size_mb,
        "max_total_size_mb": policy.max_total_size_mb,
        "marks_visibility": policy.task_marks_visibility,
        "week_number": week.number,
        "status": ReportTask.STATUS_PUBLISHED,
        "published_at": now,
    }


def ensure_week_task(course, policy, week: Week, *, now=None):
    """The automatic task for ``week`` (created on first use; safe under races)."""
    now = now or timezone.now()
    existing = ReportTask.objects.filter(
        course=course, origin=ReportTask.ORIGIN_AUTO, week_start=week.week_start
    ).first()
    if existing is not None:
        return existing
    try:
        with transaction.atomic():
            return ReportTask.objects.create(
                course=course,
                origin=ReportTask.ORIGIN_AUTO,
                week_start=week.week_start,
                **week_task_defaults(course, policy, week, now),
            )
    except IntegrityError:
        return ReportTask.objects.get(course=course, origin=ReportTask.ORIGIN_AUTO, week_start=week.week_start)


def week_of_task(task, policy):
    if task.week_start is None:
        return None
    return week_starting(policy, task.week_start, anchor=anchor_for(task.course))


# ---------------------------------------------------------------------------
# Course and target lookup
# ---------------------------------------------------------------------------
def student_course_or_404(user, course_id):
    course = Course.objects.filter(pk=course_id).select_related("report_policy").first()
    if course is None or not user_has_course_access(user, course.pk):
        raise NotFound("Course not found.", code="course_not_found")
    return course


def require_self_service(course):
    enabled, policy = is_self_service(course)
    if not enabled:
        raise Conflict(DISABLED_REASON, code="reports_disabled")
    return policy


def student_target_or_404(user, submission_id, *, for_update=False):
    queryset = ReportSubmission.objects.select_related("task", "task__course", "task__course__report_policy")
    if for_update:
        queryset = (
            queryset.select_for_update(of=("self",))
            if connection.features.has_select_for_update_of
            else (queryset.select_for_update())
        )
    submission = queryset.filter(
        pk=submission_id,
        student=user,
        task__origin=ReportTask.ORIGIN_AUTO,
        task__course_id__in=accessible_course_ids_for_user(user),
    ).first()
    if submission is None:
        raise NotFound("Report not found.", code="report_target_not_found")
    return submission


def clean_target_name(raw):
    name = clean_display(raw, max_length=TARGET_MAX_LENGTH)
    if len(name) < TARGET_MIN_LENGTH:
        message = "Type the name of the target you investigated (at least 2 characters)."
        raise ValidationFailed(message, details={"target_name": [message]}, code="validation_target_name")
    key = target_key(name)
    if not key:
        message = "Use letters or numbers in the target name."
        raise ValidationFailed(message, details={"target_name": [message]}, code="validation_target_name")
    return name, key


def target_ref(submission):
    return {
        "id": submission.pk,
        "target_name": submission.target_name,
        "status": submission.status,
        "week_start": submission.task.week_start.isoformat() if submission.task.week_start else None,
    }


# Whether pg_trgm is installed, re-checked every few minutes (an extension
# installed or dropped after start-up is picked up without a restart).
_PG_TRGM_PROBE_TTL_SECONDS = 300
_pg_trgm_probe = {"value": None, "at": 0.0}


def _pg_trgm_installed(alias="default"):
    if connection.vendor != "postgresql":
        return False
    now = time.monotonic()
    if _pg_trgm_probe["value"] is not None and now - _pg_trgm_probe["at"] < _PG_TRGM_PROBE_TTL_SECONDS:
        return _pg_trgm_probe["value"]
    try:
        # A savepoint: a failed probe must not abort the caller's transaction.
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")
            value = cursor.fetchone() is not None
    except Exception:  # noqa: BLE001 - no extension info: use the Python fallback
        value = False
    _pg_trgm_probe.update(value=value, at=now)
    return value



def similar_targets(key, rows):
    """Near-duplicates of ``key`` among ``rows`` (the student's targets that week).

    PostgreSQL with ``pg_trgm`` scores with ``similarity()`` in the database;
    everywhere else ``textnorm.trigram_similarity`` (same algorithm) does. The
    Python pass also catches one-typo variants and aliases across kinds
    ("acme" / "acme.com"), so both paths run on Postgres. Only plain names go
    to ``similarity()``: on a URL, e-mail or IP key the raw trigram score
    counts the shared host ("facebook.com/john" vs "facebook.com/jane"), which
    ``near_duplicates`` deliberately ignores.
    """
    found = {item.pk: (item, score) for item, score in near_duplicates(key, [(row, row.target_key) for row in rows])}
    if not trigram_comparable(key):
        return sorted(found.values(), key=lambda pair: -pair[1])
    ids = [row.pk for row in rows if row.target_key and row.target_key != key and trigram_comparable(row.target_key)]
    if ids and _pg_trgm_installed():
        try:
            # A savepoint: an error here (pg_trgm in another schema, statement
            # timeout) rolls back only this query, so the caller's transaction
            # (create_target) continues with the Python result.
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, similarity(target_key, %s) FROM reports_reportsubmission "
                    "WHERE id = ANY(%s) AND similarity(target_key, %s) >= %s",
                    [key, ids, key, NEAR_DUPLICATE_THRESHOLD],
                )
                by_id = {row.pk: row for row in rows}
                for pk, score in cursor.fetchall():
                    current = found.get(pk)
                    if current is None or float(score) > current[1]:
                        found[pk] = (by_id[pk], round(float(score), 3))
        except Exception:  # noqa: BLE001 - the Python result stands
            logger.warning("reports: pg_trgm similarity failed; using the Python fallback", exc_info=True)
    return sorted(found.values(), key=lambda pair: -pair[1])


# ---------------------------------------------------------------------------
# Creating a target (a draft report)
# ---------------------------------------------------------------------------
def resolve_week(course, policy, which, now) -> Week:
    choices = selectable_weeks(policy, now, anchor=anchor_for(course))
    which = str(which or WEEK_CURRENT).strip().lower()
    if which == WEEK_PREVIOUS:
        if choices["previous"] is None:
            raise Conflict("Last week's late window has closed, so it can't take new reports.", code="week_closed")
        return choices["previous"]
    if which != WEEK_CURRENT:
        message = "Choose this week or, during its late window, last week."
        raise ValidationFailed(message, details={"week": [message]}, code="validation_week")
    return choices["current"]


def _lock_student(student):
    # Serialises one student's target creation (slot limit, near-duplicate
    # check) without blocking anyone else.
    get_user_model().objects.select_for_update().filter(pk=student.pk).values_list("pk", flat=True).first()


def create_target(*, course, student, target_name, week=WEEK_CURRENT, confirm_different=False, now=None):
    """Create the student's draft report for a target this week (or last week
    during its late window). Returns the submission."""
    now = now or timezone.now()
    policy = require_self_service(course)
    name, key = clean_target_name(target_name)
    chosen = resolve_week(course, policy, week, now)
    with transaction.atomic():
        task = ensure_week_task(course, policy, chosen, now=now)
        _lock_student(student)
        rows = list(ReportSubmission.objects.filter(task=task, student=student).select_related("task").order_by("id"))
        existing = next((row for row in rows if row.target_key == key), None)
        if existing is not None:
            raise Conflict(
                f"You already have a report for “{existing.target_name}” this week. Open it to change it.",
                code="duplicate_target",
                details={"existing": target_ref(existing)},
            )
        limit = policy.max_targets_per_week
        if limit and len(rows) >= limit:
            raise Conflict(
                f"You can report on up to {limit} target{'s' if limit != 1 else ''} a week.",
                code="target_limit",
                details={"max_targets_per_week": limit},
            )
        similar = similar_targets(key, rows)
        if similar and not confirm_different:
            raise Conflict(
                "This looks like a target you already reported on this week. Open it, or confirm it is different.",
                code="similar_target",
                details={
                    "suggestions": [{**target_ref(row), "score": score} for row, score in similar[:5]],
                    "needs_confirmation": True,
                },
            )
        try:
            with transaction.atomic():
                return ReportSubmission.objects.create(
                    task=task,
                    student=student,
                    target_name=name,
                    target_key=key,
                    status=ReportSubmission.STATUS_NOT_SUBMITTED,
                    different_target_confirmed=bool(similar and confirm_different),
                    similar_targets=[row.target_name for row, _score in similar[:5]],
                )
        except IntegrityError:
            existing = ReportSubmission.objects.select_related("task").get(task=task, student=student, target_key=key)
            raise Conflict(
                f"You already have a report for “{existing.target_name}” this week. Open it to change it.",
                code="duplicate_target",
                details={"existing": target_ref(existing)},
            ) from None


def discard_draft(*, submission_id, student):
    with transaction.atomic():
        submission = student_target_or_404(student, submission_id, for_update=True)
        if submission.version_count:
            raise Conflict("A submitted report can't be deleted.", code="target_submitted")
        for item in ReportFile.objects.filter(draft=submission, submitted=False):
            services._delete_stored_file(item.file)
            item.delete()
        submission.delete()


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------
def draft_files(submission):
    return ReportFile.objects.filter(draft=submission, submitted=False).order_by("created_at", "id")


def upload_file(*, submission_id, student, uploaded, now=None):
    now = now or timezone.now()
    submission = student_target_or_404(student, submission_id)
    task = submission.task
    services._require_student_can_change(task, submission, now)
    services.prune_staged_files(owner=student)
    staged = list(draft_files(submission))
    if len(staged) >= task.max_files:
        message = f"You can attach up to {task.max_files} file{'s' if task.max_files != 1 else ''}. Remove one first."
        raise ValidationFailed(message, details={"file": [message]}, code="validation_too_many_files")
    fields = scanning.stage_pending(uploaded, allowed_extensions=task.allowed_extensions, max_bytes=task.max_file_bytes)
    try:
        if sum(item.size for item in staged) + fields["size"] > task.max_total_bytes:
            limit_mb = task.max_total_bytes // (1024 * 1024)
            message = f"Together your files would be larger than the {limit_mb} MB limit for this report."
            raise ValidationFailed(message, details={"file": [message]}, code="validation_total_size")
        with transaction.atomic():
            item = ReportFile.objects.create(task=task, owner=student, submitted=False, draft=submission, **fields)
            scanning.queue_scan(item)
        return item
    except BaseException:
        scanning.discard_pending_bytes(fields["file"])
        raise


def remove_file(*, submission_id, student, file_id):
    submission = student_target_or_404(student, submission_id)
    item = ReportFile.objects.filter(pk=file_id, draft=submission, owner=student, submitted=False).first()
    if item is None:
        raise NotFound("That upload is no longer available.", code="report_upload_not_found")
    services._delete_stored_file(item.file)
    item.delete()


# ---------------------------------------------------------------------------
# Submit and undo
# ---------------------------------------------------------------------------
def submit_target(*, submission_id, student, file_ids=None, note="", now=None):
    """Submit (or replace) the report for one target. ``file_ids`` defaults to
    the current version's files plus every file uploaded since."""
    now = now or timezone.now()
    note = services.clean_note(note)
    with transaction.atomic():
        submission = student_target_or_404(student, submission_id, for_update=True)
        require_self_service(submission.task.course)
        if file_ids is None:
            current = (
                list(submission.current_version.files.values_list("pk", flat=True))
                if submission.current_version_id
                else []
            )
            file_ids = current + list(draft_files(submission).values_list("pk", flat=True))
        wanted = services.parse_file_ids(file_ids)
        result = services.submit_locked(
            task=submission.task,
            submission=submission,
            student=student,
            wanted_ids=wanted,
            note=note,
            now=now,
            draft_files_only=True,
        )
        if result.created:
            ReportFile.objects.filter(pk__in=wanted, draft=submission).update(draft=None)
            publish(
                EVENT_RECEIPT,
                {"submission_id": submission.pk, "version_id": result.version.pk},
                dedupe_key=f"report-receipt:{submission.pk}:{result.version.pk}",
                # Sent after the undo window, and only if the version still exists.
                delay_seconds=undo_seconds(),
            )
    return result


def undo_until(submission):
    if (
        submission.version_count != 1
        or submission.status != ReportSubmission.STATUS_SUBMITTED
        or submission.submitted_at is None
    ):
        return None
    return submission.submitted_at + timedelta(seconds=undo_seconds())


def undo_submit(*, submission_id, student, now=None):
    """Take back a first submission within the undo window (it becomes a draft again)."""
    now = now or timezone.now()
    with transaction.atomic():
        submission = student_target_or_404(student, submission_id, for_update=True)
        deadline = undo_until(submission)
        has_grade = hasattr(submission, "grade") and submission.grade is not None
        if deadline is None or now > deadline or has_grade:
            raise Conflict("It's too late to undo this submission.", code="undo_expired")
        version = submission.current_version
        files = list(version.files.all())
        submission.current_version = None
        submission.version_count = 0
        submission.status = ReportSubmission.STATUS_NOT_SUBMITTED
        submission.first_submitted_at = None
        submission.submitted_at = None
        submission.is_late = False
        submission.minutes_late = 0
        submission.revision += 1
        submission.save()
        version.files.clear()
        version.delete()
        ReportFile.objects.filter(pk__in=[item.pk for item in files]).update(submitted=False, draft=submission)
    return submission


# ---------------------------------------------------------------------------
# The student's week (GET /api/reports/me/week)
# ---------------------------------------------------------------------------
def course_week_state(course, student, *, now=None):
    now = now or timezone.now()
    enabled, policy = is_self_service(course)
    legacy_count = ReportTask.objects.filter(
        course=course,
        origin=ReportTask.ORIGIN_ADMIN,
        status__in=[ReportTask.STATUS_PUBLISHED, ReportTask.STATUS_CLOSED],
    ).count()
    base = {"course": {"id": course.pk, "title": course.title}, "legacy_task_count": legacy_count}
    if not enabled:
        return {**base, "enabled": False, "reason": DISABLED_REASON, "weeks": [], "policy": None}
    anchor = anchor_for(course)
    choices = selectable_weeks(policy, now, anchor=anchor)
    weeks = [(WEEK_CURRENT, choices["current"])]
    if choices["previous"] is not None:
        weeks.append((WEEK_PREVIOUS, choices["previous"]))
    tasks = {
        task.week_start: task
        for task in ReportTask.objects.filter(
            course=course, origin=ReportTask.ORIGIN_AUTO, week_start__in=[week.week_start for _which, week in weeks]
        )
    }
    week_payloads = []
    for which, week in weeks:
        task = tasks.get(week.week_start)
        targets = []
        if task is not None:
            targets = list(
                ReportSubmission.objects.filter(task=task, student=student)
                .select_related("task", "grade", "current_version")
                .order_by("id")
            )
        limit = policy.max_targets_per_week
        days_late = week.days_late(now)
        week_payloads.append(
            {
                "which": which,
                "week_start": week.week_start,
                "week_end": week.week_end,
                "week_number": week.number,
                "label": week.label(),
                "due_at": week.due_at,
                "late_until": week.late_until,
                "status": week.status_at(now),
                "penalty_percent": str(services.quantize_marks(_penalty(policy, days_late))),
                "task_id": task.pk if task else None,
                "targets": targets,
                "slots_left": None if not limit else max(0, limit - len(targets)),
            }
        )
    return {
        **base,
        "enabled": True,
        "reason": "",
        "weeks": week_payloads,
        "policy": policy,
    }


def _penalty(policy, days_late):
    from .weeks import penalty_percent

    return penalty_percent(policy, days_late)


def student_courses(student):
    return list(
        Course.objects.filter(pk__in=accessible_course_ids_for_user(student))
        .select_related("report_policy")
        .order_by("title", "id")
    )


def current_week_for_course(course, *, now=None):
    enabled, policy = is_self_service(course)
    if not enabled:
        return None
    return week_for(policy, now or timezone.now(), anchor=anchor_for(course))
