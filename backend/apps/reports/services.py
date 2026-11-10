"""Weekly report rules: deadlines, staging, submitting, grading, marks.

Views stay thin and call these functions; every state change happens inside
one transaction with the affected submission row locked, and side effects
(notifications) are recorded with ``apps.core.outbox.publish`` in that same
transaction.
"""

from __future__ import annotations

import hashlib
import logging
import math
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from config.upload_validators import validate_report_upload
from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Prefetch
from django.utils import timezone

from apps.core.errors import Conflict, DomainError, ValidationFailed
from apps.core.outbox import publish
from apps.courses.access import active_enrollment_q
from apps.courses.models import Enrollment

from .antivirus import scan_upload
from .models import (
    GRADE_ACTION_DRAFT,
    GRADE_ACTION_GRADE,
    GRADE_ACTION_RETURN,
    ReportAttachment,
    ReportCriterion,
    ReportFile,
    ReportGrade,
    ReportGradeAudit,
    ReportSubmission,
    ReportSubmissionVersion,
    ReportTask,
    quantize_marks,
)
from .storage import free_bytes

logger = logging.getLogger("apps.reports")

EVENT_TASK_PUBLISHED = "reports.task_published"
EVENT_DUE_REMINDER = "reports.due_reminder"
EVENT_SUBMISSION_GRADED = "reports.submission_graded"
EVENT_SUBMISSION_RETURNED = "reports.submission_returned"
EVENT_MARKS_RELEASED = "reports.marks_released"
EVENT_LATE_DIGEST = "reports.late_digest"

NOTE_MAX_LENGTH = 2000
FEEDBACK_MAX_LENGTH = 10000
# A reminder is skipped when a task is published (or moved) this close to its deadline.
REMINDER_MIN_LEAD = timedelta(hours=1)


class StorageFull(DomainError):
    status = 507
    code = "storage_full"
    default_message = "The server is low on storage, so uploads are paused. Try again later."


# ---------------------------------------------------------------------------
# Submission window
# ---------------------------------------------------------------------------
WINDOW_NOT_OPEN = "not_open"
WINDOW_OPEN = "open"
WINDOW_LATE = "late"
WINDOW_CLOSED = "closed"


def submission_window(task, at=None):
    """'not_open' | 'open' (before due) | 'late' (late window) | 'closed'."""
    at = at or timezone.now()
    if task.status != ReportTask.STATUS_PUBLISHED:
        return WINDOW_CLOSED if task.status == ReportTask.STATUS_CLOSED else WINDOW_NOT_OPEN
    if task.opens_at and at < task.opens_at:
        return WINDOW_NOT_OPEN
    if at <= task.due_at:
        return WINDOW_OPEN
    if task.allows_late and at <= task.late_until:
        return WINDOW_LATE
    return WINDOW_CLOSED


def student_can_change(task, submission, at=None):
    """May the student upload/submit now? Returns (allowed, reason)."""
    window = submission_window(task, at)
    status = submission.status if submission else ReportSubmission.STATUS_NOT_SUBMITTED
    if window == WINDOW_NOT_OPEN:
        return False, "This report is not open for submissions yet."
    if task.status == ReportTask.STATUS_CLOSED:
        return False, "This report is closed."
    if status == ReportSubmission.STATUS_RETURNED:
        return True, ""
    if status in (ReportSubmission.STATUS_UNDER_REVIEW, ReportSubmission.STATUS_GRADED):
        return False, "Your report is being marked, so it can't be changed any more."
    if window == WINDOW_CLOSED:
        return False, "The deadline has passed, so submissions are closed."
    return True, ""


def _require_student_can_change(task, submission, at=None):
    allowed, reason = student_can_change(task, submission, at)
    if not allowed:
        raise Conflict(reason, code="submission_locked")


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------
def _ensure_disk_space(incoming_bytes):
    reserve = int(getattr(settings, "REPORTS_MIN_FREE_BYTES", 1024 * 1024 * 1024))
    try:
        available = free_bytes()
    except OSError:
        logger.exception("reports: private storage is not reachable")
        raise StorageFull("Uploads are unavailable right now. Try again later.") from None
    if available < reserve + 2 * int(incoming_bytes or 0):
        logger.error("reports: refusing upload, only %s bytes free on private storage", available)
        raise StorageFull()


