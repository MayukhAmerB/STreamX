"""HTTP mapping for Console -> Exams (``/api/ctf-admin/``).

Deliberately NOT under ``/api/ctf/``: that prefix is open to the labs origin
(CORS + labs-scoped writes, ``config/labs_origin.py``), and nothing a labs
page can reach should be able to upload or publish an exam.

* Staff (``is_staff``/superuser): everything.
* Instructors: read-only list, detail and results for the batches they teach.
* Students: 403.
"""

from __future__ import annotations

from config.audit import log_security_event
from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from django.db.models import Prefetch
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.views import APIView

from apps.core.errors import NotFound, ValidationFailed
from apps.courses.models import Course

from . import access, console, exports, materials
from .answers import CtfNotConfigured
from .console_serializers import (
    BatchListSerializer,
    ConsoleExamDetailSerializer,
    ConsoleExamListSerializer,
    ConsoleSummarySerializer,
    ExamUpdateSerializer,
    ExamUploadSerializer,
    MaterialUploadedSerializer,
    MaterialUploadSerializer,
    ResultsSerializer,
    UploadResponseSerializer,
)
from .loader import MAX_FILE_BYTES
from .models import CtfExam, CtfMaterial, CtfParticipation


def _ok(serializer_class, payload, message="", status_code=200):
    return api_response(message=message, data=serializer_class(payload).data, status_code=status_code)


class _ConsoleView(APIView):
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "ctf_read"
    parser_classes = [JSONParser]


def _audit(request, event, exam_slug, **fields):
    log_security_event(event, request=request, exam=exam_slug, **fields)


class ConsoleExamListView(_ConsoleView):
    @extend_schema(operation_id="ctf_admin_exams_list", responses={200: ConsoleExamListSerializer})
    def get(self, request):
        access.require_console_reader(request.user)
        now = timezone.now()
        exams = access.console_exams(request.user).prefetch_related(
            Prefetch("eligible_courses", queryset=Course.objects.order_by("title"))
        )
        exams = exams.order_by("-opens_at", "-id")[:200]
        rows = [console.exam_row(exam, user=request.user, at=now) for exam in exams]
        return _ok(
            ConsoleExamListSerializer,
            {"results": rows, "can_manage": access.is_staff_user(request.user), "server_time": now},
        )


def _read_upload(request):
    serializer = ExamUploadSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    upload = serializer.validated_data.get("file")
    if upload is not None:
        if upload.size > MAX_FILE_BYTES:
            raise ValidationFailed(
                "The exam file is larger than 5 MB.",
                code="ctf_exam_file_invalid",
                details={"problems": ["the exam file is larger than 5 MB"]},
            )
        raw = upload.read(MAX_FILE_BYTES + 1)
    else:
        raw = serializer.validated_data["content"].encode("utf-8")
    return raw, serializer.validated_data.get("allow_content_change", False)


class _UploadBase(_ConsoleView):
    throttle_scope = "ctf_attempt"
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    dry_run = True

    def post(self, request):
        access.require_staff(request.user)
        raw, allow_change = _read_upload(request)
        try:
            report, exam = console.run_upload(raw, dry_run=self.dry_run, allow_content_change=allow_change)
        except CtfNotConfigured:
            raise
        if not self.dry_run:
            _audit(request, "ctf.exam_uploaded", report["slug"], created=report["exam_created"])
        detail = console.exam_detail(exam, user=request.user) if exam is not None and not self.dry_run else None
        message = "Dry run: nothing was saved." if self.dry_run else "Exam file loaded."
        return _ok(UploadResponseSerializer, {"report": report, "exam": detail}, message=message)


class ConsoleExamPreviewView(_UploadBase):
    """Validate and diff an exam file without saving anything (counts only)."""

    dry_run = True

    @extend_schema(
        operation_id="ctf_admin_exams_preview_create",
        request={"multipart/form-data": ExamUploadSerializer, "application/json": ExamUploadSerializer},
        responses={200: UploadResponseSerializer},
    )
    def post(self, request):
        return super().post(request)


class ConsoleExamUploadView(_UploadBase):
    dry_run = False

    @extend_schema(
        operation_id="ctf_admin_exams_upload_create",
        request={"multipart/form-data": ExamUploadSerializer, "application/json": ExamUploadSerializer},
        responses={200: UploadResponseSerializer},
    )
    def post(self, request):
        return super().post(request)


class ConsoleExamDetailView(_ConsoleView):
    @extend_schema(operation_id="ctf_admin_exams_retrieve", responses={200: ConsoleExamDetailSerializer})
    def get(self, request, slug):
        access.require_console_reader(request.user)
        exam = access.console_exam_or_404(request.user, slug)
        return _ok(ConsoleExamDetailSerializer, console.exam_detail(exam, user=request.user))

    @extend_schema(
        operation_id="ctf_admin_exams_partial_update",
        request=ExamUpdateSerializer,
        responses={200: ConsoleExamDetailSerializer},
    )
    def patch(self, request, slug):
        access.require_staff(request.user)
        exam = access.console_exam_or_404(request.user, slug)
        serializer = ExamUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        exam = console.update_exam(exam, serializer.validated_data)
        _audit(request, "ctf.exam_updated", exam.slug, fields=sorted(serializer.validated_data))
        return _ok(ConsoleExamDetailSerializer, console.exam_detail(exam, user=request.user), message="Saved.")


