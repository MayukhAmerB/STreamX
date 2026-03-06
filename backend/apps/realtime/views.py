import logging
import time

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from config.audit import log_security_event
from config.request_security import find_disallowed_query_params
from config.response import api_response

from .domain import (
    build_permission_set,
    get_access_decision,
    list_queryset,
    resolve_participant_state,
    session_payload_for_create,
)
from .models import RealtimeConfiguration, RealtimeSession
from .serializers import (
    RealtimeSessionCreateSerializer,
    RealtimeSessionJoinSerializer,
    RealtimeSessionListSerializer,
    RealtimePresenterPermissionSerializer,
)
from .services import (
    LiveKitEgressError,
    LiveKitConfigError,
    build_host_publisher_identity,
    build_host_publisher_token,
    build_meet_embed_url,
    build_participant_token,
    get_room_participant_count,
    is_livekit_configured,
    resolve_livekit_client_url,
    resolve_broadcast_urls,
    start_room_broadcast_egress,
    stop_room_broadcast_egress,
)

User = get_user_model()
realtime_ops_logger = logging.getLogger("ops.realtime")


def _can_manage_session(user, session):
    if not user or not getattr(user, "is_authenticated", False):
        return False
    return bool(
        getattr(user, "id", None) == session.host_id
        or getattr(user, "is_staff", False)
        or getattr(user, "is_superuser", False)
    )


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
            return api_response(
                success=False,
                message="Session has ended.",
                errors={"detail": "This session is no longer active."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        serializer = RealtimeSessionJoinSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Unable to join session.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        if session.status == RealtimeSession.STATUS_SCHEDULED:
            session.mark_live()

        room_name = session.livekit_room_name or session.room_name
        access_decision = get_access_decision(session, request.user)
        if not access_decision.allowed:
            return api_response(
                success=False,
                message=access_decision.message,
                errors={"detail": access_decision.detail},
                status_code=access_decision.status_code,
            )

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
                participant_state.participant_count_source != "livekit"
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
            )
        except LiveKitConfigError as exc:
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
                "token": token,
                "meet_embed_url": build_meet_embed_url(token, livekit_client_url),
                "meeting_capacity": session.meeting_capacity,
                "media_profile": realtime_config.to_meeting_dict(),
                "permissions": {
                    "can_present": permissions_set.can_present,
                    "can_speak": permissions_set.can_speak,
                    "can_use_camera": permissions_set.can_present,
                    "can_share_screen": permissions_set.can_present,
                    "can_manage_presenters": permissions_set.can_manage_presenters,
                },
                "presenter_user_ids": session.get_presenter_user_ids(),
            },
        }
        return api_response(success=True, message="Meeting join payload created.", data=data)


class RealtimeSessionEndView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host or admin can end this session."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        if session.status != RealtimeSession.STATUS_ENDED:
            session.mark_ended()

        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(success=True, message="Realtime session ended.", data=data)


class RealtimeSessionPresenterPermissionView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk, permission_action):
        session = get_object_or_404(RealtimeSession, pk=pk)
        is_host = request.user.id == session.host_id
        is_admin = bool(getattr(request.user, "is_staff", False) or getattr(request.user, "is_superuser", False))
        if not (is_host or is_admin):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host or admin can manage presenter permissions."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if session.session_type != RealtimeSession.TYPE_MEETING:
            return api_response(
                success=False,
                message="Presenter control unavailable.",
                errors={"detail": "Presenter permissions are supported for meeting sessions only."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if permission_action not in {"grant", "revoke"}:
            return api_response(
                success=False,
                message="Invalid presenter action.",
                errors={"detail": "Action must be grant or revoke."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        serializer = RealtimePresenterPermissionSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Presenter permission update failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        target_user_id = serializer.validated_data["user_id"]
        target_user = User.objects.filter(pk=target_user_id, is_active=True).first()
        if not target_user:
            return api_response(
                success=False,
                message="Presenter permission update failed.",
                errors={"detail": "Target user not found or inactive."},
                status_code=status.HTTP_404_NOT_FOUND,
            )

        if permission_action == "grant":
            presenter_ids = session.grant_presenter(target_user_id)
            message = "Presenter access granted."
        else:
            presenter_ids = session.revoke_presenter(target_user_id)
            message = "Presenter access revoked."

        data = {
            "session": RealtimeSessionListSerializer(session, context={"request": request}).data,
            "presenter_user_ids": presenter_ids,
            "updated_user": {
                "id": target_user.id,
                "email": target_user.email,
                "full_name": target_user.full_name,
                "role": target_user.role,
            },
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
                errors={"detail": "Only host or admin can start browser publishing."},
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
                errors={"detail": "Only host or admin can start streaming."},
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
                errors={"detail": "Only host or admin can stop streaming."},
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
