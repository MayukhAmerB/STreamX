"""Report notifications, delivered by the transactional outbox.

Events are published by ``services.py`` inside the transaction that changed
the data; ``process_async_jobs`` (``apps.core.worker``) delivers them, also the
delayed ones (the 24h due reminder and the instructor's late-submission
digest). Every handler is idempotent: notifications are keyed by a stable
``event_key`` (``create_notification`` is get-or-create), so a redelivered
event never notifies twice.
"""

from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from apps.core.outbox import outbox_handler
from apps.notifications.models import Notification
from apps.notifications.services import create_notification

from . import services
from .models import ReportSubmission, ReportTask


def format_ist(value):
    local = timezone.localtime(value)
    return local.strftime("%a %d %b, %I:%M %p IST").replace(" 0", " ")


def _student_url(task_id):
    return f"/reports/tasks/{task_id}"


@outbox_handler(services.EVENT_TASK_PUBLISHED, max_attempts=6)
def notify_task_published(event):
    task = ReportTask.objects.select_related("course").filter(pk=event.payload.get("task_id")).first()
    if task is None or task.status != ReportTask.STATUS_PUBLISHED:
        return
    create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"New weekly report: {task.title}"[:180],
        body=f"{task.course.title}: submit your report by {format_ist(task.due_at)}.",
        recipients=services.active_student_ids(task.course),
        event_key=f"report-task-published:{task.pk}",
        action_url=_student_url(task.pk),
        course=task.course,
        created_by=task.created_by,
    )


def send_due_reminder(task, now=None):
    """Remind students who have not submitted yet. Safe to call repeatedly."""
    now = now or timezone.now()
    if task.status != ReportTask.STATUS_PUBLISHED or task.due_at <= now:
        return None
    remaining = task.due_at - now
    if remaining > timedelta(hours=24, minutes=5):
        return None
    recipients = services.unsubmitted_student_ids(task)
    notification = create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"Report due soon: {task.title}"[:180],
        body=(
            f"{task.course.title}: your report is due {format_ist(task.due_at)} "
            f"(in about {services.ceil_hours(remaining)} h)."
        ),
        recipients=recipients,
        event_key=f"report-due-reminder:{task.pk}:{int(task.due_at.timestamp())}",
        action_url=_student_url(task.pk),
        course=task.course,
    )
    ReportTask.objects.filter(pk=task.pk).update(reminder_sent_at=now)
    return notification


@outbox_handler(services.EVENT_DUE_REMINDER, max_attempts=6)
def notify_due_reminder(event):
    task = ReportTask.objects.select_related("course").filter(pk=event.payload.get("task_id")).first()
    if task is None:
        return
    # The deadline moved since this reminder was queued: the reminder for the
    # new deadline is its own event.
    if int(task.due_at.timestamp()) != int(event.payload.get("due_at") or 0):
        return
    send_due_reminder(task)


def _student_submission(event):
    return (
        ReportSubmission.objects.select_related("task", "task__course", "grade")
        .filter(pk=event.payload.get("submission_id"))
        .first()
    )


@outbox_handler(services.EVENT_SUBMISSION_GRADED, max_attempts=6)
def notify_submission_graded(event):
    submission = _student_submission(event)
    if submission is None or not services.marks_visible_to_student(submission):
        return
    task = submission.task
    grade = getattr(submission, "grade", None)
    marks = services.format_marks(grade.final_marks) if grade else ""
    create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"Report marked: {task.title}"[:180],
        body=f"You scored {marks}/{services.format_marks(task.max_marks)}. Open it to read the feedback.",
        recipients=[submission.student_id],
        event_key=f"report-graded:{submission.pk}:{event.payload.get('revision')}",
        action_url=_student_url(task.pk),
        course=task.course,
    )


@outbox_handler(services.EVENT_SUBMISSION_RETURNED, max_attempts=6)
def notify_submission_returned(event):
    submission = _student_submission(event)
    if submission is None or submission.status != ReportSubmission.STATUS_RETURNED:
        return
    task = submission.task
    create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"Report returned for revision: {task.title}"[:180],
        body="Your instructor asked for changes. Read the feedback and submit again.",
        recipients=[submission.student_id],
        event_key=f"report-returned:{submission.pk}:{event.payload.get('revision')}",
        action_url=_student_url(task.pk),
        course=task.course,
    )


@outbox_handler(services.EVENT_MARKS_RELEASED, max_attempts=6)
def notify_marks_released(event):
    task = ReportTask.objects.select_related("course").filter(pk=event.payload.get("task_id")).first()
    if task is None or task.marks_released_at is None:
        return
    recipients = list(
        ReportSubmission.objects.filter(task=task, status=ReportSubmission.STATUS_GRADED).values_list(
            "student_id", flat=True
        )
    )
    create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"Marks released: {task.title}"[:180],
        body=f"{task.course.title}: your marks and feedback are ready.",
        recipients=recipients,
        event_key=f"report-marks-released:{task.pk}:{int(task.marks_released_at.timestamp())}",
        action_url=_student_url(task.pk),
        course=task.course,
    )


@outbox_handler(services.EVENT_LATE_DIGEST, max_attempts=6)
def notify_late_digest(event):
    task = ReportTask.objects.select_related("course").filter(pk=event.payload.get("task_id")).first()
    if task is None:
        return
    pending = list(
        ReportSubmission.objects.filter(task=task, is_late=True, late_digest_sent_at__isnull=True)
        .select_related("student")
        .order_by("submitted_at", "id")
    )
    if not pending:
        return
    instructor_id = task.course.instructor_id
    if instructor_id:
        names = [item.student.full_name or item.student.email for item in pending]
        shown = ", ".join(names[:5]) + (f" and {len(names) - 5} more" if len(names) > 5 else "")
        count = len(pending)
        create_notification(
            kind=Notification.KIND_ANNOUNCEMENT,
            title=f"{count} late report{'s' if count != 1 else ''}: {task.title}"[:180],
            body=f"Late submissions received from {shown}.",
            recipients=[instructor_id],
            event_key=f"report-late-digest:{task.pk}:{event.payload.get('bucket')}",
            action_url=f"/report-grading/queue?task={task.pk}&late=1",
            course=task.course,
        )
    ReportSubmission.objects.filter(pk__in=[item.pk for item in pending]).update(late_digest_sent_at=timezone.now())
