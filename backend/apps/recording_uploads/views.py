"""HTTP API for resumable class recording uploads and personal upload tokens.

Upload endpoints accept the Console session (cookie JWT + CSRF) or a personal
upload token (``X-Upload-Token``, desktop uploader). Token management accepts
the Console session only, so a token can never create or list tokens.
"""

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import OpenApiParameter, OpenApiTypes, extend_schema
from rest_framework import permissions, status
from rest_framework.views import APIView

from config.authentication import CookieJWTAuthentication
from config.response import api_response

from . import services, tokens
from .models import RecordingUpload, RecordingUploadToken
from .serializers import (
    ChunkAckResponseSerializer,
    CreatedUploadTokenResponseSerializer,
    RevertSerializer,
    TokenCreateSerializer,
    UploadCreateSerializer,
    UploadListResponseSerializer,
    UploadResponseSerializer,
    UploadTargetListResponseSerializer,
    UploadTokenListResponseSerializer,
    UploadTokenResponseSerializer,
)

TAGS = ("Recording uploads",)
RECENT_UPLOADS = 20


class CanUploadRecordings(permissions.BasePermission):
    message = "Only instructors and admins can upload class recordings."

    def has_permission(self, request, view):
        return tokens.can_upload_recordings(request.user)


class IsStaffUser(permissions.BasePermission):
    message = "Only admins can switch a lecture's video."

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def _via_token(request):
    return isinstance(request.auth, RecordingUploadToken)


class _UploadAPIView(APIView):
    authentication_classes = [tokens.RecordingUploadTokenAuthentication, CookieJWTAuthentication]
    permission_classes = [permissions.IsAuthenticated, CanUploadRecordings]