def _sha256(uploaded):
    digest = hashlib.sha256()
    for chunk in uploaded.chunks():
        digest.update(chunk)
    uploaded.seek(0)
    return digest.hexdigest()


def _clean_original_name(name):
    base = str(name or "").replace("\\", "/").split("/")[-1].strip()
    base = "".join(char for char in base if ord(char) >= 32 and char not in '<>:"|?*')
    return (base or "file")[:255]


def _validate_file(uploaded, *, allowed_extensions, max_bytes, field_name="file"):
    try:
        return validate_report_upload(
            uploaded,
            field_name=field_name,
            allowed_extensions=allowed_extensions,
            max_bytes=max_bytes,
            zip_limits={
                "max_entries": getattr(settings, "REPORTS_ZIP_MAX_ENTRIES", 2000),
                "max_uncompressed_bytes": getattr(settings, "REPORTS_ZIP_MAX_UNCOMPRESSED_BYTES", 500 * 1024 * 1024),
                "max_ratio": getattr(settings, "REPORTS_ZIP_MAX_RATIO", 100),
            },
        )
    except DjangoValidationError as exc:
        messages = exc.message_dict.get(field_name) if hasattr(exc, "message_dict") else exc.messages
        message = (messages or ["This file can't be accepted."])[0]
        raise ValidationFailed(message, details={field_name: [message]}) from None


def _store_upload(uploaded, *, allowed_extensions, max_bytes, field_name="file"):
    """Validate, scan and hash an upload; returns the metadata to save."""
    if uploaded is None:
        raise ValidationFailed("Choose a file to upload.", details={field_name: ["Choose a file to upload."]})
    info = _validate_file(uploaded, allowed_extensions=allowed_extensions, max_bytes=max_bytes, field_name=field_name)
    _ensure_disk_space(getattr(uploaded, "size", 0))
    original_name = _clean_original_name(getattr(uploaded, "name", ""))
    scan_upload(uploaded, filename=original_name, field_name=field_name)
    return {
        "original_name": original_name,
        "extension": info["extension"],
        "content_type": info["content_type"],
        "size": int(uploaded.size),
        "sha256": _sha256(uploaded),
    }


def prune_staged_files(*, owner=None, older_than_hours=None, now=None):
    """Delete staged files (uploaded, never submitted) older than the TTL."""
    now = now or timezone.now()
    hours = older_than_hours or int(getattr(settings, "REPORTS_STAGED_UPLOAD_TTL_HOURS", 48))
    queryset = ReportFile.objects.filter(submitted=False, created_at__lt=now - timedelta(hours=hours))
    if owner is not None:
        queryset = queryset.filter(owner=owner)
    removed = 0
    for staged in queryset.iterator():
        _delete_stored_file(staged.file)
        staged.delete()
        removed += 1
    return removed


def _delete_stored_file(field_file):
    name = getattr(field_file, "name", "")
    if not name:
        return
    try:
        field_file.storage.delete(name)
    except OSError:
        logger.warning("reports: could not delete stored file %s", name)


def staged_files(task, student):
    return ReportFile.objects.filter(task=task, owner=student, submitted=False).order_by("created_at", "id")


def stage_upload(*, task, student, uploaded):
    """Store one uploaded file for the student's next submission."""
    submission = ReportSubmission.objects.filter(task=task, student=student).first()
    _require_student_can_change(task, submission)
    prune_staged_files(owner=student)
    if staged_files(task, student).count() >= task.max_files:
        message = f"You can attach up to {task.max_files} file{'s' if task.max_files != 1 else ''}. Remove one first."
        raise ValidationFailed(message, details={"file": [message]}, code="validation_too_many_files")
    meta = _store_upload(uploaded, allowed_extensions=task.allowed_extensions, max_bytes=task.max_file_bytes)
    staged_total = sum(staged_files(task, student).values_list("size", flat=True))
    if staged_total + meta["size"] > task.max_total_bytes:
        limit_mb = task.max_total_bytes // (1024 * 1024)
        message = f"Together your files would be larger than the {limit_mb} MB limit for this report."
        raise ValidationFailed(message, details={"file": [message]}, code="validation_total_size")
    report_file = ReportFile(task=task, owner=student, **meta)
    report_file.file.save(meta["original_name"], uploaded, save=False)
    try:
        report_file.save()
    except Exception:
        _delete_stored_file(report_file.file)
        raise
    return report_file


