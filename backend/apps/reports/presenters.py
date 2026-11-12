"""Model -> response dict helpers (rendered through ``serializers.py``)."""

from __future__ import annotations

from django.db.models import Count, Q
from django.urls import reverse
from django.utils import timezone

from .models import SCAN_CLEAN, ReportCriterion, ReportGradeAudit, ReportSubmission
from .services import (
    active_student_ids,
    marks_visible_to_student,
    staged_files,
    student_can_change,
    submission_window,
    task_has_grades,
)

PREVIEW_BY_EXTENSION = {
    "pdf": "pdf",
    "png": "image",
    "jpg": "image",
    "jpeg": "image",
    "webp": "image",
    "md": "markdown",
    "canvas": "canvas",
}


def preview_kind(extension, scan_status=SCAN_CLEAN):
    # SVG is deliberately "none": it is only ever downloaded, never rendered.
    # A file without a clean virus scan cannot be fetched, so it has no preview.
    if scan_status != SCAN_CLEAN:
        return "none"
    return PREVIEW_BY_EXTENSION.get(str(extension or "").lower(), "none")


def ref(obj):
    return {"id": obj.pk, "title": obj.title} if obj is not None else None


def person(user):
    return {"id": user.pk, "full_name": user.full_name or "", "email": user.email}


def file_dict(item):
    return {
        "id": item.pk,
        "name": item.original_name,
        "extension": item.extension,
        "content_type": item.content_type,
        "size": item.size,
        "created_at": item.created_at,
        "preview": preview_kind(item.extension, item.scan_status),
        "scan_status": item.scan_status,
        "download_url": reverse("reports-file-download", args=[item.pk]),
    }


def attachment_dict(item):
    data = file_dict(item)
    data["download_url"] = reverse("reports-attachment-download", args=[item.pk])
    return data


def criterion_dict(item):
    return {"id": item.pk, "name": item.name, "description": item.description, "max_marks": item.max_marks}


def version_dict(version):
    return {
        "id": version.pk,
        "number": version.number,
        "note": version.note,
        "submitted_at": version.submitted_at,
        "is_late": version.is_late,
        "minutes_late": version.minutes_late,
        "is_revision": version.is_revision,
        "files": [file_dict(item) for item in version.files.all().order_by("created_at", "id")],
    }


def feedback_file_dict(grade):
    if not grade or not grade.annotated_file:
        return None
    return {
        "name": grade.annotated_file_name,
        "extension": grade.annotated_extension,
        "size": grade.annotated_file_size,
        "preview": preview_kind(grade.annotated_extension, grade.annotated_scan_status),
        "scan_status": grade.annotated_scan_status,
        "download_url": reverse("reports-feedback-file-download", args=[grade.submission_id]),
    }


def criteria_marks(task, grade, criteria=None):
    criteria = criteria if criteria is not None else list(task.criteria.all())
    stored = (grade.criteria_marks or {}) if grade else {}
    return [
        {
            "id": item.pk,
            "name": item.name,
            "max_marks": item.max_marks,
            "marks": stored.get(str(item.pk)),
        }
        for item in criteria
    ]


# ---------------------------------------------------------------------------
# Student
# ---------------------------------------------------------------------------
def student_summary(task, submission, now=None):
    now = now or timezone.now()
    status = submission.status if submission else ReportSubmission.STATUS_NOT_SUBMITTED
    visible = bool(submission and marks_visible_to_student(submission))
    grade = getattr(submission, "grade", None) if submission else None
    can_submit, _reason = student_can_change(task, submission, now)
    return {
        "id": task.pk,
        "course": ref(task.course),
        "section": ref(task.section),
        "week_number": task.week_number,
        "title": task.title,
        "opens_at": task.opens_at,
        "due_at": task.due_at,
        "late_policy": task.late_policy,
        "late_until": task.late_until if task.allows_late else None,
        "accepting_until": task.accepting_until,
        "window": submission_window(task, now),
        "task_status": task.status,
        "max_marks": task.max_marks,
        "marks_visibility": task.marks_visibility,
        "status": status,
        "is_late": bool(submission and submission.is_late),
        "minutes_late": submission.minutes_late if submission else 0,
        "submitted_at": submission.submitted_at if submission else None,
        "version_count": submission.version_count if submission else 0,
        "marks_visible": visible,
        "final_marks": grade.final_marks if (visible and grade) else None,
        "can_submit": can_submit,
    }


