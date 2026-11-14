"""In-app (and web push) notifications for exams.

Every notification has a stable ``event_key`` (``create_notification`` is
get-or-create on it, and adds recipients with ``ignore_conflicts``), so a
retried outbox event or a second scheduler run never notifies twice.
"""

from __future__ import annotations

from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.courses.access import active_enrollment_q
from apps.courses.models import Enrollment
from apps.notifications.models import Notification
from apps.notifications.services import create_notification


def labs_exam_url():
    return str(getattr(settings, "CTF_LABS_EXAM_URL", "") or "https://labs.alsyedinitiative.com/#exam")


def _when(moment):
    if not moment:
        return ""
    return timezone.localtime(moment).strftime("%d %b %Y, %H:%M")


def eligible_student_ids(exam):
    """Active students of the exam's batches (never staff)."""
    return list(
        Enrollment.objects.filter(course__in=exam.eligible_courses.all(), user__is_active=True)
        .filter(active_enrollment_q())
        .exclude(user__is_staff=True)
        .exclude(user__is_superuser=True)
        .values_list("user_id", flat=True)
        .distinct()
    )


def staff_user_ids():
    return list(
        get_user_model()
        .objects.filter(is_active=True, is_staff=True)
        .values_list("id", flat=True)[:50]
    )


def notify_exam_published(exam):
    closes = f" It closes {_when(exam.closes_at)}." if exam.closes_at else ""
    return create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"Exam open: {exam.title}"[:180],
        body=f"Your OSINT examination is open on labs now.{closes}",
        recipients=eligible_student_ids(exam),
        event_key=f"ctf-exam-published:{exam.pk}",
        action_url=labs_exam_url(),
    )


def notify_exam_opening_soon(exam):
    opens = int(exam.opens_at.timestamp()) if exam.opens_at else 0
    return create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"Exam opens soon: {exam.title}"[:180],
        body=f"Your OSINT examination opens {_when(exam.opens_at)}. Sign in to labs a few minutes early.",
        recipients=eligible_student_ids(exam),
        event_key=f"ctf-exam-opening-soon:{exam.pk}:{opens}",
        action_url=labs_exam_url(),
    )


def notify_result(result, exam):
    return create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"Exam result: {exam.title}"[:180],
        body=(
            f"Your score: {result.score} / {result.total_points} points "
            f"({result.solved_count} of {result.question_count} solved)."
        ),
        recipients=[result.user_id],
        event_key=f"ctf-result:{exam.pk}:{result.user_id}",
        action_url="/gradebook",
    )


def notify_staff_not_ready(exam, reasons):
    opens = int(exam.opens_at.timestamp()) if exam.opens_at else 0
    return create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=f"Exam not published: {exam.title}"[:180],
        body="It was scheduled to open, but its checklist is not complete: " + "; ".join(reasons)[:600],
        recipients=staff_user_ids(),
        event_key=f"ctf-exam-not-ready:{exam.pk}:{opens}",
        action_url=f"/console/exams/{exam.slug}",
    )