def remove_staged_upload(*, task, student, file_id):
    staged = ReportFile.objects.filter(pk=file_id, task=task, owner=student, submitted=False).first()
    if staged is None:
        from apps.core.errors import NotFound

        raise NotFound("That upload is no longer available.", code="report_upload_not_found")
    _delete_stored_file(staged.file)
    staged.delete()


# ---------------------------------------------------------------------------
# Submitting
# ---------------------------------------------------------------------------
@dataclass
class SubmitResult:
    submission: ReportSubmission
    version: ReportSubmissionVersion
    created: bool


def _late_digest_bucket(at):
    window = int(getattr(settings, "REPORTS_LATE_DIGEST_WINDOW_MINUTES", 60)) * 60
    return int(at.timestamp()) // window, window


def submit_report(*, task, student, file_ids, note="", now=None):
    now = now or timezone.now()
    note = str(note or "").strip()
    if len(note) > NOTE_MAX_LENGTH:
        message = f"Keep the note under {NOTE_MAX_LENGTH} characters."
        raise ValidationFailed(message, details={"note": [message]})
    try:
        wanted_ids = []
        for value in file_ids or []:
            parsed = int(value)
            if parsed not in wanted_ids:
                wanted_ids.append(parsed)
    except (TypeError, ValueError):
        raise ValidationFailed("Some files are invalid.", details={"file_ids": ["Some files are invalid."]}) from None
    if not wanted_ids:
        message = "Add at least one file before submitting."
        raise ValidationFailed(message, details={"file_ids": [message]})

    with transaction.atomic():
        submission, _created = ReportSubmission.objects.select_for_update().get_or_create(
            task=task, student=student, defaults={"status": ReportSubmission.STATUS_NOT_SUBMITTED}
        )
        _require_student_can_change(task, submission, now)

        current_files = (
            set(submission.current_version.files.values_list("pk", flat=True))
            if submission.current_version_id
            else set()
        )
        files = {
            item.pk: item
            for item in ReportFile.objects.filter(pk__in=wanted_ids, task=task, owner=student).select_for_update()
        }
        usable = [files[pk] for pk in wanted_ids if pk in files and (not files[pk].submitted or pk in current_files)]
        if len(usable) != len(wanted_ids):
            message = "Some files are no longer available. Upload them again."
            raise ValidationFailed(message, details={"file_ids": [message]}, code="validation_files_missing")
        if len(usable) > task.max_files:
            message = f"You can submit up to {task.max_files} file{'s' if task.max_files != 1 else ''}."
            raise ValidationFailed(message, details={"file_ids": [message]})
        allowed = set(task.allowed_extensions)
        not_allowed = [item.original_name for item in usable if item.extension not in allowed]
        if not_allowed:
            message = f"{not_allowed[0]} is not an allowed file type for this report any more. Remove it."
            raise ValidationFailed(message, details={"file_ids": [message]})
        if sum(item.size for item in usable) > task.max_total_bytes:
            limit_mb = task.max_total_bytes // (1024 * 1024)
            message = f"Together your files are larger than the {limit_mb} MB limit for this report."
            raise ValidationFailed(message, details={"file_ids": [message]})

        # A double tap (or a retry with a new key) that changes nothing never
        # creates a second version.
        is_revision = submission.status == ReportSubmission.STATUS_RETURNED
        if (
            submission.current_version_id
            and not is_revision
            and set(wanted_ids) == current_files
            and submission.current_version.note == note
        ):
            return SubmitResult(submission, submission.current_version, False)

        previous = submission.current_version
        if is_revision and previous is not None:
            is_late, minutes_late = previous.is_late, previous.minutes_late
        else:
            minutes_late = task.minutes_late(now)
            is_late = minutes_late > 0
        version = ReportSubmissionVersion.objects.create(
            submission=submission,
            number=submission.version_count + 1,
            note=note,
            submitted_at=now,
            is_late=is_late,
            minutes_late=minutes_late,
            is_revision=is_revision,
            submitted_by=student,
        )
        version.files.set(usable)
        ReportFile.objects.filter(pk__in=[item.pk for item in usable if not item.submitted]).update(submitted=True)

        old_status = submission.status
        if is_revision:
            submission.status = ReportSubmission.STATUS_RESUBMITTED
        elif old_status == ReportSubmission.STATUS_NOT_SUBMITTED:
            submission.status = ReportSubmission.STATUS_SUBMITTED
        submission.current_version = version
        submission.version_count = version.number
        submission.first_submitted_at = submission.first_submitted_at or now
        submission.submitted_at = now
        submission.is_late = is_late
        submission.minutes_late = minutes_late
        submission.revision += 1
        submission.save()

        if is_late and not is_revision and submission.late_digest_sent_at is None:
            bucket, window = _late_digest_bucket(now)
            delay = max(0, (bucket + 1) * window - int(now.timestamp()))
            publish(
                EVENT_LATE_DIGEST,
                {"task_id": task.pk, "bucket": bucket},
                dedupe_key=f"report-late-digest:{task.pk}:{bucket}",
                delay_seconds=delay,
            )
    return SubmitResult(submission, version, True)


