"""HTTP mapping for weekly reports (students under /api/reports/, graders under
/api/reports/manage/). Business rules live in ``services.py``; access rules in
``access.py``. Files are only ever served by the download views here."""

from __future__ import annotations

import mimetypes
from urllib.parse import quote

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from django.db import transaction
from django.db.models import Count, Max, Q
from django.http import FileResponse, HttpResponse, StreamingHttpResponse
from django.utils import timezone
from django.views.decorators.clickjacking import xframe_options_sameorigin
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.views import APIView

from apps.core.errors import Conflict, NotFound, ValidationFailed
from apps.core.idempotency import IdempotencyMixin
from apps.courses.models import Section

from . import access, presenters, services
from .exports import course_marks_csv, iter_task_zip, safe_component, task_marks_csv
from .models import ReportAttachment, ReportCriterion, ReportFile, ReportGrade, ReportSubmission, ReportTask
from .serializers import (
    AttachmentUploadResponseSerializer,
    GradableCourseListSerializer,
    GradebookSerializer,
    GradeRequestSerializer,
    ManageTaskListSerializer,
    ManageTaskSerializer,
    MyMarksSerializer,
    StoredFileSerializer,
    StudentTaskDetailSerializer,
    StudentTaskListSerializer,
    SubmissionDetailSerializer,
    SubmissionQueueSerializer,
    SubmitReportRequestSerializer,
    SubmitReportResponseSerializer,
    UploadRequestSerializer,
)

BINARY_RESPONSE = {(200, "application/octet-stream"): OpenApiTypes.BINARY}
INLINE_EXTENSIONS = {"pdf", "png", "jpg", "jpeg", "webp"}
# Inline previews (PDF, images) may be framed by the app itself; everything
# else is a sandboxed attachment that can never run script on our origin.
INLINE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"
ATTACHMENT_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"


def _data(serializer_class, payload, **kwargs):
    return serializer_class(payload, **kwargs).data


def _ok(serializer_class, payload, message="", status_code=200):
    return api_response(message=message, data=_data(serializer_class, payload), status_code=status_code)