class _ExamActionView(_ConsoleView):
    throttle_scope = "ctf_attempt"
    action_name = ""

    def act(self, exam):  # pragma: no cover - overridden
        raise NotImplementedError

    def post(self, request, slug):
        access.require_staff(request.user)
        exam = access.console_exam_or_404(request.user, slug)
        exam, message = self.act(exam)
        _audit(request, f"ctf.exam_{self.action_name}", exam.slug, state=console.exam_state(exam))
        return _ok(ConsoleExamDetailSerializer, console.exam_detail(exam, user=request.user), message=message)


class ConsoleExamPublishView(_ExamActionView):
    action_name = "published"

    def act(self, exam):
        exam = console.publish_exam(exam)
        if exam.status == CtfExam.STATUS_PUBLISHED:
            return exam, "Published. Students have been notified."
        return exam, "Scheduled. It will publish itself at the opening time."

    @extend_schema(operation_id="ctf_admin_exams_publish_create", request=None, responses={200: ConsoleExamDetailSerializer})
    def post(self, request, slug):
        return super().post(request, slug)


class ConsoleExamUnscheduleView(_ExamActionView):
    action_name = "unscheduled"

    def act(self, exam):
        return console.unschedule_exam(exam), "Back to draft: it will not publish itself."

    @extend_schema(
        operation_id="ctf_admin_exams_unschedule_create", request=None, responses={200: ConsoleExamDetailSerializer}
    )
    def post(self, request, slug):
        return super().post(request, slug)


class ConsoleExamCloseView(_ExamActionView):
    action_name = "closed"

    def act(self, exam):
        return console.close_exam(exam), "Closed. Results are in the gradebook."

    @extend_schema(operation_id="ctf_admin_exams_close_create", request=None, responses={200: ConsoleExamDetailSerializer})
    def post(self, request, slug):
        return super().post(request, slug)


class ConsoleExamResultsView(_ConsoleView):
    @extend_schema(operation_id="ctf_admin_exams_results_retrieve", responses={200: ResultsSerializer})
    def get(self, request, slug):
        access.require_console_reader(request.user)
        exam = access.console_exam_or_404(request.user, slug)
        return _ok(ResultsSerializer, console.results(exam, user=request.user))


class ConsoleExamResultsCsvView(_ConsoleView):
    throttle_scope = "report_export"

    @extend_schema(
        operation_id="ctf_admin_exams_results_csv_retrieve",
        responses={(200, "text/csv"): OpenApiTypes.STR},
    )
    def get(self, request, slug):
        access.require_console_reader(request.user)
        exam = access.console_exam_or_404(request.user, slug)
        queryset = CtfParticipation.objects.filter(exam=exam, is_staff_preview=False).order_by(
            "-score", "last_correct_at", "started_at", "id"
        )
        scope = access.result_course_scope(request.user)
        if scope is not None:
            queryset = queryset.filter(batch_course_id__in=scope)
        _audit(request, "ctf.results_exported", exam.slug)
        return exports.csv_response(
            # Owner rule (Console): handles only. The full-identity CSV is in admin -> Examination.
            exports.iter_participations_csv(queryset, console=True),
            exports.export_filename("ctf-results", exam.slug),
        )


class ConsoleMaterialUploadView(_ConsoleView):
    throttle_scope = "ctf_attempt"
    parser_classes = [MultiPartParser, FormParser]

    @extend_schema(
        operation_id="ctf_admin_exams_materials_create",
        request={"multipart/form-data": MaterialUploadSerializer},
        responses={201: MaterialUploadedSerializer},
    )
    def post(self, request, slug):
        access.require_staff(request.user)
        exam = access.console_exam_or_404(request.user, slug)
        serializer = MaterialUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        material = materials.save_upload(
            exam=exam,
            path=serializer.validated_data["path"],
            uploaded_file=serializer.validated_data["file"],
            user=request.user,
        )
        _audit(request, "ctf.material_uploaded", exam.slug, path=material.path, sha256=material.sha256[:16])
        payload = {"material_id": material.pk, "path": material.path, "size": material.size, "sha256": material.sha256}
        return _ok(MaterialUploadedSerializer, payload, message="Evidence file uploaded.", status_code=201)


class ConsoleMaterialDeleteView(_ConsoleView):
    throttle_scope = "ctf_attempt"

    @extend_schema(operation_id="ctf_admin_exams_materials_destroy", responses={204: None})
    def delete(self, request, slug, material_id):
        access.require_staff(request.user)
        exam = access.console_exam_or_404(request.user, slug)
        material = CtfMaterial.objects.filter(exam=exam, pk=material_id).first()
        if material is None:
            raise NotFound("Evidence file not found.", code="ctf_material_not_found")
        _audit(request, "ctf.material_deleted", exam.slug, path=material.path)
        materials.delete_material(material)
        return api_response(message="Evidence file removed.", data=None, status_code=204)


class ConsoleBatchListView(_ConsoleView):
    @extend_schema(operation_id="ctf_admin_batches_list", responses={200: BatchListSerializer})
    def get(self, request):
        access.require_staff(request.user)
        return _ok(BatchListSerializer, {"results": console.batch_options()})


class ConsoleSummaryView(_ConsoleView):
    """The staff Console card: exams open now and scheduled."""

    @extend_schema(operation_id="ctf_admin_summary_retrieve", responses={200: ConsoleSummarySerializer})
    def get(self, request):
        access.require_staff(request.user)
        return _ok(ConsoleSummarySerializer, console.open_exam_summary())