# ---------------------------------------------------------------------------
# Marks
# ---------------------------------------------------------------------------
def parse_marks(value, *, field, maximum, required=True):
    if value in (None, ""):
        if required:
            raise ValidationFailed("Enter the marks.", details={field: ["Enter the marks."]})
        return None
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise ValidationFailed("Marks must be a number.", details={field: ["Marks must be a number."]}) from None
    if not parsed.is_finite():
        raise ValidationFailed("Marks must be a number.", details={field: ["Marks must be a number."]})
    if parsed != parsed.quantize(Decimal("0.01")):
        message = "Use at most two decimal places."
        raise ValidationFailed(message, details={field: [message]})
    if parsed < 0 or parsed > Decimal(maximum):
        message = f"Marks must be between 0 and {format_marks(maximum)}."
        raise ValidationFailed(message, details={field: [message]})
    return quantize_marks(parsed)


def format_marks(value):
    if value is None:
        return ""
    normalized = quantize_marks(value)
    text = f"{normalized:f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def marks_visible_to_student(submission):
    return submission.status == ReportSubmission.STATUS_GRADED and submission.task.marks_released


def _publish_student_event(event_type, submission):
    publish(
        event_type,
        {"submission_id": submission.pk, "revision": submission.revision},
        dedupe_key=f"{event_type}:{submission.pk}:{submission.revision}",
    )


