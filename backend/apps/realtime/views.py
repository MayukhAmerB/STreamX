import logging
import mimetypes
import time

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.http import FileResponse
from django.http.response import HttpResponseRedirect
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.authentication import SessionAuthentication
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from config.audit import log_security_event
from config.authentication import CookieJWTAuthentication
from config.metrics import record_realtime_join, record_realtime_recording_operation
from config.request_security import find_disallowed_query_params
from config.response import api_response

from .domain import (
    build_permission_set,
    get_access_decision,
    list_queryset,
    resolve_participant_state,
    session_payload_for_create,
)
from .models import RealtimeConfiguration, RealtimeSession, RealtimeSessionRecording
from .serializers import (
    RealtimeSessionBrowserRecordingUploadSerializer,
    RealtimeSessionCreateSerializer,
    RealtimeSessionJoinSerializer,
    RealtimeSessionListSerializer,
    RealtimeSessionRecordingSerializer,
    RealtimePresenterPermissionSerializer,
)
from .services import (
    build_participant_metadata,
    cache_room_participant_count,
    delete_recording_assets,
    LiveKitEgressError,
    LiveKitConfigError,
    build_recording_filepath,
    build_host_publisher_identity,
    build_host_publisher_token,
    build_meet_embed_url,
    build_participant_token,
    extract_recording_output,
    get_room_participant_count,
    is_livekit_configured,
    resolve_recording_local_path,
    resolve_livekit_client_url,
    resolve_broadcast_urls,
    start_room_recording_egress,
    start_room_broadcast_egress,
    stop_room_recording_egress,
    stop_room_broadcast_egress,
)

User = get_user_model()
realtime_ops_logger = logging.getLogger("ops.realtime")


def _can_manage_session(user, session):
    return bool(getattr(session, "is_moderator_allowed", None) and session.is_moderator_allowed(user))


def _build_session_list_cache_key(*, user_id, is_admin, session_type, status_filter):
    normalized_session_type = session_type or "-"
    normalized_status = status_filter or "-"
    return (
        "realtime-session-list:"
        f"user={user_id}:"
        f"admin={1 if is_admin else 0}:"
        f"session_type={normalized_session_type}:"
        f"status={normalized_status}"
    )


def _emit_realtime_telemetry(
    *,
    event,
    level,
    request,
    session,
    participant_state,
    **extra,
):
    if not bool(getattr(settings, "REALTIME_TELEMETRY_ENABLED", True)):
        return
    window_seconds = max(10, int(getattr(settings, "REALTIME_TELEMETRY_LOG_WINDOW_SECONDS", 60)))
    throttle_key = f"realtime-telemetry:{event}:session={session.id}"
    if not cache.add(throttle_key, 1, timeout=window_seconds):
        return

    payload = {
        "event": event,
        "request_id": getattr(request, "request_id", None),
        "session_id": session.id,
        "session_type": session.session_type,
        "status": session.status,
        "meeting_capacity": session.meeting_capacity,
        "participant_count": participant_state.participant_count,
        "participant_count_source": participant_state.participant_count_source,
        "overflow_triggered": participant_state.overflow_triggered,
        "user_id": getattr(getattr(request, "user", None), "id", None),
        **extra,
    }

    if str(level).lower() == "warning":
        realtime_ops_logger.warning("REALTIME_TELEMETRY %s", payload)
    else:
        realtime_ops_logger.info("REALTIME_TELEMETRY %s", payload)


def _get_active_session_recording(session):
    return (
        RealtimeSessionRecording.objects.filter(
            session=session,
            status__in=RealtimeSessionRecording.ACTIVE_STATUSES,
        )
        .select_related("started_by")
        .order_by("-created_at")
        .first()
    )


def _record_join_metric(*, result, mode, reason):
    record_realtime_join(result=result, mode=mode, reason=reason)


def _record_recording_metric(*, action, result, reason):
    record_realtime_recording_operation(action=action, result=result, reason=reason)