def student_detail(task, submission, student, now=None):
    now = now or timezone.now()
    data = student_summary(task, submission, now)
    _allowed, reason = student_can_change(task, submission, now)
    criteria = list(task.criteria.all())
    grade = getattr(submission, "grade", None) if submission else None
    visible = bool(submission and marks_visible_to_student(submission))
    versions = []
    current = None
    if submission and submission.version_count:
        version_rows = list(submission.versions.prefetch_related("files").order_by("-number"))
        versions = [version_dict(item) for item in version_rows]
        current = next((item for item in versions if item["id"] == submission.current_version_id), None)
    data.update(
        {
            "brief": task.brief,
            "late_penalty_percent_per_day": task.late_penalty_percent_per_day,
            "allowed_extensions": task.allowed_extensions,
            "max_files": task.max_files,
            "max_file_size_mb": task.max_file_bytes // (1024 * 1024),
            "max_total_size_mb": task.max_total_bytes // (1024 * 1024),
            "criteria": [criterion_dict(item) for item in criteria],
            "attachments": [attachment_dict(item) for item in task.attachments.all()],
            "lock_reason": reason,
            "submission": None
            if not submission or not submission.version_count
            else {
                "id": submission.pk,
                "status": submission.status,
                "revision": submission.revision,
                "version_count": submission.version_count,
                "first_submitted_at": submission.first_submitted_at,
                "submitted_at": submission.submitted_at,
                "is_late": submission.is_late,
                "minutes_late": submission.minutes_late,
                "current_version": current,
                "versions": versions,
            },
            "staged_files": [file_dict(item) for item in staged_files(task, student)],
            "grade": None
            if not (visible and grade)
            else {
                "raw_marks": grade.raw_marks,
                "late_penalty": grade.late_penalty,
                "final_marks": grade.final_marks,
                "max_marks": task.max_marks,
                "criteria": criteria_marks(task, grade, criteria),
                "feedback": grade.feedback,
                "graded_at": grade.graded_at,
                "annotated_file": feedback_file_dict(grade),
            },
            "revision_feedback": (
                grade.revision_feedback
                if grade
                and submission.status
                in (
                    ReportSubmission.STATUS_RETURNED,
                    ReportSubmission.STATUS_RESUBMITTED,
                )
                else ""
            ),
            "marks_hidden_until_release": bool(
                submission and submission.status == ReportSubmission.STATUS_GRADED and not task.marks_released
            ),
        }
    )
    return data


# ---------------------------------------------------------------------------
# Graders
# ---------------------------------------------------------------------------
def task_counts(task, student_total=None):
    stats = ReportSubmission.objects.filter(task=task).aggregate(
        submitted=Count("id", filter=~Q(status=ReportSubmission.STATUS_NOT_SUBMITTED)),
        awaiting=Count("id", filter=Q(status__in=ReportSubmission.AWAITING_GRADING)),
        graded=Count("id", filter=Q(status=ReportSubmission.STATUS_GRADED)),
        returned=Count("id", filter=Q(status=ReportSubmission.STATUS_RETURNED)),
        late=Count("id", filter=Q(is_late=True)),
    )
    return {
        "students": student_total if student_total is not None else len(active_student_ids(task.course)),
        **{key: int(value or 0) for key, value in stats.items()},
    }