def save_grade(
    *,
    submission_id,
    grader,
    action,
    expected_revision,
    marks=None,
    criteria_marks=None,
    feedback="",
    annotated_file=None,
    remove_annotated_file=False,
    now=None,
):
    now = now or timezone.now()
    if action not in (GRADE_ACTION_DRAFT, GRADE_ACTION_GRADE, GRADE_ACTION_RETURN):
        raise ValidationFailed("Unknown grading action.", details={"action": ["Unknown grading action."]})
    feedback = str(feedback or "").strip()
    if len(feedback) > FEEDBACK_MAX_LENGTH:
        message = f"Keep feedback under {FEEDBACK_MAX_LENGTH} characters."
        raise ValidationFailed(message, details={"feedback": [message]})
    if action == GRADE_ACTION_RETURN and not feedback:
        message = "Tell the student what to fix before returning the report."
        raise ValidationFailed(message, details={"feedback": [message]})
    try:
        expected_revision = int(expected_revision)
    except (TypeError, ValueError):
        message = "Reload the submission and try again."
        raise ValidationFailed(message, details={"expected_revision": [message]}) from None

    annotated_meta = None
    if annotated_file is not None:
        cap = int(getattr(settings, "REPORTS_MAX_FILE_SIZE_MB_CAP", 200)) * 1024 * 1024
        annotated_meta = _store_upload(
            annotated_file, allowed_extensions=None, max_bytes=cap, field_name="annotated_file"
        )

    stale_file = None
    with transaction.atomic():
        submission = (
            ReportSubmission.objects.select_for_update()
            .select_related("task", "task__course", "current_version")
            .get(pk=submission_id)
        )
        if submission.revision != expected_revision:
            raise Conflict(
                "Someone else changed this submission while you were marking it. Reload to see their changes.",
                code="grade_conflict",
                details={"current_revision": submission.revision},
            )
        if submission.current_version_id is None or submission.status == ReportSubmission.STATUS_NOT_SUBMITTED:
            raise Conflict("There is nothing to mark yet.", code="nothing_to_grade")
        task = submission.task
        version = submission.current_version
        grade = ReportGrade.objects.select_for_update().filter(submission=submission).first() or ReportGrade(
            submission=submission
        )
        old_status = submission.status
        old_final = grade.final_marks
        old_criteria = dict(grade.criteria_marks or {})

        details = {}
        if action == GRADE_ACTION_RETURN:
            grade.revision_feedback = feedback
            grade.returned_at = now
            submission.status = ReportSubmission.STATUS_RETURNED
            audit_action = ReportGradeAudit.ACTION_RETURNED
        else:
            required = action == GRADE_ACTION_GRADE
            criteria = list(ReportCriterion.objects.filter(task=task).order_by("order", "id"))
            if criteria:
                provided = criteria_marks if isinstance(criteria_marks, dict) else {}
                parsed = {}
                for criterion in criteria:
                    value = parse_marks(
                        provided.get(str(criterion.pk), provided.get(criterion.pk)),
                        field=f"criteria.{criterion.pk}",
                        maximum=criterion.max_marks,
                        required=required,
                    )
                    if value is not None:
                        parsed[str(criterion.pk)] = format_marks(value)
                raw = (
                    quantize_marks(sum((Decimal(value) for value in parsed.values()), Decimal("0"))) if parsed else None
                )
                grade.criteria_marks = parsed
            else:
                raw = parse_marks(marks, field="marks", maximum=task.max_marks, required=required)
                grade.criteria_marks = {}
            penalty = task.late_penalty_for(version.minutes_late, raw)
            grade.raw_marks = raw
            grade.late_penalty = penalty
            grade.final_marks = None if raw is None else quantize_marks(max(Decimal("0"), raw - penalty))
            grade.feedback = feedback
            grade.graded_version = version
            if action == GRADE_ACTION_GRADE:
                submission.status = ReportSubmission.STATUS_GRADED
                grade.graded_at = now
                audit_action = (
                    ReportGradeAudit.ACTION_REGRADED
                    if old_status == ReportSubmission.STATUS_GRADED
                    else ReportGradeAudit.ACTION_GRADED
                )
            else:
                submission.status = ReportSubmission.STATUS_UNDER_REVIEW
                audit_action = ReportGradeAudit.ACTION_DRAFT_SAVED
            if old_criteria != grade.criteria_marks:
                details["criteria"] = {"old": old_criteria, "new": grade.criteria_marks}
            if penalty:
                details["late_penalty"] = format_marks(penalty)

        grade.graded_by = grader
        if annotated_meta is not None:
            stale_file = grade.annotated_file.name if grade.annotated_file else None
            grade.annotated_file_name = annotated_meta["original_name"]
            grade.annotated_extension = annotated_meta["extension"]
            grade.annotated_content_type = annotated_meta["content_type"]
            grade.annotated_file_size = annotated_meta["size"]
            grade.annotated_file.save(annotated_meta["original_name"], annotated_file, save=False)
            details["annotated_file"] = annotated_meta["original_name"]
        elif remove_annotated_file and grade.annotated_file:
            stale_file = grade.annotated_file.name
            grade.annotated_file = None
            grade.annotated_file_name = ""
            grade.annotated_extension = ""
            grade.annotated_content_type = ""
            grade.annotated_file_size = 0
            details["annotated_file"] = None
        grade.save()

        submission.revision += 1
        submission.save(update_fields=["status", "revision", "updated_at"])
        details["version"] = version.number
        ReportGradeAudit.objects.create(
            submission=submission,
            actor=grader,
            action=audit_action,
            from_status=old_status,
            to_status=submission.status,
            old_final_marks=old_final,
            new_final_marks=grade.final_marks,
            details=details,
            created_at=now,
        )
        if action == GRADE_ACTION_RETURN:
            _publish_student_event(EVENT_SUBMISSION_RETURNED, submission)
        elif action == GRADE_ACTION_GRADE and task.marks_released:
            _publish_student_event(EVENT_SUBMISSION_GRADED, submission)
        if stale_file:
            stored = stale_file
            transaction.on_commit(lambda: _delete_name(stored))
    submission.grade = grade
    return submission


