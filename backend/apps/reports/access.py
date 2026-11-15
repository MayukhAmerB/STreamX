"""Who may see and do what with weekly reports.

* Students: published (or closed) tasks of courses they have *active* access
  to (``apps.courses.access``), once ``opens_at`` has passed. Only their own
  submission, files and (visible) marks.
* Graders: staff/superusers for every course; an instructor for the courses
  they teach (``Course.instructor``).

Objects a user may not see answer 404 (not 403) so ids do not leak.
"""

from __future__ import annotations

from django.db.models import Q
from django.utils import timezone

from apps.core.errors import NotFound, PermissionDenied
from apps.courses.access import accessible_course_ids_for_user, user_has_course_access
from apps.courses.models import Course

from .models import ReportSubmission, ReportTask


def is_staff_user(user):
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def can_grade_course(user, course_or_id):
    if not user or not user.is_authenticated:
        return False
    if is_staff_user(user):
        return True
    instructor_id = (
        course_or_id.instructor_id
        if isinstance(course_or_id, Course)
        else Course.objects.filter(pk=course_or_id).values_list("instructor_id", flat=True).first()
    )
    return bool(instructor_id and instructor_id == user.id)


def is_grader(user):
    """May open the grading area at all (staff, or teaches at least one course)."""
    if is_staff_user(user):
        return True
    return bool(user and user.is_authenticated and Course.objects.filter(instructor_id=user.id).exists())


def gradable_courses(user):
    if is_staff_user(user):
        return Course.objects.all()
    if not user or not user.is_authenticated:
        return Course.objects.none()
    return Course.objects.filter(instructor_id=user.id)


def require_grader(user):
    if not is_grader(user):
        raise PermissionDenied("Only course instructors and admins can grade reports.", code="not_a_grader")


def manageable_tasks(user):
    return ReportTask.objects.filter(course__in=gradable_courses(user))


def manageable_task_or_404(user, task_id, *, for_update=False):
    queryset = manageable_tasks(user).select_related("course", "section")
    if for_update:
        queryset = queryset.select_for_update()
    task = queryset.filter(pk=task_id).first()
    if task is None:
        raise NotFound("Report task not found.", code="report_task_not_found")
    return task


def manageable_submission_or_404(user, submission_id):
    submission = (
        ReportSubmission.objects.filter(task__course__in=gradable_courses(user), pk=submission_id)
        .select_related("task", "task__course", "student", "current_version", "grade")
        .first()
    )
    if submission is None:
        raise NotFound("Submission not found.", code="report_submission_not_found")
    return submission


def student_visible_tasks(user, at=None):
    at = at or timezone.now()
    return ReportTask.objects.filter(
        course_id__in=accessible_course_ids_for_user(user),
        status__in=[ReportTask.STATUS_PUBLISHED, ReportTask.STATUS_CLOSED],
    ).filter(Q(opens_at__isnull=True) | Q(opens_at__lte=at))


def student_task_or_404(user, task_id):
    task = student_visible_tasks(user).select_related("course", "section").filter(pk=task_id).first()
    if task is None:
        raise NotFound("Report task not found.", code="report_task_not_found")
    return task


def student_has_task_access(user, task):
    return task.is_open_for_students() and user_has_course_access(user, task.course_id)