def manage_task_dict(task, *, student_total=None):
    criteria = list(task.criteria.all())
    return {
        "id": task.pk,
        "course": task.course_id,
        "course_title": task.course.title,
        "section": task.section_id,
        "section_title": task.section.title if task.section_id else None,
        "week_number": task.week_number,
        "title": task.title,
        "brief": task.brief,
        "opens_at": task.opens_at,
        "due_at": task.due_at,
        "late_policy": task.late_policy,
        "late_until": task.late_until,
        "late_penalty_percent_per_day": task.late_penalty_percent_per_day,
        "max_marks": task.max_marks,
        "allowed_file_types": list(task.allowed_file_types or []),
        "max_files": task.max_files,
        "max_file_size_mb": task.max_file_size_mb,
        "max_total_size_mb": task.max_total_size_mb,
        "marks_visibility": task.marks_visibility,
        "criteria": [criterion_dict(item) for item in criteria],
        "criteria_detail": [criterion_dict(item) for item in criteria],
        "status": task.status,
        "published_at": task.published_at,
        "closed_at": task.closed_at,
        "marks_released_at": task.marks_released_at,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "has_grades": task_has_grades(task),
        "counts": task_counts(task, student_total),
        "attachments": [attachment_dict(item) for item in task.attachments.all()],
    }


def gradebook_task_dict(task):
    return {
        "id": task.pk,
        "title": task.title,
        "week_number": task.week_number,
        "due_at": task.due_at,
        "max_marks": task.max_marks,
        "status": task.status,
    }


def queue_item(submission):
    grade = getattr(submission, "grade", None)
    return {
        "id": submission.pk,
        "task": gradebook_task_dict(submission.task),
        "student": person(submission.student),
        "status": submission.status,
        "submitted_at": submission.submitted_at,
        "is_late": submission.is_late,
        "minutes_late": submission.minutes_late,
        "version_count": submission.version_count,
        "final_marks": grade.final_marks if grade else None,
        "max_marks": submission.task.max_marks,
        "revision": submission.revision,
    }


def _actor_name(user):
    if user is None:
        return ""
    return user.full_name or user.email


def submission_detail(submission, neighbours):
    task = submission.task
    criteria = list(ReportCriterion.objects.filter(task=task).order_by("order", "id"))
    try:
        grade = submission.grade
    except ReportSubmission.grade.RelatedObjectDoesNotExist:
        grade = None
    versions = [version_dict(item) for item in submission.versions.prefetch_related("files").order_by("-number")]
    current = next((item for item in versions if item["id"] == submission.current_version_id), None)
    audit = (
        ReportGradeAudit.objects.filter(submission=submission)
        .select_related("actor")
        .order_by("-created_at", "-id")[:50]
    )
    return {
        "id": submission.pk,
        "task": {
            "id": task.pk,
            "title": task.title,
            "course": ref(task.course),
            "week_number": task.week_number,
            "due_at": task.due_at,
            "max_marks": task.max_marks,
            "late_penalty_percent_per_day": task.late_penalty_percent_per_day,
            "marks_visibility": task.marks_visibility,
            "marks_released_at": task.marks_released_at,
            "criteria": [criterion_dict(item) for item in criteria],
        },
        "student": person(submission.student),
        "status": submission.status,
        "revision": submission.revision,
        "submitted_at": submission.submitted_at,
        "first_submitted_at": submission.first_submitted_at,
        "is_late": submission.is_late,
        "minutes_late": submission.minutes_late,
        "current_version": current,
        "versions": versions,
        "grade": None
        if grade is None
        else {
            "raw_marks": grade.raw_marks,
            "late_penalty": grade.late_penalty,
            "final_marks": grade.final_marks,
            "criteria": criteria_marks(task, grade, criteria),
            "feedback": grade.feedback,
            "revision_feedback": grade.revision_feedback,
            "annotated_file": feedback_file_dict(grade),
            "graded_by": _actor_name(grade.graded_by),
            "graded_at": grade.graded_at,
            "graded_version": grade.graded_version.number if grade.graded_version_id else None,
        },
        "audit": [
            {
                "id": entry.pk,
                "action": entry.action,
                "action_label": entry.get_action_display(),
                "actor": _actor_name(entry.actor),
                "from_status": entry.from_status,
                "to_status": entry.to_status,
                "old_final_marks": entry.old_final_marks,
                "new_final_marks": entry.new_final_marks,
                "created_at": entry.created_at,
            }
            for entry in audit
        ],
        "neighbours": neighbours,
    }