def _delete_name(name):
    from .storage import private_report_storage

    try:
        private_report_storage().delete(name)
    except OSError:
        logger.warning("reports: could not delete stored file %s", name)


def release_marks(*, task, actor, now=None):
    now = now or timezone.now()
    with transaction.atomic():
        task = ReportTask.objects.select_for_update().get(pk=task.pk)
        if task.marks_visibility != ReportTask.MARKS_ON_RELEASE:
            raise Conflict("Marks for this report are shown as soon as they are graded.", code="marks_not_held")
        if task.marks_released_at is not None:
            return task
        task.marks_released_at = now
        task.save(update_fields=["marks_released_at", "updated_at"])
        graded = list(
            ReportSubmission.objects.filter(task=task, status=ReportSubmission.STATUS_GRADED).select_related("grade")
        )
        ReportGradeAudit.objects.bulk_create(
            [
                ReportGradeAudit(
                    submission=item,
                    actor=actor,
                    action=ReportGradeAudit.ACTION_MARKS_RELEASED,
                    from_status=item.status,
                    to_status=item.status,
                    old_final_marks=getattr(getattr(item, "grade", None), "final_marks", None),
                    new_final_marks=getattr(getattr(item, "grade", None), "final_marks", None),
                    created_at=now,
                )
                for item in graded
            ]
        )
        publish(
            EVENT_MARKS_RELEASED,
            {"task_id": task.pk},
            dedupe_key=f"report-marks-released:{task.pk}:{int(now.timestamp())}",
        )
    return task


# ---------------------------------------------------------------------------
# Task lifecycle
# ---------------------------------------------------------------------------
def task_has_grades(task):
    return ReportGrade.objects.filter(submission__task=task).exclude(raw_marks__isnull=True).exists()


def validate_rubric(max_marks, criteria):
    if not criteria:
        return
    total = quantize_marks(sum((Decimal(str(item["max_marks"])) for item in criteria), Decimal("0")))
    if total != quantize_marks(max_marks):
        message = (
            f"The rubric criteria add up to {format_marks(total)} but the report is out of "
            f"{format_marks(max_marks)}. Make them equal."
        )
        raise ValidationFailed(message, details={"criteria": [message]}, code="validation_rubric_total")


def schedule_due_reminder(task, now=None):
    """Queue the 24h reminder as a delayed outbox event (delivered by process_async_jobs)."""
    now = now or timezone.now()
    if task.status != ReportTask.STATUS_PUBLISHED or task.due_at - now < REMINDER_MIN_LEAD:
        return None
    send_at = task.reminder_due_at()
    delay = max(0.0, (send_at - now).total_seconds())
    due_ts = int(task.due_at.timestamp())
    return publish(
        EVENT_DUE_REMINDER,
        {"task_id": task.pk, "due_at": due_ts},
        dedupe_key=f"report-due-reminder:{task.pk}:{due_ts}",
        delay_seconds=delay,
    )


def publish_task(*, task, actor, now=None):
    now = now or timezone.now()
    with transaction.atomic():
        task = ReportTask.objects.select_for_update().get(pk=task.pk)
        if task.status == ReportTask.STATUS_PUBLISHED:
            return task
        if task.due_at <= now:
            message = "The deadline is in the past. Move it before publishing."
            raise ValidationFailed(message, details={"due_at": [message]})
        criteria = list(task.criteria.values("max_marks"))
        validate_rubric(task.max_marks, criteria)
        task.status = ReportTask.STATUS_PUBLISHED
        task.published_at = task.published_at or now
        task.closed_at = None
        task.save(update_fields=["status", "published_at", "closed_at", "updated_at"])
        publish(EVENT_TASK_PUBLISHED, {"task_id": task.pk}, dedupe_key=f"report-task-published:{task.pk}")
        schedule_due_reminder(task, now)
    return task


def close_task(*, task, now=None):
    now = now or timezone.now()
    with transaction.atomic():
        task = ReportTask.objects.select_for_update().get(pk=task.pk)
        if task.status == ReportTask.STATUS_CLOSED:
            return task
        if task.status != ReportTask.STATUS_PUBLISHED:
            raise Conflict("Only a published report can be closed.", code="task_not_published")
        task.status = ReportTask.STATUS_CLOSED
        task.closed_at = now
        task.save(update_fields=["status", "closed_at", "updated_at"])
    return task


