import time

from django.conf import settings
from django.contrib.auth import get_user_model
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from config.audit import log_security_event
from config.request_security import find_disallowed_query_params
from config.response import api_response

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


class RealtimeSessionListCreateView(APIView):
    permission_classes = [permissions.AllowAny]
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

        queryset = RealtimeSession.objects.select_related("host")

        session_type = (request.query_params.get("session_type") or "").strip().lower()
        if session_type in {RealtimeSession.TYPE_MEETING, RealtimeSession.TYPE_BROADCASTING}:
            queryset = queryset.filter(session_type=session_type)

        status_filter = (request.query_params.get("status") or "").strip().lower()
        if status_filter in {
            RealtimeSession.STATUS_SCHEDULED,
            RealtimeSession.STATUS_LIVE,
            RealtimeSession.STATUS_ENDED,
        }:
            queryset = queryset.filter(status=status_filter)
        elif status_filter != "all":
            queryset = queryset.filter(
                status__in=[RealtimeSession.STATUS_SCHEDULED, RealtimeSession.STATUS_LIVE]
            )

        serializer = RealtimeSessionListSerializer(queryset, many=True, context={"request": request})
        return api_response(success=True, message="Realtime sessions fetched.", data=serializer.data)

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

        payload = dict(serializer.validated_data)
        payload.setdefault("meeting_capacity", settings.REALTIME_DEFAULT_MEETING_CAPACITY)
        payload.setdefault("max_audience", settings.REALTIME_DEFAULT_MAX_AUDIENCE)
        payload.setdefault("status", RealtimeSession.STATUS_LIVE)

        session = RealtimeSession.objects.create(host=request.user, **payload)
        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(
            success=True,
            message="Realtime session created.",
            data=data,
            status_code=status.HTTP_201_CREATED,
        )


class RealtimeSessionDetailView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.select_related("host"), pk=pk)
        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(success=True, message="Realtime session fetched.", data=data)


class RealtimeSessionJoinView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "realtime_session_join"

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.select_related("host"), pk=pk)
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
        is_host = request.user.id == session.host_id
        is_admin = bool(getattr(request.user, "is_staff", False) or getattr(request.user, "is_superuser", False))
        can_manage_presenters = bool(is_host or is_admin)
        can_present = session.is_presenter_allowed(request.user)
        can_speak = session.session_type == RealtimeSession.TYPE_MEETING
        can_publish = bool(can_present or can_speak)
        can_publish_sources = None
        if session.session_type == RealtimeSession.TYPE_MEETING:
            if can_present:
                can_publish_sources = ["camera", "microphone", "screen_share", "screen_share_audio"]
            elif can_speak:
                can_publish_sources = ["microphone"]
        realtime_config = RealtimeConfiguration.get_solo()
        participant_count = 0
        participant_count_source = "fallback"

        if session.session_type == RealtimeSession.TYPE_MEETING:
            count = get_room_participant_count(room_name)
            if count is not None:
                participant_count = count
                participant_count_source = "livekit"

        should_use_broadcast = session.session_type == RealtimeSession.TYPE_BROADCASTING
        overflow_triggered = False

        if (
            session.session_type == RealtimeSession.TYPE_MEETING
            and session.allow_overflow_broadcast
            and participant_count >= session.meeting_capacity
            and not is_host
        ):
            should_use_broadcast = True
            overflow_triggered = True

        if should_use_broadcast:
            urls = resolve_broadcast_urls(session, request=request)
            data = {
                "mode": "broadcast",
                "overflow_triggered": overflow_triggered,
                "participant_count": participant_count,
                "participant_count_source": participant_count_source,
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
                can_publish=can_publish,
                can_subscribe=True,
                room_admin=can_manage_presenters,
                ttl_seconds=settings.REALTIME_JOIN_TOKEN_TTL_SECONDS,
                can_publish_sources=can_publish_sources,
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
            "participant_count": participant_count,
            "participant_count_source": participant_count_source,
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
                    "can_present": can_present,
                    "can_speak": can_speak,
                    "can_use_camera": can_present,
                    "can_share_screen": can_present,
                    "can_manage_presenters": can_manage_presenters,
                },
                "presenter_user_ids": session.get_presenter_user_ids(),
            },
        }
        return api_response(success=True, message="Meeting join payload created.", data=data)


class RealtimeSessionEndView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if request.user.id != session.host_id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only the host can end this session."},
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
        if request.user.id != session.host_id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only the host can start browser publishing."},
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
        if request.user.id != session.host_id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only the host can start streaming."},
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
            egress_id = start_room_broadcast_egress(
                room_name=session.livekit_room_name or session.room_name,
                rtmp_target_url=rtmp_target_url,
                participant_identity=build_host_publisher_identity(session.host_id, session.id),
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
        if request.user.id != session.host_id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only the host can stop streaming."},
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