class RealtimeSessionListCreateView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "realtime_session_create"

    def get_throttles(self):
        if self.request.method.upper() == "POST":
            return super().get_throttles()
        return []

    def get(self, request):
        disallowed_query_params = find_disallowed_query_params(
            request,
            {"session_type", "status"},
        )
        if disallowed_query_params:
            log_security_event(
                "request.query_params_blocked",
                request=request,
                endpoint="realtime_session_list",
                blocked_keys=disallowed_query_params[:20],
            )
            return api_response(
                success=False,
                message="Invalid request query.",
                errors={"detail": "Unsupported query parameters."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        session_type = (request.query_params.get("session_type") or "").strip().lower()
        status_filter = (request.query_params.get("status") or "").strip().lower()
        is_admin = bool(getattr(request.user, "is_staff", False) or getattr(request.user, "is_superuser", False))
        cache_ttl = max(0, int(getattr(settings, "REALTIME_SESSION_LIST_CACHE_TTL_SECONDS", 5)))
        cache_key = _build_session_list_cache_key(
            user_id=request.user.id,
            is_admin=is_admin,
            session_type=session_type,
            status_filter=status_filter,
        )

        if cache_ttl > 0:
            cached = cache.get(cache_key)
            if cached is not None:
                return api_response(success=True, message="Realtime sessions fetched.", data=cached)

        queryset = list_queryset(
            session_type=session_type,
            status_filter=status_filter,
            user=request.user,
        )

        serializer = RealtimeSessionListSerializer(queryset, many=True, context={"request": request})
        payload = serializer.data
        if cache_ttl > 0:
            cache.set(cache_key, payload, timeout=cache_ttl)
        return api_response(success=True, message="Realtime sessions fetched.", data=payload)

    def post(self, request):
        if not request.user or not request.user.is_authenticated:
            return api_response(
                success=False,
                message="Authentication required.",
                errors={"detail": "Authentication credentials were not provided."},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        if not (getattr(request.user, "is_staff", False) or getattr(request.user, "is_superuser", False)):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only admin accounts can create live sessions."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        serializer = RealtimeSessionCreateSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Realtime session creation failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        payload = session_payload_for_create(serializer.validated_data)

        session = RealtimeSession.objects.create(host=request.user, **payload)
        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(
            success=True,
            message="Realtime session created.",
            data=data,
            status_code=status.HTTP_201_CREATED,
        )


class RealtimeSessionDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.with_related(), pk=pk)
        access_decision = get_access_decision(session, request.user)
        if not access_decision.allowed:
            return api_response(
                success=False,
                message=access_decision.message,
                errors={"detail": access_decision.detail},
                status_code=access_decision.status_code,
            )
        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(success=True, message="Realtime session fetched.", data=data)


class RealtimeSessionJoinView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "realtime_session_join"

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.with_related(), pk=pk)
        if session.status == RealtimeSession.STATUS_ENDED:
            _record_join_metric(result="failure", mode="meeting", reason="session_ended")
            return api_response(
                success=False,
                message="Session has ended.",
                errors={"detail": "This session is no longer active."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        serializer = RealtimeSessionJoinSerializer(data=request.data)
        if not serializer.is_valid():
            _record_join_metric(result="failure", mode="meeting", reason="invalid_payload")
            return api_response(
                success=False,
                message="Unable to join session.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        access_decision = get_access_decision(session, request.user)
        if not access_decision.allowed:
            _record_join_metric(result="failure", mode="meeting", reason="access_denied")
            return api_response(
                success=False,
                message=access_decision.message,
                errors={"detail": access_decision.detail},
                status_code=access_decision.status_code,
            )
        if session.status == RealtimeSession.STATUS_SCHEDULED:
            session.mark_live()
        room_name = session.livekit_room_name or session.room_name

        permissions_set = build_permission_set(session, request.user, access_decision)
        realtime_config = RealtimeConfiguration.get_solo()
        participant_state = resolve_participant_state(
            session,
            room_name=room_name,
            is_host=access_decision.is_host,
            participant_counter=get_room_participant_count,
        )
        if session.session_type == RealtimeSession.TYPE_MEETING:
            if bool(getattr(settings, "REALTIME_WARN_PARTICIPANT_FALLBACK_SOURCE", True)) and (
                participant_state.participant_count_source == "fallback"
            ):
                _emit_realtime_telemetry(
                    event="meeting.participant_count_source_fallback",
                    level="warning",
                    request=request,
                    session=session,
                    participant_state=participant_state,
                )
            capacity_threshold = float(getattr(settings, "REALTIME_CAPACITY_WARNING_RATIO", 0.8))
            safe_capacity = max(1, int(session.meeting_capacity or 1))
            capacity_ratio = participant_state.participant_count / safe_capacity
            if capacity_ratio >= capacity_threshold:
                _emit_realtime_telemetry(
                    event="meeting.capacity_threshold_reached",
                    level="warning",
                    request=request,
                    session=session,
                    participant_state=participant_state,
                    capacity_ratio=round(capacity_ratio, 3),
                    capacity_threshold=round(capacity_threshold, 3),
                )
            if participant_state.overflow_triggered:
                _emit_realtime_telemetry(
                    event="meeting.overflow_to_broadcast",
                    level="warning",
                    request=request,
                    session=session,
                    participant_state=participant_state,
                )

        if participant_state.should_use_broadcast:
            urls = resolve_broadcast_urls(session, request=request)
            _record_join_metric(
                result="success",
                mode="broadcast",
                reason="overflow" if participant_state.overflow_triggered else "broadcast_session",
            )
            data = {
                "mode": "broadcast",
                "overflow_triggered": participant_state.overflow_triggered,
                "participant_count": participant_state.participant_count,
                "participant_count_source": participant_state.participant_count_source,
                "session": RealtimeSessionListSerializer(session, context={"request": request}).data,
                "broadcast": {
                    "stream_embed_url": urls["stream_embed_url"],
                    "chat_embed_url": urls["chat_embed_url"],
                    "max_audience": session.max_audience,
                    "stream_status": session.stream_status,
                },
            }
            return api_response(success=True, message="Broadcast join payload created.", data=data)

        if not is_livekit_configured():
            _record_join_metric(result="failure", mode="meeting", reason="livekit_unconfigured")
            return api_response(
                success=False,
                message="Meeting service unavailable.",
                errors={
                    "detail": (
                        "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, "
                        "and LIVEKIT_API_SECRET in backend environment variables."
                    )
                },
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        display_name = serializer.validated_data.get("display_name") or request.user.full_name or request.user.email
        identity = f"user-{request.user.id}-{int(time.time())}"
        participant_metadata = build_participant_metadata(user=request.user, request=request)

        try:
            token = build_participant_token(
                identity=identity,
                room_name=room_name,
                participant_name=display_name,
                can_publish=permissions_set.can_publish,
                can_subscribe=True,
                room_admin=permissions_set.can_manage_presenters,
                ttl_seconds=settings.REALTIME_JOIN_TOKEN_TTL_SECONDS,
                can_publish_sources=permissions_set.can_publish_sources,
                participant_metadata=participant_metadata,
            )
        except LiveKitConfigError as exc:
            _record_join_metric(result="failure", mode="meeting", reason="token_build_failed")
            return api_response(
                success=False,
                message="Meeting service unavailable.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        livekit_client_url = resolve_livekit_client_url(request=request)

        data = {
            "mode": "meeting",
            "overflow_triggered": False,
            "participant_count": participant_state.participant_count,
            "participant_count_source": participant_state.participant_count_source,
            "session": RealtimeSessionListSerializer(session, context={"request": request}).data,
            "meeting": {
                "room_name": room_name,
                "livekit_url": livekit_client_url,
                "participant_identity": identity,
                "participant_name": display_name,
                "participant_profile_image_url": participant_metadata.get("profile_image_url") or "",
                "token": token,
                "meet_embed_url": build_meet_embed_url(token, livekit_client_url),
                "meeting_capacity": session.meeting_capacity,
                "media_profile": realtime_config.to_meeting_dict(
                    participant_count=participant_state.participant_count,
                    meeting_capacity=session.meeting_capacity,
                ),
                "permissions": {
                    "can_present": permissions_set.can_present,
                    "can_speak": permissions_set.can_speak,
                    "can_use_microphone": permissions_set.can_speak,
                    "can_use_camera": permissions_set.can_present,
                    "can_share_screen": permissions_set.can_present,
                    "can_manage_presenters": permissions_set.can_manage_presenters,
                    "can_manage_participants": permissions_set.can_manage_presenters,
                },
                "presenter_user_ids": session.get_presenter_user_ids(),
                "speaker_user_ids": session.get_speaker_user_ids(),
            },
        }
        cache_room_participant_count(room_name, participant_state.participant_count + 1)
        _record_join_metric(result="success", mode="meeting", reason="ok")
        return api_response(success=True, message="Meeting join payload created.", data=data)


class RealtimeSessionEndView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can end this session."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        if session.status != RealtimeSession.STATUS_ENDED:
            session.mark_ended()

        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(success=True, message="Realtime session ended.", data=data)


class RealtimeSessionPresenterPermissionView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk, permission_action):
        return _update_participant_permission(
            request=request,
            pk=pk,
            permission_action=permission_action,
            permission_kind="presenter",
        )


class RealtimeSessionSpeakerPermissionView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk, permission_action):
        return _update_participant_permission(
            request=request,
            pk=pk,
            permission_action=permission_action,
            permission_kind="speaker",
        )


def _update_participant_permission(*, request, pk, permission_action, permission_kind):
    session = get_object_or_404(RealtimeSession, pk=pk)
    if not _can_manage_session(request.user, session):
        return api_response(
            success=False,
            message="Access denied.",
            errors={"detail": "Only host, assigned instructor, or admin can manage participant permissions."},
            status_code=status.HTTP_403_FORBIDDEN,
        )
    if session.session_type != RealtimeSession.TYPE_MEETING:
        return api_response(
            success=False,
            message="Participant control unavailable.",
            errors={"detail": "Participant permissions are supported for meeting sessions only."},
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if permission_action not in {"grant", "revoke"}:
        return api_response(
            success=False,
            message="Invalid participant permission action.",
            errors={"detail": "Action must be grant or revoke."},
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    serializer = RealtimePresenterPermissionSerializer(data=request.data)
    if not serializer.is_valid():
        return api_response(
            success=False,
            message="Participant permission update failed.",
            errors=serializer.errors,
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    target_user_id = serializer.validated_data["user_id"]
    target_user = User.objects.filter(pk=target_user_id, is_active=True).first()
    if not target_user:
        return api_response(
            success=False,
            message="Participant permission update failed.",
            errors={"detail": "Target user not found or inactive."},
            status_code=status.HTTP_404_NOT_FOUND,
        )

    target_label = "Presenter" if permission_kind == "presenter" else "Mic"
    if permission_kind == "presenter":
        return api_response(
            success=False,
            message="Stage access is restricted.",
            errors={"detail": "Only admin or the assigned instructor can use camera and screen share."},
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    else:
        actor = session.grant_speaker if permission_action == "grant" else session.revoke_speaker
        speaker_ids = actor(target_user_id)
        presenter_ids = session.get_presenter_user_ids()

    if permission_action == "grant":
        message = f"{target_label} access granted."
    else:
        message = f"{target_label} access revoked."

    data = {
        "session": RealtimeSessionListSerializer(session, context={"request": request}).data,
        "presenter_user_ids": presenter_ids,
        "speaker_user_ids": speaker_ids,
        "updated_user": {
            "id": target_user.id,
            "email": target_user.email,
            "full_name": target_user.full_name,
            "role": target_user.role,
        },
        "updated_permission": permission_kind,
        "note": "Permission updates apply on participant rejoin.",
    }
    return api_response(success=True, message=message, data=data)


class RealtimeSessionHostTokenView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can start browser publishing."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if not is_livekit_configured():
            return api_response(
                success=False,
                message="Meeting service unavailable.",
                errors={
                    "detail": (
                        "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, "
                        "and LIVEKIT_API_SECRET in backend environment variables."
                    )
                },
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        token_payload = build_host_publisher_token(session=session, user=request.user)
        livekit_client_url = resolve_livekit_client_url(request=request)
        realtime_config = RealtimeConfiguration.get_solo()
        return api_response(
            success=True,
            message="Host publisher token created.",
            data={
                "session": RealtimeSessionListSerializer(session, context={"request": request}).data,
                "livekit_url": livekit_client_url,
                "room_name": session.livekit_room_name or session.room_name,
                "participant_identity": token_payload["identity"],
                "token": token_payload["token"],
                "broadcast_profile": realtime_config.to_broadcast_dict(),
            },
        )


class RealtimeSessionStreamStartView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can start streaming."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        rtmp_target_url = (session.rtmp_target_url or "").strip() or (settings.OWNCAST_RTMP_TARGET or "").strip()
        if not rtmp_target_url:
            return api_response(
                success=False,
                message="Streaming target unavailable.",
                errors={
                    "detail": (
                        "Set OWNCAST_RTMP_TARGET in backend environment. "
                        "Example: rtmp://owncast:1935/live/<stream-key>"
                    )
                },
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        if session.stream_status == RealtimeSession.STREAM_LIVE and session.livekit_egress_id:
            return api_response(
                success=True,
                message="Stream already live.",
                data=RealtimeSessionListSerializer(session, context={"request": request}).data,
            )

        session.mark_stream_starting()
        try:
            participant_identity = (
                build_host_publisher_identity(session.host_id, session.id)
                if request.user.id == session.host_id
                else ""
            )
            egress_id = start_room_broadcast_egress(
                room_name=session.livekit_room_name or session.room_name,
                rtmp_target_url=rtmp_target_url,
                participant_identity=participant_identity,
            )
            session.mark_stream_live(egress_id)
        except (LiveKitConfigError, LiveKitEgressError) as exc:
            session.mark_stream_failed(str(exc))
            return api_response(
                success=False,
                message="Unable to start live stream.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(success=True, message="Live stream started.", data=data)


class RealtimeSessionStreamStopView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can stop streaming."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        try:
            stop_room_broadcast_egress(egress_id=session.livekit_egress_id)
            session.mark_stream_stopped()
        except (LiveKitConfigError, LiveKitEgressError) as exc:
            session.mark_stream_failed(str(exc))
            return api_response(
                success=False,
                message="Unable to stop live stream cleanly.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(success=True, message="Live stream stopped.", data=data)


class RealtimeSessionRecordingListView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.with_related(), pk=pk)
        access_decision = get_access_decision(session, request.user)
        if not access_decision.allowed:
            return api_response(
                success=False,
                message=access_decision.message,
                errors={"detail": access_decision.detail},
                status_code=access_decision.status_code,
            )

        recordings = (
            RealtimeSessionRecording.objects.filter(session=session)
            .select_related("started_by")
            .order_by("-created_at")
        )
        data = RealtimeSessionRecordingSerializer(recordings, many=True, context={"request": request}).data
        return api_response(success=True, message="Session recordings fetched.", data=data)


class RealtimeSessionRecordingDownloadView(APIView):
    authentication_classes = [SessionAuthentication, CookieJWTAuthentication]
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, recording_id):
        recording = get_object_or_404(
            RealtimeSessionRecording.objects.select_related("session", "started_by"),
            pk=recording_id,
        )
        access_decision = get_access_decision(recording.session, request.user)
        if not access_decision.allowed:
            return api_response(
                success=False,
                message=access_decision.message,
                errors={"detail": access_decision.detail},
                status_code=access_decision.status_code,
            )

        stream = None
        filename = f"recording-{recording.id}.mp4"

        if recording.video_file:
            try:
                stream = recording.video_file.open("rb")
                filename = str(recording.video_file.name or filename).replace("\\", "/").split("/")[-1]
            except Exception:
                stream = None

        if stream is None:
            resolved_path = resolve_recording_local_path(recording.output_file_path)
            if not resolved_path or not resolved_path.exists() or not resolved_path.is_file():
                if recording.output_download_url:
                    return HttpResponseRedirect(recording.output_download_url)
                return api_response(
                    success=False,
                    message="Recording file not found.",
                    errors={"detail": "Recording asset is not available on storage."},
                    status_code=status.HTTP_404_NOT_FOUND,
                )
            stream = resolved_path.open("rb")
            filename = resolved_path.name or filename

        content_type, _ = mimetypes.guess_type(filename)
        response = FileResponse(stream, content_type=content_type or "application/octet-stream")
        response["Content-Disposition"] = f'inline; filename="{filename}"'
        return response


class RealtimeSessionRecordingDeleteView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def delete(self, request, recording_id):
        recording = get_object_or_404(
            RealtimeSessionRecording.objects.select_related("session", "started_by"),
            pk=recording_id,
        )
        if not _can_manage_session(request.user, recording.session):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can delete recordings."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if recording.status in RealtimeSessionRecording.ACTIVE_STATUSES:
            return api_response(
                success=False,
                message="Recording is active.",
                errors={"detail": "Stop the recording before deleting it."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        recording_id_value = recording.id
        delete_recording_assets(recording)
        recording.delete()
        return api_response(
            success=True,
            message="Recording deleted.",
            data={"id": recording_id_value},
        )


class RealtimeSessionRecordingStartView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            _record_recording_metric(action="start", result="failure", reason="access_denied")
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can start recording."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if not bool(getattr(settings, "LIVEKIT_RECORDING_ENABLED", True)):
            _record_recording_metric(action="start", result="failure", reason="recording_disabled")
            return api_response(
                success=False,
                message="Recording is disabled.",
                errors={"detail": "LIVEKIT_RECORDING_ENABLED is disabled in backend environment."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if not is_livekit_configured():
            _record_recording_metric(action="start", result="failure", reason="livekit_unconfigured")
            return api_response(
                success=False,
                message="Recording service unavailable.",
                errors={
                    "detail": (
                        "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, "
                        "and LIVEKIT_API_SECRET in backend environment variables."
                    )
                },
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        active_recording = _get_active_session_recording(session)
        if active_recording:
            _record_recording_metric(action="start", result="noop", reason="already_active")
            data = RealtimeSessionRecordingSerializer(active_recording, context={"request": request}).data
            return api_response(
                success=True,
                message="Recording already in progress.",
                data=data,
            )

        output_file_path = build_recording_filepath(
            room_name=session.livekit_room_name or session.room_name,
            session_type=session.session_type,
        )
        recording = RealtimeSessionRecording.objects.create(
            session=session,
            recording_type=session.session_type,
            started_by=request.user,
            status=RealtimeSessionRecording.STATUS_STARTING,
            output_file_path=output_file_path,
            started_at=timezone.now(),
        )

        try:
            result = start_room_recording_egress(
                room_name=session.livekit_room_name or session.room_name,
                output_file_path=output_file_path,
                layout=settings.LIVEKIT_EGRESS_LAYOUT,
            )
            recording.mark_recording(
                egress_id=result.get("egress_id", ""),
                payload={"start_response": result.get("response", {})},
            )
        except (LiveKitConfigError, LiveKitEgressError) as exc:
            recording.mark_failed(str(exc), payload={"start_error": str(exc)})
            _record_recording_metric(action="start", result="failure", reason="livekit_error")
            return api_response(
                success=False,
                message="Unable to start recording.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        data = RealtimeSessionRecordingSerializer(recording, context={"request": request}).data
        _record_recording_metric(action="start", result="success", reason="ok")
        return api_response(success=True, message="Recording started.", data=data)


class RealtimeSessionRecordingStopView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            _record_recording_metric(action="stop", result="failure", reason="access_denied")
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can stop recording."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        recording = _get_active_session_recording(session)
        if not recording:
            _record_recording_metric(action="stop", result="failure", reason="no_active_recording")
            return api_response(
                success=False,
                message="No active recording.",
                errors={"detail": "There is no active recording for this session."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if not recording.livekit_egress_id:
            recording.mark_failed("Missing LiveKit recording egress id.")
            _record_recording_metric(action="stop", result="failure", reason="missing_egress_id")
            return api_response(
                success=False,
                message="Unable to stop recording.",
                errors={"detail": "Recording egress id is missing."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        recording.mark_stopping()
        try:
            stop_payload = stop_room_recording_egress(egress_id=recording.livekit_egress_id)
            resolved_output = extract_recording_output(
                stop_payload=stop_payload,
                fallback_file_path=recording.output_file_path,
            )
            recording.mark_completed(
                file_path=resolved_output.get("file_path", ""),
                file_url=resolved_output.get("download_url", ""),
                payload={"stop_response": stop_payload},
            )
        except (LiveKitConfigError, LiveKitEgressError) as exc:
            recording.mark_failed(str(exc), payload={"stop_error": str(exc)})
            _record_recording_metric(action="stop", result="failure", reason="livekit_error")
            return api_response(
                success=False,
                message="Unable to stop recording cleanly.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        data = RealtimeSessionRecordingSerializer(recording, context={"request": request}).data
        _record_recording_metric(action="stop", result="success", reason="ok")
        return api_response(success=True, message="Recording stopped.", data=data)


class RealtimeSessionBrowserRecordingUploadView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can upload fallback recording."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        serializer = RealtimeSessionBrowserRecordingUploadSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Fallback recording upload failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        started_at = serializer.validated_data.get("started_at")
        ended_at = serializer.validated_data.get("ended_at")
        video_file = serializer.validated_data["video_file"]

        recording = RealtimeSessionRecording.objects.create(
            session=session,
            recording_type=session.session_type,
            started_by=request.user,
            status=RealtimeSessionRecording.STATUS_COMPLETED,
            started_at=started_at or timezone.now(),
            ended_at=ended_at or timezone.now(),
            video_file=video_file,
            livekit_payload={"source": "browser_fallback"},
        )
        data = RealtimeSessionRecordingSerializer(recording, context={"request": request}).data
        return api_response(
            success=True,
            message="Fallback recording uploaded.",
            data=data,
            status_code=status.HTTP_201_CREATED,
        )