def reopen_task(*, task, now=None):
    now = now or timezone.now()
    with transaction.atomic():
        task = ReportTask.objects.select_for_update().get(pk=task.pk)
        if task.status != ReportTask.STATUS_CLOSED:
            raise Conflict("Only a closed report can be reopened.", code="task_not_closed")
        task.status = ReportTask.STATUS_PUBLISHED
        task.closed_at = None
        task.save(update_fields=["status", "closed_at", "updated_at"])
        schedule_due_reminder(task, now)
    return task


def duplicate_task(*, task, actor, shift_days=7):
    """'Duplicate last week': a draft copy one week later (dates, week, rubric, attachments)."""
    shift = timedelta(days=shift_days)
    with transaction.atomic():
        copy = ReportTask.objects.create(
            course=task.course,
            section=task.section,
            week_number=(task.week_number + 1) if task.week_number else None,
            title=task.title,
            brief=task.brief,
            opens_at=task.opens_at + shift if task.opens_at else None,
            due_at=task.due_at + shift,
            late_policy=task.late_policy,
            late_until=task.late_until + shift if task.late_until else None,
            late_penalty_percent_per_day=task.late_penalty_percent_per_day,
            max_marks=task.max_marks,
            allowed_file_types=list(task.allowed_file_types or []),
            max_files=task.max_files,
            max_file_size_mb=task.max_file_size_mb,
            max_total_size_mb=task.max_total_size_mb,
            marks_visibility=task.marks_visibility,
            status=ReportTask.STATUS_DRAFT,
            created_by=actor,
        )
        ReportCriterion.objects.bulk_create(
            [
                ReportCriterion(
                    task=copy,
                    name=item.name,
                    description=item.description,
                    max_marks=item.max_marks,
                    order=item.order,
                )
                for item in task.criteria.all()
            ]
        )
        for attachment in task.attachments.all():
            # Same stored bytes, new row: attachments are never modified in place.
            ReportAttachment.objects.create(
                task=copy,
                file=attachment.file.name,
                original_name=attachment.original_name,
                extension=attachment.extension,
                content_type=attachment.content_type,
                size=attachment.size,
                sha256=attachment.sha256,
                uploaded_by=actor,
            )
    return copy


def add_attachment(*, task, uploaded, actor):
    cap = int(getattr(settings, "REPORTS_MAX_FILE_SIZE_MB_CAP", 200)) * 1024 * 1024
    meta = _store_upload(uploaded, allowed_extensions=None, max_bytes=cap)
    attachment = ReportAttachment(task=task, uploaded_by=actor, **meta)
    attachment.file.save(meta["original_name"], uploaded, save=False)
    attachment.save()
    return attachment


def delete_attachment(attachment):
    name = attachment.file.name
    attachment.delete()
    if name and not ReportAttachment.objects.filter(file=name).exists():
        _delete_name(name)


# ---------------------------------------------------------------------------
# Gradebook
# ---------------------------------------------------------------------------
def percent(part, whole):
    if not whole:
        return None
    return quantize_marks(Decimal(part) * Decimal(100) / Decimal(whole))


def active_student_ids(course):
    return list(
        Enrollment.objects.filter(course=course, user__is_active=True)
        .filter(active_enrollment_q())
        .values_list("user_id", flat=True)
    )


def _cell(task, submission, *, now, visible_only):
    if submission is None or submission.status == ReportSubmission.STATUS_NOT_SUBMITTED:
        missing = task.accepting_until < now or task.status == ReportTask.STATUS_CLOSED
        return {
            "task_id": task.pk,
            "status": "missing" if missing else ReportSubmission.STATUS_NOT_SUBMITTED,
            "submission_id": None,
            "final_marks": None,
            "max_marks": task.max_marks,
            "is_late": False,
            "minutes_late": 0,
            "is_missing": missing,
        }
    grade = getattr(submission, "grade", None)
    graded = submission.status == ReportSubmission.STATUS_GRADED and grade is not None and grade.final_marks is not None
    show = graded and (not visible_only or task.marks_released)
    return {
        "task_id": task.pk,
        "status": submission.status,
        "submission_id": submission.pk,
        "final_marks": grade.final_marks if show else None,
        "max_marks": task.max_marks,
        "is_late": submission.is_late,
        "minutes_late": submission.minutes_late,
        "is_missing": False,
    }


