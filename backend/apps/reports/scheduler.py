"""``reports.scheduler``: every weekly-report side effect nobody has to click.

A periodic hook (every ``REPORTS_SCHEDULER_INTERVAL_SECONDS``, default 5 min)
publishes one deduplicated ``reports.scheduler_tick`` outbox event per
interval; ``process_async_jobs`` runs it. Each action below is guarded by a
``ReportNoticeLog`` key inserted in the same transaction as the action, so a
retried or doubled tick never notifies twice and a failed action is retried
on the next tick:

* week opens (self-service courses): the week's task is created and students
  are told the week is open;
* due in 24 h: students with no submitted report this week;
* missed: after last week's late window, students who sent nothing;
* daily grader digest (from ``REPORTS_GRADER_DIGEST_HOUR`` IST): the course
  instructor, else active staff in the ``graders`` group, else all staff;
* SLA alert: the oldest report waiting for marks is older than
  ``REPORTS_GRADING_SLA_HOURS`` (default 72 h), once a day per course;
* automatic marks release (policy ``auto_release``) after the late window plus
  ``auto_release_delay_hours``;
* housekeeping: re-queue stuck async scans, drop empty drafts of past weeks.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Count, Min, Q
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.core.outbox import outbox_handler, publish
from apps.notifications.models import Notification
from apps.notifications.services import create_notification

from . import scanning, services, weekly
from .models import ReportFile, ReportNoticeLog, ReportPolicy, ReportSubmission, ReportTask
from .weeks import previous_week, report_tz, week_for

logger = logging.getLogger("apps.reports.scheduler")

EVENT_TICK = "reports.scheduler_tick"
GRADERS_GROUP = "graders"


def interval_seconds():
    return max(60, int(getattr(settings, "REPORTS_SCHEDULER_INTERVAL_SECONDS", 300)))


def schedule_tick(now=None):
    """Periodic hook: one deduplicated tick event per interval (cheap)."""
    now = now or timezone.now()
    bucket = int(now.timestamp()) // interval_seconds()
    return publish(EVENT_TICK, {"bucket": bucket}, dedupe_key=f"reports-scheduler:{bucket}")


@outbox_handler(EVENT_TICK, max_attempts=3)
def handle_tick(event):
    stats = run_scheduler()
    if any(stats.values()):
        logger.info("reports: scheduler %s", stats)
    return stats


# ---------------------------------------------------------------------------
# Exactly-once guard
# ---------------------------------------------------------------------------
def already_done(key):
    return ReportNoticeLog.objects.filter(key=key[:200]).exists()


def run_once(key, action):
    """Run ``action()`` and record ``key`` atomically; skip when recorded.
    Returns True when the action ran now."""
    key = key[:200]
    if already_done(key):
        return False
    try:
        with transaction.atomic():
            ReportNoticeLog.objects.create(key=key)
            action()
    except IntegrityError:
        return False
    return True


# ---------------------------------------------------------------------------
# Recipients
# ---------------------------------------------------------------------------
def staff_ids():
    return list(
        get_user_model()
        .objects.filter(is_active=True)
        .filter(Q(is_staff=True) | Q(is_superuser=True))
        .values_list("pk", flat=True)
    )


def grader_ids(course):
    """The course instructor; else the staff ``graders`` group; else all staff."""
    instructor = getattr(course, "instructor", None)
    if instructor is not None and instructor.is_active:
        return [instructor.pk]
    group = list(
        get_user_model()
        .objects.filter(is_active=True, groups__name=GRADERS_GROUP)
        .values_list("pk", flat=True)
        .distinct()
    )
    return group or staff_ids()


def students_without_report(course, task):
    submitted = set()
    if task is not None:
        submitted = set(
            ReportSubmission.objects.filter(task=task)
            .exclude(status=ReportSubmission.STATUS_NOT_SUBMITTED)
            .values_list("student_id", flat=True)
        )
    return [user_id for user_id in services.active_student_ids(course) if user_id not in submitted]


def format_ist(value):
    local = timezone.localtime(value, report_tz())
    return local.strftime("%a %d %b, %I:%M %p IST").replace(" 0", " ")


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
def _notify_students(course, key, title, body, recipients):
    def action():
        create_notification(
            kind=Notification.KIND_ANNOUNCEMENT,
            title=title[:180],
            body=body,
            recipients=recipients,
            event_key=key,
            action_url="/reports",
            course=course,
        )

    return action


def week_actions(policy, now, stats):
    course = policy.course
    anchor = weekly.anchor_for(course)
    week = week_for(policy, now, anchor=anchor)
    task = weekly.ensure_week_task(course, policy, week, now=now)

    if not already_done(f"report-week-open:{course.pk}:{week.key}") and run_once(
        f"report-week-open:{course.pk}:{week.key}",
        _notify_students(
            course,
            f"report-week-open:{course.pk}:{week.key}",
            f"{week.label()}: weekly reports are open",
            f"{course.title}: submit a report for each target you investigate by {format_ist(week.due_at)}.",
            services.active_student_ids(course),
        ),
    ):
        stats["week_open"] += 1

    if week.due_at - timedelta(hours=24) <= now < week.due_at and not already_done(
        f"report-week-due:{course.pk}:{week.key}"
    ):
        recipients = students_without_report(course, task)
        if run_once(
            f"report-week-due:{course.pk}:{week.key}",
            _notify_students(
                course,
                f"report-week-due:{course.pk}:{week.key}",
                f"Weekly report due soon: {week.label()}",
                f"{course.title}: your report is due {format_ist(week.due_at)}.",
                recipients,
            ),
        ):
            stats["due_reminders"] += 1

    last = previous_week(policy, week, anchor=anchor)
    if last.late_until < now <= last.late_until + timedelta(days=6) and not already_done(
        f"report-week-missed:{course.pk}:{last.key}"
    ):
        last_task = ReportTask.objects.filter(
            course=course, origin=ReportTask.ORIGIN_AUTO, week_start=last.week_start
        ).first()
        # No week task means self-service was not on that week: nothing was missed.
        recipients = students_without_report(course, last_task) if last_task is not None else []
        if last_task is not None and run_once(
            f"report-week-missed:{course.pk}:{last.key}",
            _notify_students(
                course,
                f"report-week-missed:{course.pk}:{last.key}",
                f"Missed weekly report: {last.label()}",
                f"{course.title}: no report reached us for {last.label()}. This week's is due "
                f"{format_ist(week.due_at)}.",
                recipients,
            ),
        ):
            stats["missed"] += 1

    if policy.marks_visibility == ReportPolicy.MARKS_AUTO_RELEASE:
        delay = timedelta(hours=int(policy.auto_release_delay_hours or 0))
        for held in ReportTask.objects.filter(
            course=course,
            origin=ReportTask.ORIGIN_AUTO,
            marks_visibility=ReportTask.MARKS_ON_RELEASE,
            marks_released_at__isnull=True,
            status__in=[ReportTask.STATUS_PUBLISHED, ReportTask.STATUS_CLOSED],
        ):
            if now >= held.accepting_until + delay and run_once(
                f"report-auto-release:{held.pk}",
                lambda held=held: services.release_marks(task=held, actor=None, now=now),
            ):
                stats["marks_released"] += 1


def grading_actions(now, stats):
    """Daily digest and SLA alert for every course with reports waiting for marks."""
    local = timezone.localtime(now, report_tz())
    today = local.date().isoformat()
    digest_hour = int(getattr(settings, "REPORTS_GRADER_DIGEST_HOUR", 9))
    sla = timedelta(hours=int(getattr(settings, "REPORTS_GRADING_SLA_HOURS", 72)))
    waiting = (
        ReportSubmission.objects.filter(status__in=ReportSubmission.AWAITING_GRADING, current_version__isnull=False)
        .values("task__course_id")
        .annotate(count=Count("id"), oldest=Min("submitted_at"))
    )
    from apps.courses.models import Course

    for row in waiting:
        course = Course.objects.select_related("instructor").filter(pk=row["task__course_id"]).first()
        if course is None:
            continue
        count = row["count"]
        url = f"/report-grading/queue?course={course.pk}&status=awaiting&group=week"
        if local.hour >= digest_hour:
            key = f"report-grader-digest:{course.pk}:{today}"

            def digest(course=course, count=count, url=url, key=key):
                create_notification(
                    kind=Notification.KIND_ANNOUNCEMENT,
                    title=f"{count} report{'s' if count != 1 else ''} to mark: {course.title}"[:180],
                    body="Reports are waiting in your grading queue (oldest first).",
                    recipients=grader_ids(course),
                    event_key=key,
                    action_url=url,
                    course=course,
                )

            if run_once(key, digest):
                stats["digests"] += 1
        oldest = row["oldest"]
        if oldest is not None and now - oldest > sla:
            key = f"report-sla:{course.pk}:{today}"
            hours = int((now - oldest).total_seconds() // 3600)

            def alert(course=course, hours=hours, url=url, key=key):
                recipients = sorted(set(grader_ids(course)) | set(staff_ids()))
                create_notification(
                    kind=Notification.KIND_ANNOUNCEMENT,
                    title=f"Marking overdue: {course.title}"[:180],
                    body=f"The oldest report has waited {hours} h for marks (target: {int(sla.total_seconds() // 3600)} h).",
                    recipients=recipients,
                    event_key=key,
                    action_url=url,
                    course=course,
                )

            if run_once(key, alert):
                stats["sla_alerts"] += 1


def housekeeping(now, stats):
    stats["scans_requeued"] += scanning.requeue_stuck_scans(now=now)
    # Unsent drafts of weeks whose late window (or, with no grace, the due
    # time) closed more than a day ago.
    stale = ReportSubmission.objects.annotate(
        _closes_at=Coalesce("task__late_until", "task__due_at"),
    ).filter(
        status=ReportSubmission.STATUS_NOT_SUBMITTED,
        version_count=0,
        task__origin=ReportTask.ORIGIN_AUTO,
        _closes_at__lt=now - timedelta(days=1),
    )
    for draft in stale[:500]:
        for item in ReportFile.objects.filter(draft=draft, submitted=False):
            services._delete_stored_file(item.file)
            item.delete()
        draft.delete()
        stats["drafts_pruned"] += 1


def run_scheduler(now=None):
    now = now or timezone.now()
    stats = {
        "week_open": 0,
        "due_reminders": 0,
        "missed": 0,
        "marks_released": 0,
        "digests": 0,
        "sla_alerts": 0,
        "scans_requeued": 0,
        "drafts_pruned": 0,
    }
    for policy in ReportPolicy.objects.filter(self_service=True).select_related("course"):
        try:
            week_actions(policy, now, stats)
        except Exception:  # noqa: BLE001 - one course must not stop the others
            logger.exception("reports: scheduler failed for course %s", policy.course_id)
    grading_actions(now, stats)
    housekeeping(now, stats)
    return stats
