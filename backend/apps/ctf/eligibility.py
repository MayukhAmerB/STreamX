"""May this student use the labs Examination tab right now, and if not, why?

``GET /api/ctf/eligibility/`` answers ``{enabled, reason, message, action}``
so the labs page (and the Console card) can show ONE clear message with ONE
action instead of an empty list:

* ``ok``              at least one exam is visible (open, upcoming or done);
* ``no_batch``        the student has no paid enrolment in any course;
* ``access_expired``  enrolled, but no course access is active any more
                      (e.g. a lapsed installment);
* ``not_assigned``    active access, but no exam is assigned to the batch.

Two more reasons are produced by the labs page itself because the API
cannot answer them: ``signed_out`` (401) and ``terms`` (403
``terms_acceptance_required``).

Per exam, ``start_reason`` explains a disabled Start button (``presenters``).
"""

from __future__ import annotations

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from apps.courses.access import accessible_course_ids_for_user
from apps.courses.models import Enrollment

from . import access
from .models import CtfExam

REASON_OK = "ok"
REASON_NO_BATCH = "no_batch"
REASON_ACCESS_EXPIRED = "access_expired"
REASON_NOT_ASSIGNED = "not_assigned"
REASON_CHOICES = [
    (REASON_OK, "Eligible"),
    (REASON_NO_BATCH, "Not in a batch"),
    (REASON_ACCESS_EXPIRED, "Course access expired"),
    (REASON_NOT_ASSIGNED, "No exam assigned"),
]

MESSAGES = {
    REASON_OK: "Your examinations are below.",
    REASON_NO_BATCH: "You are not in a batch yet. Enrol in a course to take its examinations.",
    REASON_ACCESS_EXPIRED: "Your course access has ended. Renew it to take your batch's examinations.",
    REASON_NOT_ASSIGNED: "No examination is assigned to your batch yet. Your instructor will announce it.",
}


def _frontend(path):
    base = str(getattr(settings, "FRONTEND_URL", "") or "").rstrip("/")
    return f"{base}{path}" if base else path


def _action(reason):
    if reason == REASON_NO_BATCH:
        return {"label": "Browse courses", "url": _frontend("/courses")}
    if reason == REASON_ACCESS_EXPIRED:
        return {"label": "Renew access", "url": _frontend("/my-courses")}
    return None


def _exam_brief(exam, at):
    if exam is None:
        return None
    return {
        "slug": exam.slug,
        "title": {"en": exam.title, "ur": exam.title_ur or exam.title},
        "window": exam.window(at),
        "opens_at": exam.opens_at,
        "closes_at": exam.closes_at,
    }


def _current_exam(exams, at):
    """The exam to point at: an open one first, else the next to open."""
    open_now = [exam for exam in exams if exam.window(at) == CtfExam.WINDOW_OPEN]
    if open_now:
        return min(open_now, key=lambda exam: (exam.closes_at or at, exam.pk))
    upcoming = [exam for exam in exams if exam.window(at) == CtfExam.WINDOW_NOT_OPEN and exam.opens_at]
    if upcoming:
        return min(upcoming, key=lambda exam: (exam.opens_at, exam.pk))
    return None


def _next_scheduled(course_ids, at):
    """A scheduled (not yet published) exam for these batches, for "opens at"."""
    if not course_ids:
        return None
    return (
        CtfExam.objects.filter(
            status=CtfExam.STATUS_DRAFT, auto_publish=True, eligible_courses__in=course_ids, opens_at__gt=at
        )
        .order_by("opens_at", "id")
        .first()
    )


def eligibility_for(user, at=None):
    now = at or timezone.now()
    if access.is_staff_user(user):
        exams = list(access.visible_exams(user).exclude(status=CtfExam.STATUS_DRAFT))
        return {
            "enabled": True,
            "reason": REASON_OK,
            "message": "Staff preview: every exam is visible, drafts included.",
            "action": None,
            "exam": _exam_brief(_current_exam(exams, now), now),
            "next_exam": None,
            "server_time": now,
        }

    enrollments = Enrollment.objects.filter(user_id=user.pk)
    active_ids = list(accessible_course_ids_for_user(user))
    if not active_ids:
        reason = (
            REASON_ACCESS_EXPIRED
            if enrollments.filter(payment_status=Enrollment.STATUS_PAID).exists()
            else REASON_NO_BATCH
        )
        return {
            "enabled": False,
            "reason": reason,
            "message": MESSAGES[reason],
            "action": _action(reason),
            "exam": None,
            "next_exam": None,
            "server_time": now,
        }

    exams = list(access.visible_exams(user))
    scheduled = _next_scheduled(active_ids, now)
    if not exams:
        message = MESSAGES[REASON_NOT_ASSIGNED]
        if scheduled is not None:
            opens = timezone.localtime(scheduled.opens_at).strftime("%d %b %Y, %H:%M")
            message = f"Your next examination, {scheduled.title}, opens {opens}."
        return {
            "enabled": False,
            "reason": REASON_NOT_ASSIGNED,
            "message": message,
            "action": None,
            "exam": None,
            "next_exam": _exam_brief(scheduled, now),
            "server_time": now,
        }
    return {
        "enabled": True,
        "reason": REASON_OK,
        "message": MESSAGES[REASON_OK],
        "action": None,
        "exam": _exam_brief(_current_exam(exams, now), now),
        "next_exam": _exam_brief(scheduled, now),
        "server_time": now,
    }


def open_exam_filter(at):
    return Q(status=CtfExam.STATUS_PUBLISHED) & (Q(opens_at__isnull=True) | Q(opens_at__lte=at)) & (
        Q(closes_at__isnull=True) | Q(closes_at__gt=at)
    )