def _totals(cells):
    graded = [cell for cell in cells if cell["final_marks"] is not None]
    total = quantize_marks(sum((Decimal(cell["final_marks"]) for cell in graded), Decimal("0")))
    out_of = quantize_marks(sum((Decimal(cell["max_marks"]) for cell in graded), Decimal("0")))
    return {
        "total_marks": total,
        "max_marks": out_of,
        "percentage": percent(total, out_of),
        "graded_count": len(graded),
        "missing_count": sum(1 for cell in cells if cell["is_missing"]),
        "late_count": sum(1 for cell in cells if cell["is_late"]),
        "submitted_count": sum(1 for cell in cells if cell["submission_id"]),
    }


def gradebook_tasks(course):
    return list(
        ReportTask.objects.filter(
            course=course, status__in=[ReportTask.STATUS_PUBLISHED, ReportTask.STATUS_CLOSED]
        ).order_by("due_at", "id")
    )


def course_gradebook(course, *, now=None):
    """Instructor gradebook: every student with access (or a submission) x every published task."""
    now = now or timezone.now()
    tasks = gradebook_tasks(course)
    submissions = (
        ReportSubmission.objects.filter(task__in=tasks).select_related("grade", "student").order_by("student_id")
    )
    by_student = {}
    for submission in submissions:
        by_student.setdefault(submission.student_id, {})[submission.task_id] = submission
    from django.contrib.auth import get_user_model

    student_ids = set(active_student_ids(course)) | set(by_student)
    students = get_user_model().objects.filter(pk__in=student_ids).order_by("full_name", "email", "id")
    rows = []
    for student in students:
        cells = [
            _cell(task, by_student.get(student.pk, {}).get(task.pk), now=now, visible_only=False) for task in tasks
        ]
        rows.append({"student": student, "cells": cells, "totals": _totals(cells)})
    return {"course": course, "tasks": tasks, "rows": rows}


def student_marks(user, *, now=None):
    """'My marks': per course, the student's visible marks and totals."""
    from .access import student_visible_tasks

    now = now or timezone.now()
    tasks = list(student_visible_tasks(user, now).select_related("course").order_by("course_id", "due_at", "id"))
    submissions = {
        item.task_id: item
        for item in ReportSubmission.objects.filter(student=user, task__in=tasks).select_related("grade", "task")
    }
    courses = {}
    for task in tasks:
        entry = courses.setdefault(task.course_id, {"course": task.course, "tasks": [], "cells": []})
        cell = _cell(task, submissions.get(task.pk), now=now, visible_only=True)
        entry["tasks"].append(task)
        entry["cells"].append(cell)
    result = []
    for entry in courses.values():
        entry["totals"] = _totals(entry["cells"])
        result.append(entry)
    result.sort(key=lambda item: item["course"].title.lower())
    return result


# ---------------------------------------------------------------------------
# Reminders
# ---------------------------------------------------------------------------
def unsubmitted_student_ids(task):
    submitted = set(
        ReportSubmission.objects.filter(task=task)
        .exclude(status=ReportSubmission.STATUS_NOT_SUBMITTED)
        .values_list("student_id", flat=True)
    )
    return [user_id for user_id in active_student_ids(task.course) if user_id not in submitted]


def due_reminder_targets(now=None):
    """Published tasks due within 24h that still need their reminder."""
    now = now or timezone.now()
    return ReportTask.objects.filter(
        status=ReportTask.STATUS_PUBLISHED,
        due_at__gt=now,
        due_at__lte=now + timedelta(hours=24),
    ).select_related("course")


def ceil_hours(delta):
    return max(1, int(math.ceil(delta.total_seconds() / 3600.0)))


def tasks_with_prefetch(queryset):
    return queryset.prefetch_related(
        Prefetch("criteria", queryset=ReportCriterion.objects.order_by("order", "id")),
        Prefetch("attachments", queryset=ReportAttachment.objects.order_by("created_at", "id")),
    )