class _TokenAPIView(APIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [permissions.IsAuthenticated, CanUploadRecordings]


def _validation_failed(serializer):
    return api_response(
        success=False, message="Invalid request.", errors=serializer.errors, status_code=status.HTTP_400_BAD_REQUEST
    )


def _token_payload(token, raw=None):
    payload = {
        "id": token.pk,
        "name": token.name,
        "prefix": token.prefix,
        "created_at": token.created_at,
        "last_used_at": token.last_used_at,
        "expires_at": token.expires_at,
        "revoked_at": token.revoked_at,
        "active": tokens.token_is_usable(token),
    }
    if raw is not None:
        payload["token"] = raw
    return payload


class UploadTargetsView(_UploadAPIView):
    throttle_scope = "recording_upload_read"

    @extend_schema(
        operation_id="recording_upload_targets",
        tags=TAGS,
        description=(
            "Classes the caller may upload a recording to (live first, then recent), with what an upload "
            "would do: replace the class's recording lecture video or create the lecture. latest=1 returns "
            "only the class a desktop upload without session_id is attached to."
        ),
        parameters=[OpenApiParameter("latest", OpenApiTypes.BOOL, required=False)],
        responses={200: UploadTargetListResponseSerializer},
    )
    def get(self, request):
        if str(request.query_params.get("latest") or "").lower() in {"1", "true", "yes"}:
            session = services.latest_session_for(request.user)
            data = [services.describe_target(session)] if session is not None else []
        else:
            data = services.upload_targets(request.user)
        return api_response(message="Upload targets fetched.", data=data)


class UploadListCreateView(_UploadAPIView):
    throttle_scope = "recording_upload_create"

    def get_throttles(self):
        if self.request.method == "GET":
            self.throttle_scope = "recording_upload_read"
        return super().get_throttles()

    @extend_schema(
        operation_id="recording_uploads_list",
        tags=TAGS,
        description="The caller's recent uploads (newest first), unfinished ones included for resuming.",
        responses={200: UploadListResponseSerializer},
    )
    def get(self, request):
        uploads = RecordingUpload.objects.filter(owner=request.user).select_related("session", "lecture__section")[
            :RECENT_UPLOADS
        ]
        return api_response(message="Uploads fetched.", data=[services.upload_payload(item) for item in uploads])

    @extend_schema(
        operation_id="recording_uploads_create",
        tags=TAGS,
        description=(
            "Start a resumable upload (or resume the unfinished upload of the same file: same class, name, "
            "size and, when both give one, SHA-256). Then PUT every chunk and POST complete."
        ),
        request=UploadCreateSerializer,
        responses={200: UploadResponseSerializer, 201: UploadResponseSerializer},
    )
    def post(self, request):
        serializer = UploadCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return _validation_failed(serializer)
        values = serializer.validated_data
        upload, created = services.create_upload(
            user=request.user,
            session_id=values.get("session_id"),
            filename=values["filename"],
            total_bytes=values["size"],
            sha256=values.get("sha256") or "",
            content_type=values.get("content_type") or "",
            token=request.auth if _via_token(request) else None,
        )
        upload = RecordingUpload.objects.select_related("session", "lecture__section").get(pk=upload.pk)
        return api_response(
            message="Upload started." if created else "Resuming the unfinished upload of this file.",
            data=services.upload_payload(upload),
            status_code=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class UploadDetailView(_UploadAPIView):
    throttle_scope = "recording_upload_read"

    @extend_schema(operation_id="recording_uploads_retrieve", tags=TAGS, responses={200: UploadResponseSerializer})
    def get(self, request, upload_id):
        upload = services.get_owned(upload_id, request.user)
        return api_response(message="Upload fetched.", data=services.upload_payload(upload))

    @extend_schema(
        operation_id="recording_uploads_abort",
        tags=TAGS,
        description="Cancel an unfinished upload and delete its chunks.",
        responses={200: UploadResponseSerializer},
    )
    def delete(self, request, upload_id):
        upload = services.abort_upload(upload_id=upload_id, user=request.user)
        return api_response(message="Upload cancelled.", data=services.upload_payload(upload))


class UploadChunkView(_UploadAPIView):
    """PUT one chunk as the raw request body (application/octet-stream).

    The body is streamed to the private staging directory in 1 MiB blocks
    (never request.body / request.data). Headers: ``Content-Length`` (must be
    the chunk's exact size) and optionally ``X-Chunk-Sha256``.
    """

    throttle_scope = "recording_upload_chunk"

    @extend_schema(
        operation_id="recording_uploads_put_chunk",
        tags=TAGS,
        request={"application/octet-stream": OpenApiTypes.BINARY},
        parameters=[
            OpenApiParameter("X-Chunk-Sha256", OpenApiTypes.STR, OpenApiParameter.HEADER, required=False),
        ],
        responses={200: ChunkAckResponseSerializer},
    )
    def put(self, request, upload_id, index):
        raw_length = request.META.get("CONTENT_LENGTH")
        try:
            content_length = int(raw_length) if raw_length not in (None, "") else None
        except (TypeError, ValueError):
            content_length = None
        upload, duplicate = services.put_chunk(
            upload_id=upload_id,
            user=request.user,
            index=index,
            stream=request._request,  # the Django request: read() in blocks, never .body
            content_length=content_length,
            declared_sha256=request.META.get("HTTP_X_CHUNK_SHA256", ""),
        )
        return api_response(
            message="Chunk already stored." if duplicate else "Chunk stored.",
            data={
                "index": index,
                "duplicate": duplicate,
                "received_count": upload.received_count,
                "received_bytes": upload.received_bytes,
                "chunk_count": upload.chunk_count,
                "complete": upload.received_count == upload.chunk_count,
            },
        )


class UploadCompleteView(_UploadAPIView):
    throttle_scope = "recording_upload_create"

    @extend_schema(
        operation_id="recording_uploads_complete",
        tags=TAGS,
        description=(
            "All chunks are in: queue the server to assemble, verify and publish the recording. Answers at "
            "once (202); poll the upload until it is completed or failed. Calling it again is harmless."
        ),
        request=None,
        responses={202: UploadResponseSerializer},
    )
    def post(self, request, upload_id):
        upload, _queued = services.request_complete(upload_id=upload_id, user=request.user)
        upload = RecordingUpload.objects.select_related("session", "lecture__section").get(pk=upload.pk)
        return api_response(
            message="Upload received. The recording is being processed.",
            data=services.upload_payload(upload),
            status_code=status.HTTP_202_ACCEPTED,
        )


class UploadSwitchVideoView(APIView):
    authentication_classes = [CookieJWTAuthentication]
    permission_classes = [permissions.IsAuthenticated, IsStaffUser]
    throttle_scope = "recording_upload_create"

    @extend_schema(
        operation_id="recording_uploads_switch_video",
        tags=TAGS,
        description=(
            "Admin: put the auto-recording (replaced video) back into the lecture, or switch to the uploaded "
            "video again. The lecture, its progress and comments are kept; the stream is rebuilt."
        ),
        request=RevertSerializer,
        responses={200: UploadResponseSerializer},
    )
    def post(self, request, upload_id):
        serializer = RevertSerializer(data=request.data)
        if not serializer.is_valid():
            return _validation_failed(serializer)
        upload = get_object_or_404(RecordingUpload, pk=upload_id)
        restore = serializer.validated_data["restore_upload"]
        upload = services.switch_video(upload, user=request.user, restore_upload=restore)
        upload = RecordingUpload.objects.select_related("session", "lecture__section").get(pk=upload.pk)
        return api_response(
            message="The uploaded video is back." if restore else "The previous video is back.",
            data=services.upload_payload(upload),
        )


class UploadTokenListCreateView(_TokenAPIView):
    throttle_scope = "recording_upload_token"

    def get_throttles(self):
        if self.request.method == "GET":
            self.throttle_scope = "recording_upload_read"
        return super().get_throttles()

    @extend_schema(operation_id="recording_upload_tokens_list", tags=TAGS, responses={200: UploadTokenListResponseSerializer})
    def get(self, request):
        items = RecordingUploadToken.objects.filter(owner=request.user)[:50]
        return api_response(message="Upload tokens fetched.", data=[_token_payload(item) for item in items])

    @extend_schema(
        operation_id="recording_upload_tokens_create",
        tags=TAGS,
        description="Create a personal upload token for the desktop uploader. The token is shown once.",
        request=TokenCreateSerializer,
        responses={201: CreatedUploadTokenResponseSerializer},
    )
    def post(self, request):
        serializer = TokenCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return _validation_failed(serializer)
        active = RecordingUploadToken.objects.filter(owner=request.user, revoked_at__isnull=True).count()
        if active >= 10:
            raise services.UploadError(
                "You already have 10 active upload tokens. Revoke one first.", code="too_many_tokens", status=409
            )
        token, raw = tokens.create_token(
            request.user,
            serializer.validated_data["name"],
            expires_in_days=serializer.validated_data.get("expires_in_days"),
        )
        return api_response(
            message="Upload token created. Copy it now: it is not shown again.",
            data=_token_payload(token, raw),
            status_code=status.HTTP_201_CREATED,
        )


class UploadTokenRevokeView(_TokenAPIView):
    throttle_scope = "recording_upload_token"

    @extend_schema(operation_id="recording_upload_tokens_revoke", tags=TAGS, responses={200: UploadTokenResponseSerializer})
    def delete(self, request, token_id):
        queryset = RecordingUploadToken.objects.all()
        if not (request.user.is_staff or request.user.is_superuser):
            queryset = queryset.filter(owner=request.user)
        token = get_object_or_404(queryset, pk=token_id)
        tokens.revoke_token(token)
        return api_response(message="Upload token revoked.", data=_token_payload(token))