def _int_param(request, name):
    raw = str(request.query_params.get(name, "") or "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        raise ValidationFailed(f"{name} must be a number.", details={name: [f"{name} must be a number."]}) from None
    return value if value > 0 else None


def _bool_param(request, name):
    return str(request.query_params.get(name, "") or "").strip().lower() in {"1", "true", "yes"}


def private_file_response(field_file, *, filename, extension, content_type, inline_requested):
    """Stream a private file with download-safe headers."""
    try:
        handle = field_file.open("rb")
    except (OSError, ValueError):
        raise NotFound("This file is missing from storage.", code="report_file_missing") from None
    inline = inline_requested and extension in INLINE_EXTENSIONS
    served_type = (
        content_type if inline else (content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream")
    )
    if extension == "svg":
        served_type = "application/octet-stream"
    response = FileResponse(handle, content_type=served_type)
    ascii_name = safe_component(filename).encode("ascii", "ignore").decode("ascii") or f"file.{extension}"
    disposition = "inline" if inline else "attachment"
    response["Content-Disposition"] = f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = INLINE_CSP if inline else ATTACHMENT_CSP
    response["Cache-Control"] = "private, no-store"
    response["Cross-Origin-Resource-Policy"] = "same-origin"
    response["Referrer-Policy"] = "no-referrer"
    try:
        response["Content-Length"] = str(field_file.size)
    except (OSError, ValueError):
        pass
    return response


class _ReportsView(APIView):
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]


# ---------------------------------------------------------------------------
# Student
# ---------------------------------------------------------------------------
class StudentTaskListView(_ReportsView):
    @extend_schema(
        operation_id="reports_tasks_list",
        parameters=[OpenApiParameter("course", int, required=False)],
        responses={200: StudentTaskListSerializer},
    )
    def get(self, request):
        now = timezone.now()
        tasks = access.student_visible_tasks(request.user, now).select_related("course", "section")
        course_id = _int_param(request, "course")
        if course_id:
            tasks = tasks.filter(course_id=course_id)
        tasks = list(tasks.order_by("-due_at", "-id"))
        submissions = {
            item.task_id: item
            for item in ReportSubmission.objects.filter(student=request.user, task__in=tasks).select_related("grade")
        }
        results = [presenters.student_summary(task, submissions.get(task.pk), now) for task in tasks]
        upcoming = [
            item
            for item in results
            if item["window"] in ("open", "late") and item["status"] in ("not_submitted", "returned_for_revision")
        ]
        upcoming.sort(key=lambda item: item["due_at"])
        payload = {"results": results, "next_due": upcoming[0] if upcoming else None, "server_time": now}
        return _ok(StudentTaskListSerializer, payload)


def _student_detail_payload(request, task):
    submission = (
        ReportSubmission.objects.filter(task=task, student=request.user)
        .select_related("grade", "current_version")
        .first()
    )
    task = services.tasks_with_prefetch(ReportTask.objects.select_related("course", "section")).get(pk=task.pk)
    return presenters.student_detail(task, submission, request.user)


class StudentTaskDetailView(_ReportsView):
    @extend_schema(operation_id="reports_tasks_retrieve", responses={200: StudentTaskDetailSerializer})
    def get(self, request, task_id):
        task = access.student_task_or_404(request.user, task_id)
        return _ok(StudentTaskDetailSerializer, _student_detail_payload(request, task))


class StudentUploadView(_ReportsView):
    parser_classes = [MultiPartParser, FormParser]
    throttle_scope = "report_upload"

    @extend_schema(
        operation_id="reports_tasks_uploads_create",
        request={"multipart/form-data": UploadRequestSerializer},
        responses={201: StoredFileSerializer},
    )
    def post(self, request, task_id):
        task = access.student_task_or_404(request.user, task_id)
        uploaded = request.FILES.get("file")
        if uploaded is None:
            raise ValidationFailed("Choose a file to upload.", details={"file": ["Choose a file to upload."]})
        stored = services.stage_upload(task=task, student=request.user, uploaded=uploaded)
        return api_response(
            message="File uploaded.", data=_data(StoredFileSerializer, presenters.file_dict(stored)), status_code=201
        )


class StudentUploadDeleteView(_ReportsView):
    @extend_schema(operation_id="reports_tasks_uploads_destroy", responses={200: None})
    def delete(self, request, task_id, file_id):
        task = access.student_task_or_404(request.user, task_id)
        services.remove_staged_upload(task=task, student=request.user, file_id=file_id)
        return api_response(message="File removed.", data=None, status_code=200)


class StudentSubmitView(IdempotencyMixin, _ReportsView):
    idempotency_scope = "reports.submit"
    idempotency_required = True
    throttle_scope = "report_submit"

    @extend_schema(
        operation_id="reports_tasks_submit_create",
        request=SubmitReportRequestSerializer,
        responses={200: SubmitReportResponseSerializer, 201: SubmitReportResponseSerializer},
        parameters=[OpenApiParameter("Idempotency-Key", str, OpenApiParameter.HEADER, required=True)],
    )
    def post(self, request, task_id):
        task = access.student_task_or_404(request.user, task_id)
        serializer = SubmitReportRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = services.submit_report(
            task=task,
            student=request.user,
            file_ids=serializer.validated_data["file_ids"],
            note=serializer.validated_data.get("note", ""),
        )
        payload = {"created": result.created, "task": _student_detail_payload(request, task)}
        return api_response(
            message="Report submitted." if result.created else "Your report was already submitted.",
            data=_data(SubmitReportResponseSerializer, payload),
            status_code=201 if result.created else 200,
        )


class MyMarksView(_ReportsView):
    @extend_schema(operation_id="reports_marks_retrieve", responses={200: MyMarksSerializer})
    def get(self, request):
        courses = services.student_marks(request.user)
        payload = {
            "courses": [
                {
                    "course": presenters.ref(entry["course"]),
                    "tasks": [presenters.gradebook_task_dict(task) for task in entry["tasks"]],
                    "cells": entry["cells"],
                    "totals": entry["totals"],
                }
                for entry in courses
            ]
        }
        return _ok(MyMarksSerializer, payload)


class _FileDownloadView(_ReportsView):
    """Base for private file downloads: never cached, never sniffed."""

    @classmethod
    def as_view(cls, **initkwargs):
        return xframe_options_sameorigin(super().as_view(**initkwargs))


class SubmissionFileDownloadView(_FileDownloadView):
    @extend_schema(
        operation_id="reports_files_download",
        parameters=[OpenApiParameter("inline", bool, required=False)],
        responses=BINARY_RESPONSE,
    )
    def get(self, request, file_id):
        item = ReportFile.objects.select_related("task", "task__course").filter(pk=file_id).first()
        allowed = item is not None and (
            item.owner_id == request.user.id or access.can_grade_course(request.user, item.task.course)
        )
        if not allowed:
            raise NotFound("File not found.", code="report_file_not_found")
        return private_file_response(
            item.file,
            filename=item.original_name,
            extension=item.extension,
            content_type=item.content_type,
            inline_requested=_bool_param(request, "inline"),
        )


class AttachmentDownloadView(_FileDownloadView):
    @extend_schema(
        operation_id="reports_attachments_download",
        parameters=[OpenApiParameter("inline", bool, required=False)],
        responses=BINARY_RESPONSE,
    )
    def get(self, request, attachment_id):
        item = ReportAttachment.objects.select_related("task", "task__course").filter(pk=attachment_id).first()
        allowed = item is not None and (
            access.can_grade_course(request.user, item.task.course)
            or (
                item.task.is_open_for_students()
                and access.student_visible_tasks(request.user).filter(pk=item.task_id).exists()
            )
        )
        if not allowed:
            raise NotFound("File not found.", code="report_file_not_found")
        return private_file_response(
            item.file,
            filename=item.original_name,
            extension=item.extension,
            content_type=item.content_type,
            inline_requested=_bool_param(request, "inline"),
        )


class FeedbackFileDownloadView(_FileDownloadView):
    @extend_schema(
        operation_id="reports_feedback_file_download",
        parameters=[OpenApiParameter("inline", bool, required=False)],
        responses=BINARY_RESPONSE,
    )
    def get(self, request, submission_id):
        grade = (
            ReportGrade.objects.select_related("submission", "submission__task", "submission__task__course")
            .filter(submission_id=submission_id)
            .first()
        )
        allowed = False
        if grade is not None and grade.annotated_file:
            submission = grade.submission
            if access.can_grade_course(request.user, submission.task.course):
                allowed = True
            elif submission.student_id == request.user.id:
                allowed = services.marks_visible_to_student(submission) or submission.status in (
                    ReportSubmission.STATUS_RETURNED,
                    ReportSubmission.STATUS_RESUBMITTED,
                )
        if not allowed:
            raise NotFound("File not found.", code="report_file_not_found")
        return private_file_response(
            grade.annotated_file,
            filename=grade.annotated_file_name,
            extension=grade.annotated_extension,
            content_type=grade.annotated_content_type,
            inline_requested=_bool_param(request, "inline"),
        )


# ---------------------------------------------------------------------------
# Graders: courses and tasks
# ---------------------------------------------------------------------------
class _GraderView(_ReportsView):
    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        access.require_grader(request.user)


class GradableCoursesView(_GraderView):
    @extend_schema(operation_id="reports_manage_courses_list", responses={200: GradableCourseListSerializer})
    def get(self, request):
        courses = (
            access.gradable_courses(request.user).annotate(last_week=Max("report_tasks__week_number")).order_by("title")
        )
        sections = {}
        for section in Section.objects.filter(course__in=courses).order_by("order", "id"):
            sections.setdefault(section.course_id, []).append(
                {"id": section.pk, "title": section.title, "order": section.order}
            )
        results = [
            {
                "id": course.pk,
                "title": course.title,
                "sections": sections.get(course.pk, []),
                "next_week_number": (course.last_week or 0) + 1,
            }
            for course in courses
        ]
        return _ok(GradableCourseListSerializer, {"results": results})


def _apply_task_fields(task, data):
    for field in (
        "week_number",
        "title",
        "brief",
        "opens_at",
        "due_at",
        "late_policy",
        "late_until",
        "late_penalty_percent_per_day",
        "max_marks",
        "allowed_file_types",
        "max_files",
        "max_file_size_mb",
        "max_total_size_mb",
        "marks_visibility",
    ):
        if field in data:
            setattr(task, field, data[field])
    if task.late_policy != ReportTask.LATE_ALLOWED:
        task.late_until = None


def _resolve_section(course_id, section_id):
    if not section_id:
        return None
    section = Section.objects.filter(pk=section_id, course_id=course_id).first()
    if section is None:
        raise ValidationFailed(
            "Choose a module from this course.", details={"section": ["Choose a module from this course."]}
        )
    return section


def _replace_criteria(task, criteria):
    ReportCriterion.objects.filter(task=task).delete()
    ReportCriterion.objects.bulk_create(
        [
            ReportCriterion(
                task=task,
                name=item["name"],
                description=item.get("description", ""),
                max_marks=item["max_marks"],
                order=index,
            )
            for index, item in enumerate(criteria, start=1)
        ]
    )


def _manage_task_payload(task):
    task = services.tasks_with_prefetch(ReportTask.objects.select_related("course", "section")).get(pk=task.pk)
    return presenters.manage_task_dict(task)


class ManageTaskListView(_GraderView):
    parser_classes = [JSONParser]

    @extend_schema(
        operation_id="reports_manage_tasks_list",
        parameters=[OpenApiParameter("course", int, required=False), OpenApiParameter("status", str, required=False)],
        responses={200: ManageTaskListSerializer},
    )
    def get(self, request):
        tasks = access.manageable_tasks(request.user).select_related("course", "section")
        course_id = _int_param(request, "course")
        if course_id:
            tasks = tasks.filter(course_id=course_id)
        status_filter = str(request.query_params.get("status", "") or "").strip()
        if status_filter in {choice for choice, _label in ReportTask.STATUS_CHOICES}:
            tasks = tasks.filter(status=status_filter)
        tasks = list(services.tasks_with_prefetch(tasks.order_by("-due_at", "-id"))[:200])
        student_totals = {}
        results = []
        for task in tasks:
            if task.course_id not in student_totals:
                student_totals[task.course_id] = len(services.active_student_ids(task.course))
            results.append(presenters.manage_task_dict(task, student_total=student_totals[task.course_id]))
        return _ok(ManageTaskListSerializer, {"results": results})

    @extend_schema(
        operation_id="reports_manage_tasks_create", request=ManageTaskSerializer, responses={201: ManageTaskSerializer}
    )
    def post(self, request):
        serializer = ManageTaskSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        course = access.gradable_courses(request.user).filter(pk=data["course"]).first()
        if course is None:
            raise ValidationFailed("Choose one of your courses.", details={"course": ["Choose one of your courses."]})
        criteria = data.get("criteria") or []
        services.validate_rubric(data.get("max_marks"), criteria)
        with transaction.atomic():
            task = ReportTask(
                course=course, created_by=request.user, section=_resolve_section(course.pk, data.get("section"))
            )
            _apply_task_fields(task, data)
            task.save()
            _replace_criteria(task, criteria)
        return api_response(
            message="Report task created.",
            data=_data(ManageTaskSerializer, _manage_task_payload(task)),
            status_code=201,
        )


class ManageTaskDetailView(_GraderView):
    parser_classes = [JSONParser]

    @extend_schema(operation_id="reports_manage_tasks_retrieve", responses={200: ManageTaskSerializer})
    def get(self, request, task_id):
        task = access.manageable_task_or_404(request.user, task_id)
        return _ok(ManageTaskSerializer, _manage_task_payload(task))

    @extend_schema(
        operation_id="reports_manage_tasks_partial_update",
        request=ManageTaskSerializer,
        responses={200: ManageTaskSerializer},
    )
    def patch(self, request, task_id):
        with transaction.atomic():
            task = access.manageable_task_or_404(request.user, task_id, for_update=True)
            serializer = ManageTaskSerializer(task, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            data = serializer.validated_data
            if "course" in data and data["course"] != task.course_id:
                raise ValidationFailed(
                    "A task can't move to another course.", details={"course": ["A task can't move to another course."]}
                )
            has_grades = services.task_has_grades(task)
            criteria_changed = "criteria" in data and _criteria_signature(data["criteria"]) != _criteria_signature(
                list(task.criteria.values("name", "description", "max_marks"))
            )
            marks_changed = "max_marks" in data and services.quantize_marks(data["max_marks"]) != task.max_marks
            if has_grades and (criteria_changed or marks_changed):
                raise Conflict(
                    "Marks have been given for this report, so its maximum marks and rubric can't change.",
                    code="task_has_grades",
                )
            if (
                task.status != ReportTask.STATUS_DRAFT
                and "due_at" in data
                and data["due_at"] <= timezone.now()
                and data["due_at"] != task.due_at
            ):
                raise ValidationFailed(
                    "Choose a deadline in the future.", details={"due_at": ["Choose a deadline in the future."]}
                )
            old_due = task.due_at
            if "section" in data:
                task.section = _resolve_section(task.course_id, data.get("section"))
            _apply_task_fields(task, data)
            criteria = data["criteria"] if "criteria" in data else list(task.criteria.values("max_marks"))
            services.validate_rubric(task.max_marks, criteria)
            task.save()
            if criteria_changed:
                _replace_criteria(task, data["criteria"])
            if task.status == ReportTask.STATUS_PUBLISHED and task.due_at != old_due:
                services.schedule_due_reminder(task)
        return _ok(ManageTaskSerializer, _manage_task_payload(task), message="Report task saved.")

    @extend_schema(operation_id="reports_manage_tasks_destroy", responses={200: None})
    def delete(self, request, task_id):
        with transaction.atomic():
            task = access.manageable_task_or_404(request.user, task_id, for_update=True)
            if task.status != ReportTask.STATUS_DRAFT or task.submissions.exists():
                raise Conflict(
                    "Only drafts without submissions can be deleted. Close it instead.", code="task_not_deletable"
                )
            attachments = list(task.attachments.all())
            for attachment in attachments:
                services.delete_attachment(attachment)
            task.delete()
        return api_response(message="Report task deleted.", data=None)


def _criteria_signature(items):
    return [
        (
            str(item.get("name", "")).strip(),
            str(item.get("description", "") or "").strip(),
            services.quantize_marks(item["max_marks"]),
        )
        for item in items
    ]


class _TaskActionView(_GraderView):
    action_name = ""

    def perform(self, request, task):  # pragma: no cover - overridden
        raise NotImplementedError

    @extend_schema(request=None, responses={200: ManageTaskSerializer})
    def post(self, request, task_id):
        task = access.manageable_task_or_404(request.user, task_id)
        task = self.perform(request, task)
        return _ok(ManageTaskSerializer, _manage_task_payload(task), message=self.message)


class PublishTaskView(_TaskActionView):
    message = "Report published. Students have been notified."

    def perform(self, request, task):
        return services.publish_task(task=task, actor=request.user)


class CloseTaskView(_TaskActionView):
    message = "Report closed. No more submissions are accepted."

    def perform(self, request, task):
        return services.close_task(task=task)


class ReopenTaskView(_TaskActionView):
    message = "Report reopened."

    def perform(self, request, task):
        return services.reopen_task(task=task)


class ReleaseMarksView(_TaskActionView):
    message = "Marks released to students."

    def perform(self, request, task):
        return services.release_marks(task=task, actor=request.user)


class DuplicateTaskView(_TaskActionView):
    message = "Copied as next week's draft."

    @extend_schema(request=None, responses={201: ManageTaskSerializer})
    def post(self, request, task_id):
        task = access.manageable_task_or_404(request.user, task_id)
        copy = services.duplicate_task(task=task, actor=request.user)
        return api_response(
            message=self.message, data=_data(ManageTaskSerializer, _manage_task_payload(copy)), status_code=201
        )


class TaskAttachmentUploadView(_GraderView):
    parser_classes = [MultiPartParser, FormParser]
    throttle_scope = "report_upload"

    @extend_schema(
        operation_id="reports_manage_tasks_attachments_create",
        request={"multipart/form-data": UploadRequestSerializer},
        responses={201: AttachmentUploadResponseSerializer},
    )
    def post(self, request, task_id):
        task = access.manageable_task_or_404(request.user, task_id)
        if task.attachments.count() >= 10:
            raise ValidationFailed(
                "A report can have at most 10 reference files.",
                details={"file": ["A report can have at most 10 reference files."]},
            )
        attachment = services.add_attachment(task=task, uploaded=request.FILES.get("file"), actor=request.user)
        return api_response(
            message="Reference file added.",
            data=_data(AttachmentUploadResponseSerializer, {"attachment": presenters.attachment_dict(attachment)}),
            status_code=201,
        )


class TaskAttachmentDeleteView(_GraderView):
    @extend_schema(operation_id="reports_manage_attachments_destroy", responses={200: None})
    def delete(self, request, attachment_id):
        attachment = ReportAttachment.objects.filter(
            pk=attachment_id, task__in=access.manageable_tasks(request.user)
        ).first()
        if attachment is None:
            raise NotFound("File not found.", code="report_file_not_found")
        services.delete_attachment(attachment)
        return api_response(message="Reference file removed.", data=None)


# ---------------------------------------------------------------------------
# Graders: queue, grading, gradebook, exports
# ---------------------------------------------------------------------------
QUEUE_STATUS_FILTERS = {
    "awaiting": Q(status__in=ReportSubmission.AWAITING_GRADING),
    "ungraded": Q(status__in=ReportSubmission.AWAITING_GRADING),
    **{value: Q(status=value) for value, _label in ReportSubmission.STATUS_CHOICES},
}


def _queue_queryset(request):
    queryset = ReportSubmission.objects.filter(
        task__course__in=access.gradable_courses(request.user), current_version__isnull=False
    ).select_related("task", "task__course", "student", "grade")
    task_id = _int_param(request, "task")
    if task_id:
        queryset = queryset.filter(task_id=task_id)
    course_id = _int_param(request, "course")
    if course_id:
        queryset = queryset.filter(task__course_id=course_id)
    status_filter = str(request.query_params.get("status", "") or "").strip()
    if status_filter in QUEUE_STATUS_FILTERS:
        queryset = queryset.filter(QUEUE_STATUS_FILTERS[status_filter])
    late = str(request.query_params.get("late", "") or "").strip().lower()
    if late in {"1", "true", "yes"}:
        queryset = queryset.filter(is_late=True)
    elif late in {"0", "false", "no"}:
        queryset = queryset.filter(is_late=False)
    search = str(request.query_params.get("q", "") or "").strip()[:80]
    if search:
        queryset = queryset.filter(Q(student__full_name__icontains=search) | Q(student__email__icontains=search))
    # Oldest submissions first: fair marking order.
    return queryset.order_by("submitted_at", "id")


QUEUE_PARAMETERS = [
    OpenApiParameter("task", int, required=False),
    OpenApiParameter("course", int, required=False),
    OpenApiParameter(
        "status",
        str,
        required=False,
        description="awaiting, submitted, under_review, graded, returned_for_revision, resubmitted",
    ),
    OpenApiParameter("late", bool, required=False),
    OpenApiParameter("q", str, required=False, description="Student name or email"),
]


class SubmissionQueueView(_GraderView):
    @extend_schema(
        operation_id="reports_manage_submissions_list",
        parameters=QUEUE_PARAMETERS,
        responses={200: SubmissionQueueSerializer},
    )
    def get(self, request):
        queryset = _queue_queryset(request)
        stats = queryset.aggregate(
            submitted=Count("id"),
            awaiting=Count("id", filter=Q(status__in=ReportSubmission.AWAITING_GRADING)),
            graded=Count("id", filter=Q(status=ReportSubmission.STATUS_GRADED)),
            returned=Count("id", filter=Q(status=ReportSubmission.STATUS_RETURNED)),
            late=Count("id", filter=Q(is_late=True)),
        )
        task_id = _int_param(request, "task")
        students = 0
        if task_id:
            task = access.manageable_tasks(request.user).select_related("course").filter(pk=task_id).first()
            students = len(services.active_student_ids(task.course)) if task else 0
        counts = {"students": students, **{key: int(value or 0) for key, value in stats.items()}}
        results = [presenters.queue_item(item) for item in queryset[:500]]
        return _ok(SubmissionQueueSerializer, {"results": results, "counts": counts})


def _neighbours(request, submission):
    ids = list(_queue_queryset(request).values_list("id", "status"))
    order = [item_id for item_id, _status in ids]
    position = order.index(submission.pk) if submission.pk in order else None
    previous_id = order[position - 1] if position not in (None, 0) else None
    next_id = order[position + 1] if position is not None and position + 1 < len(order) else None
    awaiting = set(ReportSubmission.AWAITING_GRADING)
    after = ids[position + 1 :] if position is not None else ids
    before = ids[:position] if position is not None else []
    next_ungraded = next(
        (item_id for item_id, status in after + before if status in awaiting and item_id != submission.pk), None
    )
    return {
        "previous_id": previous_id,
        "next_id": next_id,
        "next_ungraded_id": next_ungraded,
        "position": (position + 1) if position is not None else None,
        "total": len(order),
    }


class SubmissionDetailView(_GraderView):
    @extend_schema(
        operation_id="reports_manage_submissions_retrieve",
        parameters=QUEUE_PARAMETERS,
        responses={200: SubmissionDetailSerializer},
    )
    def get(self, request, submission_id):
        submission = access.manageable_submission_or_404(request.user, submission_id)
        return _ok(
            SubmissionDetailSerializer, presenters.submission_detail(submission, _neighbours(request, submission))
        )


class GradeSubmissionView(_GraderView):
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    throttle_scope = "report_grade"

    @extend_schema(
        operation_id="reports_manage_submissions_grade_create",
        parameters=QUEUE_PARAMETERS,
        request={"application/json": GradeRequestSerializer, "multipart/form-data": GradeRequestSerializer},
        responses={200: SubmissionDetailSerializer},
    )
    def post(self, request, submission_id):
        submission = access.manageable_submission_or_404(request.user, submission_id)
        serializer = GradeRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        services.save_grade(
            submission_id=submission.pk,
            grader=request.user,
            action=data["action"],
            expected_revision=data["expected_revision"],
            marks=data.get("marks"),
            criteria_marks=data.get("criteria_marks") or {},
            feedback=data.get("feedback", ""),
            annotated_file=data.get("annotated_file"),
            remove_annotated_file=data.get("remove_annotated_file", False),
        )
        submission = access.manageable_submission_or_404(request.user, submission_id)
        messages = {
            "draft": "Draft saved. The student can't see it yet.",
            "grade": "Marks saved.",
            "return": "Returned to the student for revision.",
        }
        return _ok(
            SubmissionDetailSerializer,
            presenters.submission_detail(submission, _neighbours(request, submission)),
            message=messages[data["action"]],
        )


class GradebookView(_GraderView):
    @extend_schema(
        operation_id="reports_manage_gradebook_retrieve",
        parameters=[OpenApiParameter("course", int, required=True)],
        responses={200: GradebookSerializer},
    )
    def get(self, request):
        course_id = _int_param(request, "course")
        course = access.gradable_courses(request.user).filter(pk=course_id).first() if course_id else None
        if course is None:
            raise NotFound("Course not found.", code="course_not_found")
        book = services.course_gradebook(course)
        payload = {
            "course": presenters.ref(course),
            "tasks": [presenters.gradebook_task_dict(task) for task in book["tasks"]],
            "rows": [
                {"student": presenters.person(row["student"]), "cells": row["cells"], "totals": row["totals"]}
                for row in book["rows"]
            ],
        }
        return _ok(GradebookSerializer, payload)


class MarksExportView(_GraderView):
    throttle_scope = "report_export"

    @extend_schema(
        operation_id="reports_manage_export_csv",
        parameters=[OpenApiParameter("course", int, required=False), OpenApiParameter("task", int, required=False)],
        responses={(200, "text/csv"): OpenApiTypes.STR},
    )
    def get(self, request):
        task_id = _int_param(request, "task")
        course_id = _int_param(request, "course")
        stamp = timezone.localtime().strftime("%Y%m%d-%H%M")
        if task_id:
            task = access.manageable_task_or_404(request.user, task_id)
            content = task_marks_csv(task)
            filename = f"report-marks-{safe_component(task.title, 'task', 40)}-{stamp}.csv"
        elif course_id:
            course = access.gradable_courses(request.user).filter(pk=course_id).first()
            if course is None:
                raise NotFound("Course not found.", code="course_not_found")
            content = course_marks_csv(course)
            filename = f"report-marks-{safe_component(course.title, 'course', 40)}-{stamp}.csv"
        else:
            raise ValidationFailed(
                "Choose a course or a report task.", details={"course": ["Choose a course or a report task."]}
            )
        response = HttpResponse(content.encode("utf-8"), content_type="text/csv; charset=utf-8")
        ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "report-marks.csv"
        response["Content-Disposition"] = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "private, no-store"
        return response


class TaskZipDownloadView(_GraderView):
    throttle_scope = "report_export"

    @extend_schema(
        operation_id="reports_manage_tasks_download_zip", responses={(200, "application/zip"): OpenApiTypes.BINARY}
    )
    def get(self, request, task_id):
        task = access.manageable_task_or_404(request.user, task_id)
        if not ReportSubmission.objects.filter(task=task, current_version__isnull=False).exists():
            raise NotFound("No submissions to download yet.", code="no_submissions")
        stamp = timezone.localtime().strftime("%Y%m%d-%H%M")
        filename = f"reports-{safe_component(task.title, 'task', 40)}-{stamp}.zip"
        response = StreamingHttpResponse(iter_task_zip(task), content_type="application/zip")
        ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "reports.zip"
        response["Content-Disposition"] = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "private, no-store"
        # nginx must not buffer the whole archive before sending it.
        response["X-Accel-Buffering"] = "no"
        return response
