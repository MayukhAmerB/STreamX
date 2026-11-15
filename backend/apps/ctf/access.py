"""Who may see and sit which CTF exam.

* Students: published or closed exams whose ``eligible_courses`` overlap the
  courses they have *active* access to (``apps.courses.access``). An exam
  with no eligible courses is visible to no student.
* Staff and superusers: every exam, drafts included, so they can rehearse it.
  Their runs are flagged ``is_staff_preview`` and kept out of rankings.

Exams a user may not see answer 404 (not 403) so slugs do not leak.
"""

from __future__ import annotations

from apps.core.errors import NotFound
from apps.courses.access import accessible_course_ids_for_user, active_enrollment_q
from apps.courses.models import Enrollment

from .models import CtfExam


def is_staff_user(user):
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def visible_exams(user):
    if is_staff_user(user):
        return CtfExam.objects.all()
    if not user or not user.is_authenticated:
        return CtfExam.objects.none()
    course_ids = accessible_course_ids_for_user(user)
    return CtfExam.objects.filter(
        status__in=[CtfExam.STATUS_PUBLISHED, CtfExam.STATUS_CLOSED],
        eligible_courses__in=course_ids,
    ).distinct()


def exam_or_404(user, slug):
    exam = visible_exams(user).filter(slug=str(slug or "")[:80]).first()
    if exam is None:
        raise NotFound("Exam not found.", code="ctf_exam_not_found")
    return exam


def batch_course_for(user, exam):
    """The student's batch for this exam: the eligible course with their newest
    active enrollment (None for staff without one)."""
    enrollment = (
        Enrollment.objects.filter(user_id=user.pk, course__in=exam.eligible_courses.all())
        .filter(active_enrollment_q())
        .select_related("course")
        .order_by("-enrolled_at", "-id")
        .first()
    )
    return enrollment.course if enrollment else None
