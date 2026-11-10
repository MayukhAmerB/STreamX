"""HTTP mapping for class recordings and the module picker."""

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import permissions, status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.views import APIView

from apps.courses.models import Course, LiveClass, Section
from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle

from ..models import RealtimeSession
from . import replacement, services
from .models import ClassRecording
from .serializers import (
    ClassRecordingListResponseSerializer,
    ClassRecordingResponseSerializer,
    ClassRecordingSerializer,
    ModuleOptionsResponseSerializer,
    ObsUploadSerializer,
)

TAGS = ("Class recordings",)


def _denied(detail):
    return api_response(
        success=False,
        message="Access denied.",
        errors={"detail": detail},
        status_code=status.HTTP_403_FORBIDDEN,
    )


def _bad_request(message, errors):
    return api_response(success=False, message=message, errors=errors, status_code=status.HTTP_400_BAD_REQUEST)


def _recordings_queryset():
    return ClassRecording.objects.select_related("module", "lecture", "session")


class ModuleOptionsView(APIView):
    """Modules of a course for the "target module" picker (admins and the course instructor)."""

    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(
        operation_id="realtime_module_options",
        tags=TAGS,
        parameters=[
            OpenApiParameter("live_class_id", int, required=False, description="Resolve the course from a live class."),
            OpenApiParameter("course_id", int, required=False),
        ],
        responses={200: ModuleOptionsResponseSerializer, 400: ModuleOptionsResponseSerializer, 403: ModuleOptionsResponseSerializer},
    )
    def get(self, request):
        live_class_id = str(request.query_params.get("live_class_id") or "").strip()
        course_id = str(request.query_params.get("course_id") or "").strip()
        if live_class_id.isdigit():
            live_class = get_object_or_404(LiveClass.objects.select_related("linked_course"), pk=int(live_class_id))
            course = live_class.linked_course
        elif course_id.isdigit():
            course = get_object_or_404(Course, pk=int(course_id))
        else:
            return _bad_request("Invalid request query.", {"detail": "Provide live_class_id or course_id."})
        if course is None:
            return _bad_request("No course.", {"detail": "This live class is not linked to a course."})
        user = request.user
        if not (user.is_staff or user.is_superuser or course.instructor_id == user.id):
            return _denied("Only admins or the course instructor can list its modules.")
        modules = (
            Section.objects.filter(course=course)
            .annotate(lecture_count=Count("lectures", filter=Q(lectures__is_published=True)))
            .order_by("order", "id")
        )
        return api_response(
            message="Modules fetched.",
            data={
                "course": {"id": course.id, "title": course.title},
                "modules": [
                    {
                        "id": module.id,
                        "title": module.title,
                        "description": module.description,
                        "order": module.order,
                        "lecture_count": module.lecture_count,
                    }
                    for module in modules
                ],
            },
        )


class SessionClassRecordingListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(
        operation_id="realtime_session_class_recordings_list",
        tags=TAGS,
        responses={200: ClassRecordingListResponseSerializer, 403: ClassRecordingListResponseSerializer},
    )
    def get(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.with_related(), pk=pk)
        if not session.is_moderator_allowed(request.user):
            return _denied("Only host, assigned instructor, or admin can view class recordings.")
        recordings = _recordings_queryset().filter(session=session).order_by("-created_at", "-id")
        return api_response(
            message="Class recordings fetched.",
            data=ClassRecordingSerializer(recordings, many=True).data,
        )


class _ObsUploadBase(APIView):
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]
    throttle_classes = [ClientIpScopedRateThrottle]
    throttle_scope = "class_recording_upload"

    def _upload(self, request, session, recording=None):
        if not session.is_moderator_allowed(request.user):
            return _denied("Only host, assigned instructor, or admin can upload class recordings.")
        serializer = ObsUploadSerializer(data=request.data)
        if not serializer.is_valid():
            return _bad_request("Recording upload failed.", serializer.errors)
        try:
            created = replacement.replace_with_obs_upload(
                session=session,
                uploaded_file=serializer.validated_data["video_file"],
                user=request.user,
                recording=recording,
                request=request,
            )
        except DjangoValidationError as exc:
            return _bad_request(
                "Recording upload failed.",
                getattr(exc, "message_dict", None) or {"detail": exc.messages},
            )
        created = _recordings_queryset().get(pk=created.pk)
        message = "OBS recording uploaded. The lecture will be re-processed and stays in place."
        if created.state == ClassRecording.STATE_FINALIZING:
            message = (
                "OBS recording uploaded. It is converted to MP4 on the server first; the lecture is then "
                "re-processed and stays in place."
            )
        return api_response(
            message=message,
            data=ClassRecordingSerializer(created).data,
            status_code=status.HTTP_201_CREATED,
        )


_UPLOAD_SCHEMA = dict(
    tags=TAGS,
    request={"multipart/form-data": ObsUploadSerializer},
    responses={
        201: ClassRecordingResponseSerializer,
        400: ClassRecordingResponseSerializer,
        403: ClassRecordingResponseSerializer,
    },
)


class SessionObsUploadView(_ObsUploadBase):
    @extend_schema(
        operation_id="realtime_session_class_recording_obs_upload",
        description=(
            "Upload the file OBS saved locally. Replaces the video of the session's latest class-recording "
            "lecture (same lecture id, likes, comments, views), or creates the lecture in the session's "
            "target module when no recording exists."
        ),
        **_UPLOAD_SCHEMA,
    )
    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.with_related(), pk=pk)
        return self._upload(request, session)


class ClassRecordingObsUploadView(_ObsUploadBase):
    @extend_schema(
        operation_id="realtime_class_recording_obs_upload",
        description="Replace this recording's lecture video with the OBS file (lecture identity is kept).",
        **_UPLOAD_SCHEMA,
    )
    def post(self, request, recording_id):
        recording = get_object_or_404(_recordings_queryset(), pk=recording_id)
        if recording.session is None:
            return _bad_request("Recording upload failed.", {"detail": "Recording has no session."})
        return self._upload(request, recording.session, recording=recording)


class ClassRecordingRetryView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    @extend_schema(
        operation_id="realtime_class_recording_retry",
        tags=TAGS,
        request=None,
        responses={200: ClassRecordingResponseSerializer, 400: ClassRecordingResponseSerializer, 403: ClassRecordingResponseSerializer},
    )
    def post(self, request, recording_id):
        recording = get_object_or_404(_recordings_queryset(), pk=recording_id)
        if recording.session is None or not recording.session.is_moderator_allowed(request.user):
            return _denied("Only host, assigned instructor, or admin can retry class recordings.")
        if not services.can_retry(recording) or not services.retry(recording, request=request):
            return _bad_request("Retry not possible.", {"detail": f"Recording is {recording.state}; only failed recordings can be retried."})
        recording.refresh_from_db()
        return api_response(message="Class recording queued for retry.", data=ClassRecordingSerializer(recording).data)

