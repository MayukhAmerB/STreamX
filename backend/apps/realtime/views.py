import logging
import mimetypes
import time
import json
import hashlib
from datetime import timedelta
from urllib.parse import quote, urlparse

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core import signing
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from django.db.models import Q
from django.http import FileResponse, HttpResponse
from django.http.response import HttpResponseRedirect
from django.shortcuts import get_object_or_404
from django.utils.html import strip_tags
from django.utils import timezone
from rest_framework import permissions, status
from rest_framework.authentication import SessionAuthentication
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from config.audit import log_security_event
from config.authentication import CookieJWTAuthentication
from config.client_ip import resolve_client_ip
from config.metrics import record_realtime_join, record_realtime_recording_operation
from config.pagination import apply_optional_pagination
from config.request_security import find_disallowed_query_params
from config.response import api_response

from .domain import (
    build_permission_set,
    get_access_decision,
    list_queryset,
    resolve_participant_state,
    session_payload_for_create,
)
from .models import OwncastChatIdentity, RealtimeConfiguration, RealtimeSession, RealtimeSessionRecording
from .serializers import (
    RealtimeOwncastChatModerationActionSerializer,
    RealtimeSessionBrowserRecordingUploadSerializer,
    RealtimeSessionCreateSerializer,
    RealtimeSessionJoinSerializer,
    RealtimeSessionListSerializer,
    RealtimeSessionRecordingSerializer,
    RealtimePresenterPermissionSerializer,
)
from .services import (
    apply_live_presenter_permission_update,
    apply_live_speaker_permission_update,
    build_participant_metadata,
    cache_room_participant_count,
    delete_recording_assets,
    LiveKitEgressError,
    LiveKitConfigError,
    OwncastAdminError,
    OwncastConfigError,
    build_recording_filepath,
    build_host_publisher_identity,
    build_host_publisher_token,
    build_meet_embed_url,
    build_participant_token,
    extract_recording_output,
    fetch_owncast_chat_messages_admin,
    fetch_owncast_disabled_chat_users,
    fetch_owncast_ip_bans,
    fetch_owncast_moderator_chat_users,
    get_room_participant_count,
    is_livekit_configured,
    owncast_ban_ip_address,
    owncast_remove_ip_ban,
    owncast_set_chat_message_visibility,
    owncast_set_chat_user_enabled,
    owncast_set_chat_user_moderator,
    resolve_recording_local_path,
    resolve_livekit_client_url,
    resolve_obs_stream_server_url,
    resolve_broadcast_urls,
    refresh_obs_session_stream_health,
    register_owncast_chat_user,
    release_expired_owncast_chat_timeouts,
    sync_owncast_chat_identities_from_recent_messages,
    sync_owncast_chat_settings,
    start_room_recording_egress,
    start_room_broadcast_egress,
    stop_room_recording_egress,
    stop_room_broadcast_egress,
    sync_owncast_stream_key,
)

User = get_user_model()
realtime_ops_logger = logging.getLogger("ops.realtime")
_OWNCAST_CHAT_BRIDGE_SIGNING_SALT = "realtime.owncast-chat-bridge"
_OWNCAST_CHAT_BRIDGE_NEXT_PATH = "/embed/chat/readwrite/"
_OWNCAST_STREAM_BRIDGE_SIGNING_SALT = "realtime.owncast-stream-bridge"
_OWNCAST_STREAM_ACCESS_SIGNING_SALT = "realtime.owncast-stream-access"
_OWNCAST_STREAM_BRIDGE_NEXT_PATH = "/embed/video/"
_OWNCAST_PENDING_DISPLAY_NAME = "Pending Owncast handle"


def _owncast_chat_bridge_ttl_seconds():
    configured = int(getattr(settings, "OWNCAST_CHAT_BRIDGE_TTL_SECONDS", 9000) or 9000)
    return max(30, configured)


def _owncast_stream_access_ttl_seconds():
    configured = int(
        getattr(
            settings,
            "OWNCAST_STREAM_ACCESS_TTL_SECONDS",
            _owncast_chat_bridge_ttl_seconds(),
        )
        or _owncast_chat_bridge_ttl_seconds()
    )
    return max(60, configured)


def _owncast_stream_access_cookie_name():
    return str(getattr(settings, "OWNCAST_STREAM_ACCESS_COOKIE_NAME", "") or "").strip() or "owncast_stream_access"


def _resolve_owncast_chat_origin(chat_embed_url):
    parsed = urlparse(str(chat_embed_url or "").strip())
    if parsed.scheme.lower() not in {"http", "https"}:
        return ""
    if not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def _resolve_owncast_stream_next_path(stream_embed_url):
    parsed = urlparse(str(stream_embed_url or "").strip())
    path = parsed.path or _OWNCAST_STREAM_BRIDGE_NEXT_PATH
    if path == "/embed/video":
        path = "/embed/video/"
    if not path.startswith("/") or path.startswith("//"):
        return _OWNCAST_STREAM_BRIDGE_NEXT_PATH
    if parsed.query:
        return f"{path}?{parsed.query}"
    return path


def _request_user_agent_hash(request):
    user_agent = str(request.META.get("HTTP_USER_AGENT", "") or "")
    if not user_agent:
        return ""
    return hashlib.sha256(user_agent.encode("utf-8")).hexdigest()


def _is_secure_request(request):
    return bool(
        request.is_secure()
        or str(request.META.get("HTTP_X_FORWARDED_PROTO", "") or "").split(",", 1)[0].strip().lower() == "https"
    )


def _build_owncast_stream_launch_url(*, session, user, request, stream_embed_url):
    stream_origin = _resolve_owncast_chat_origin(stream_embed_url)
    if not stream_origin:
        return ""

    bridge_payload = signing.dumps(
        {
            "session_id": int(session.id),
            "user_id": int(user.id),
            "next_path": _resolve_owncast_stream_next_path(stream_embed_url),
            "client_ip": str(resolve_client_ip(request) or "")[:64],
            "user_agent_hash": _request_user_agent_hash(request),
        },
        salt=_OWNCAST_STREAM_BRIDGE_SIGNING_SALT,
        compress=True,
    )
    return f"{stream_origin}/api/realtime/owncast/stream-bridge/?token={quote(bridge_payload, safe='')}"


def _resolve_owncast_display_name(user):
    full_name = str(getattr(user, "full_name", "") or "").strip()
    if full_name:
        return full_name[:80]

    email = str(getattr(user, "email", "") or "").strip()
    if email:
        local_part = email.split("@", 1)[0].strip()
        if local_part:
            return local_part[:80]

    return "Viewer"


def _clean_owncast_display_name(value, *, max_length=80):
    return " ".join(strip_tags(str(value or "")).split())[:max_length]


def _same_owncast_display_name(left, right):
    return _clean_owncast_display_name(left).casefold() == _clean_owncast_display_name(right).casefold()


def _is_placeholder_owncast_display_name(value):
    normalized = _clean_owncast_display_name(value).casefold()
    return normalized in {"", "owncast viewer", _OWNCAST_PENDING_DISPLAY_NAME.casefold()}


def _owncast_display_name_for_storage(value, *, platform_display_name):
    cleaned = _clean_owncast_display_name(value, max_length=120)
    if _is_placeholder_owncast_display_name(cleaned):
        return ""
    if platform_display_name and _same_owncast_display_name(cleaned, platform_display_name):
        return ""
    return cleaned


def _decode_owncast_chat_bridge_payload(token):
    return signing.loads(
        token,
        max_age=_owncast_chat_bridge_ttl_seconds(),
        salt=_OWNCAST_CHAT_BRIDGE_SIGNING_SALT,
    )


def _owncast_chat_bridge_frame_ancestors():
    ancestors = ["'self'", "https://alsyedinitiative.com", "https://www.alsyedinitiative.com"]
    configured_sources = [
        getattr(settings, "FRONTEND_URL", ""),
        getattr(settings, "FRONTEND_PUBLIC_ORIGIN", ""),
        *getattr(settings, "CORS_ALLOWED_ORIGINS", []),
        *getattr(settings, "CSRF_TRUSTED_ORIGINS", []),
    ]
    for source in configured_sources:
        parsed = urlparse(str(source or "").strip())
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            continue
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in ancestors:
            ancestors.append(origin)
    return " ".join(ancestors)


def _render_owncast_chat_bridge_html(*, bridge_token, access_token, display_name, platform_display_name, next_path):
    html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Opening chat...</title>
    <style>
      html, body {{
        margin: 0;
        padding: 0;
        background: #0b0f19;
        color: #d8dbe3;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }}
      main {{
        min-height: 100vh;
        display: grid;
        place-items: center;
        text-align: center;
        padding: 24px;
      }}
      p {{ margin: 0.5rem 0; }}
      a {{ color: #ffffff; }}
    </style>
  </head>
  <body>
    <main>
      <div>
        <p>Preparing Owncast chat session...</p>
        <p>If you are not redirected automatically, <a href="{next_path}">open chat</a>.</p>
      </div>
    </main>
    <script>
      (() => {{
        const accessToken = {json.dumps(access_token)};
        const displayName = {json.dumps(display_name)};
        const platformDisplayName = {json.dumps(platform_display_name)};
        const nextPath = {json.dumps(next_path)};
        const bridgeToken = {json.dumps(bridge_token)};
        const syncPath = "/api/realtime/owncast/chat-bridge/";
        const normalizeName = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
        const sameName = (left, right) => normalizeName(left).toLocaleLowerCase() === normalizeName(right).toLocaleLowerCase();
        let storedUsername = "";
        try {{
          storedUsername = normalizeName(localStorage.getItem("username"));
        }} catch (error) {{
          storedUsername = "";
        }}
        const normalizedDisplayName = normalizeName(displayName);
        const normalizedPlatformName = normalizeName(platformDisplayName);
        if (storedUsername && normalizedPlatformName && sameName(storedUsername, normalizedPlatformName)) {{
          storedUsername = "";
          try {{
            localStorage.removeItem("username");
          }} catch (error) {{
            // best effort only
          }}
        }}
        const displayNameLooksLikePlatformName =
          normalizedDisplayName && normalizedPlatformName && sameName(normalizedDisplayName, normalizedPlatformName);
        const effectiveDisplayName = storedUsername || (displayNameLooksLikePlatformName ? "" : normalizedDisplayName);
        try {{
          localStorage.setItem("accessToken", accessToken);
          if (effectiveDisplayName) {{
            localStorage.setItem("username", effectiveDisplayName);
          }}
        }} catch (error) {{
          // best effort only
        }}
        if (effectiveDisplayName && effectiveDisplayName !== normalizeName(displayName)) {{
          const payload = JSON.stringify({{ token: bridgeToken, display_name: effectiveDisplayName }});
          try {{
            if (navigator.sendBeacon) {{
              navigator.sendBeacon(syncPath, new Blob([payload], {{ type: "application/json" }}));
            }} else {{
              fetch(syncPath, {{
                method: "POST",
                headers: {{ "Content-Type": "application/json" }},
                body: payload,
                credentials: "omit",
                keepalive: true,
              }}).catch(() => {{}});
            }}
          }} catch (error) {{
            // best effort only
          }}
        }}
        window.location.replace(nextPath);
      }})();
    </script>
  </body>
</html>
"""
    response = HttpResponse(html, content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-store, max-age=0"
    response["Content-Security-Policy"] = (
        "default-src 'none'; "
        "script-src 'unsafe-inline'; "
        "style-src 'unsafe-inline'; "
        "connect-src 'self'; "
        "base-uri 'none'; "
        "form-action 'none'; "
        f"frame-ancestors {_owncast_chat_bridge_frame_ancestors()}"
    )
    response["Cross-Origin-Embedder-Policy"] = "unsafe-none"
    response["Cross-Origin-Opener-Policy"] = "unsafe-none"
    response["Cross-Origin-Resource-Policy"] = "cross-origin"
    response.xframe_options_exempt = True
    return response


def _can_manage_session(user, session):
    return bool(getattr(session, "is_moderator_allowed", None) and session.is_moderator_allowed(user))


def _build_session_list_cache_key(
    *,
    user_id,
    is_admin,
    session_type,
    status_filter,
    paginate,
    page,
    page_size,
):
    normalized_session_type = session_type or "-"
    normalized_status = status_filter or "-"
    normalized_paginate = 1 if paginate else 0
    normalized_page = int(page or 1)
    normalized_page_size = int(page_size or 20)
    return (
        "realtime-session-list:"
        f"user={user_id}:"
        f"admin={1 if is_admin else 0}:"
        f"session_type={normalized_session_type}:"
        f"status={normalized_status}:"
        f"paginate={normalized_paginate}:"
        f"page={normalized_page}:"
        f"page_size={normalized_page_size}"
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


def _sync_owncast_chat_settings_non_blocking(*, session):
    if str(getattr(session, "session_type", "")).strip() != RealtimeSession.TYPE_BROADCASTING:
        return
    if not str(getattr(settings, "OWNCAST_ADMIN_PASSWORD", "") or "").strip():
        return
    try:
        result = sync_owncast_chat_settings()
        warnings = result.get("warnings") or []
        if warnings:
            realtime_ops_logger.warning(
                "Realtime broadcast chat sync warnings. session_id=%s warnings=%s",
                getattr(session, "id", None),
                warnings,
            )
    except (OwncastConfigError, OwncastAdminError) as exc:
        realtime_ops_logger.warning(
            "Realtime broadcast chat sync skipped. session_id=%s error=%s",
            getattr(session, "id", None),
            str(exc),
        )


def _rotate_obs_stream_key_if_enabled(*, session, force=False):
    if (
        session.session_type != RealtimeSession.TYPE_BROADCASTING
        or session.stream_service != RealtimeSession.STREAM_SERVICE_OBS
    ):
        return {"rotated": False, "error": ""}

    # Fixed-key mode for Owncast OBS ingest:
    # always sync and use canonical key from settings/target, never rotate per session.
    fixed_key = str(session.default_obs_stream_key() or "").strip()
    if not fixed_key:
        return {"rotated": False, "error": "Unable to resolve fixed OBS stream key."}

    try:
        sync_owncast_stream_key(fixed_key)
    except (OwncastConfigError, OwncastAdminError) as exc:
        return {"rotated": False, "error": str(exc)}

    session.obs_stream_key = fixed_key
    session.save(update_fields=["obs_stream_key", "updated_at"])
    return {"rotated": True, "error": ""}


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
            {"session_type", "status", "paginate", "page", "page_size"},
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
        paginate_requested = str(request.query_params.get("paginate", "")).strip().lower() in {
            "1",
            "true",
            "yes",
        }
        page = request.query_params.get("page", "1")
        page_size = request.query_params.get("page_size", "20")
        is_admin = bool(getattr(request.user, "is_staff", False) or getattr(request.user, "is_superuser", False))
        cache_ttl = max(0, int(getattr(settings, "REALTIME_SESSION_LIST_CACHE_TTL_SECONDS", 5)))
        cache_key = _build_session_list_cache_key(
            user_id=request.user.id,
            is_admin=is_admin,
            session_type=session_type,
            status_filter=status_filter,
            paginate=paginate_requested,
            page=page,
            page_size=page_size,
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
        paged_queryset, page_meta = apply_optional_pagination(
            request,
            queryset,
            default_page_size=20,
            max_page_size=100,
        )
        serializer = RealtimeSessionListSerializer(paged_queryset, many=True, context={"request": request})
        payload = (
            {"results": serializer.data, "pagination": page_meta}
            if page_meta is not None
            else serializer.data
        )
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
        is_admin = bool(getattr(request.user, "is_staff", False) or getattr(request.user, "is_superuser", False))
        is_instructor = str(getattr(request.user, "role", "")).strip().lower() == "instructor"
        if not (is_admin or is_instructor):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only admin or instructor accounts can create live sessions."},
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

        linked_live_class = serializer.validated_data.get("linked_live_class")
        if not is_admin:
            linked_course = getattr(linked_live_class, "linked_course", None)
            if not linked_course or linked_course.instructor_id != request.user.id:
                return api_response(
                    success=False,
                    message="Access denied.",
                    errors={
                        "detail": (
                            "Instructors can create sessions only for live classes assigned to their courses."
                        )
                    },
                    status_code=status.HTTP_403_FORBIDDEN,
                )

        payload = session_payload_for_create(serializer.validated_data)

        session = RealtimeSession.objects.create(host=request.user, **payload)
        _sync_owncast_chat_settings_non_blocking(session=session)
        if (
            session.session_type == RealtimeSession.TYPE_BROADCASTING
            and session.stream_service == RealtimeSession.STREAM_SERVICE_OBS
        ):
            stream_key = str(session.default_obs_stream_key() or "").strip()
            if not stream_key:
                session.delete()
                return api_response(
                    success=False,
                    message="Unable to create OBS broadcast session.",
                    errors={"detail": "Fixed OBS stream key is not configured."},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            session.obs_stream_key = stream_key
            session.save(update_fields=["obs_stream_key", "updated_at"])
            try:
                sync_owncast_stream_key(stream_key)
            except (OwncastConfigError, OwncastAdminError) as exc:
                session.delete()
                return api_response(
                    success=False,
                    message="Unable to create OBS broadcast session.",
                    errors={"detail": str(exc)},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )

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
        refresh_obs_session_stream_health(session)
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
        prefer_broadcast = bool(serializer.validated_data.get("prefer_broadcast", False))

        access_decision = get_access_decision(session, request.user)
        if not access_decision.allowed:
            _record_join_metric(result="failure", mode="meeting", reason="access_denied")
            return api_response(
                success=False,
                message=access_decision.message,
                errors={"detail": access_decision.detail},
                status_code=access_decision.status_code,
            )
        refresh_obs_session_stream_health(session, force_refresh=True)
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

        should_use_broadcast = participant_state.should_use_broadcast
        if session.session_type == RealtimeSession.TYPE_BROADCASTING:
            if prefer_broadcast:
                should_use_broadcast = True
            elif permissions_set.can_publish:
                # StreamYard-like flow: moderators/stage users join interactive room,
                # while regular attendees stay in broadcast viewer mode.
                should_use_broadcast = False

        if should_use_broadcast:
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
                    "stream_launch_url": _build_owncast_stream_launch_url(
                        session=session,
                        user=request.user,
                        request=request,
                        stream_embed_url=urls["stream_embed_url"],
                    ),
                    "stream_access_expires_in_seconds": _owncast_stream_access_ttl_seconds(),
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


class RealtimeSessionOwncastStreamLaunchView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.with_related(), pk=pk)
        access_decision = get_access_decision(session, request.user)
        if not access_decision.allowed:
            return api_response(
                success=False,
                message=access_decision.message,
                errors={"detail": access_decision.detail},
                status_code=access_decision.status_code,
            )
        if session.session_type != RealtimeSession.TYPE_BROADCASTING and not session.allow_overflow_broadcast:
            return api_response(
                success=False,
                message="Broadcast stream launch unavailable.",
                errors={"detail": "This endpoint is available only for broadcast-enabled sessions."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if session.status == RealtimeSession.STATUS_ENDED:
            return api_response(
                success=False,
                message="Broadcast stream launch unavailable.",
                errors={"detail": "This live session has ended."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        urls = resolve_broadcast_urls(session, request=request)
        stream_embed_url = str(urls.get("stream_embed_url") or "").strip()
        if not stream_embed_url:
            return api_response(
                success=False,
                message="Broadcast stream launch unavailable.",
                errors={"detail": "Broadcast stream URL is not configured for this session."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        launch_url = _build_owncast_stream_launch_url(
            session=session,
            user=request.user,
            request=request,
            stream_embed_url=stream_embed_url,
        )
        if not launch_url:
            return api_response(
                success=False,
                message="Broadcast stream launch unavailable.",
                errors={"detail": "Broadcast stream URL must be a public http/https URL."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        return api_response(
            success=True,
            message="Owncast stream launch URL prepared.",
            data={
                "launch_url": launch_url,
                "stream_embed_url": stream_embed_url,
                "expires_in_seconds": _owncast_stream_access_ttl_seconds(),
            },
        )


class RealtimeSessionOwncastChatLaunchView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.with_related(), pk=pk)
        access_decision = get_access_decision(session, request.user)
        if not access_decision.allowed:
            return api_response(
                success=False,
                message=access_decision.message,
                errors={"detail": access_decision.detail},
                status_code=access_decision.status_code,
            )
        if session.session_type != RealtimeSession.TYPE_BROADCASTING:
            return api_response(
                success=False,
                message="Broadcast chat launch unavailable.",
                errors={"detail": "This endpoint is available only for broadcasting sessions."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if not bool(getattr(settings, "OWNCAST_CHAT_BRIDGE_ENABLED", False)):
            return api_response(
                success=False,
                message="Broadcast chat bridge is disabled.",
                errors={"detail": "Enable OWNCAST_CHAT_BRIDGE_ENABLED to use personalized Owncast chat launch."},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        try:
            release_expired_owncast_chat_timeouts(timeout=4)
        except (OwncastConfigError, OwncastAdminError) as exc:
            realtime_ops_logger.warning("Owncast chat timeout release skipped during launch: %s", exc)

        urls = resolve_broadcast_urls(session, request=request)
        chat_embed_url = str(urls.get("chat_embed_url") or "").strip()
        chat_origin = _resolve_owncast_chat_origin(chat_embed_url)
        if not chat_origin:
            return api_response(
                success=False,
                message="Broadcast chat launch unavailable.",
                errors={"detail": "Broadcast chat URL is not configured for this session."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        platform_display_name = _resolve_owncast_display_name(request.user)
        platform_user_id = int(request.user.id)
        chat_identity = (
            OwncastChatIdentity.objects.filter(platform_user_id=platform_user_id)
            .order_by("-updated_at", "-id")
            .first()
        )
        access_token = chat_identity.reveal_access_token() if chat_identity else ""
        chat_user = {}

        if not access_token:
            try:
                chat_user = register_owncast_chat_user(display_name="")
            except (OwncastConfigError, OwncastAdminError) as exc:
                return api_response(
                    success=False,
                    message="Unable to prepare broadcast chat session.",
                    errors={"detail": str(exc)},
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            access_token = str(chat_user.get("access_token") or "").strip()

        if not access_token:
            return api_response(
                success=False,
                message="Unable to prepare broadcast chat session.",
                errors={"detail": "Owncast did not return a chat access token."},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        def persist_chat_identity(identity, *, token, owncast_user):
            if owncast_user:
                resolved_name = _owncast_display_name_for_storage(
                    owncast_user.get("display_name"),
                    platform_display_name=platform_display_name,
                ) or _owncast_display_name_for_storage(
                    getattr(identity, "owncast_display_name", ""),
                    platform_display_name=platform_display_name,
                )
                owncast_user_id = str(owncast_user.get("owncast_user_id") or "").strip()[:120]
            else:
                resolved_name = _owncast_display_name_for_storage(
                    getattr(identity, "owncast_display_name", ""),
                    platform_display_name=platform_display_name,
                )
                owncast_user_id = str(getattr(identity, "owncast_user_id", "") or "").strip()[:120]

            bridge_display_name = resolved_name
            resolved_name = resolved_name or _OWNCAST_PENDING_DISPLAY_NAME
            token_hash = OwncastChatIdentity.hash_access_token(token)
            access_token_secret = (
                OwncastChatIdentity.seal_access_token(token)
                if owncast_user
                else getattr(identity, "access_token_secret", "")
                or ""
            )
            identity_defaults = {
                "user": request.user,
                "platform_user_id": platform_user_id,
                "platform_email": str(getattr(request.user, "email", "") or "")[:254],
                "platform_full_name": str(getattr(request.user, "full_name", "") or "")[:255],
                "platform_role": str(getattr(request.user, "role", "") or "")[:40],
                "platform_display_name": platform_display_name[:120],
                "owncast_display_name": resolved_name[:120],
                "owncast_display_color": str(
                    owncast_user.get("display_color")
                    if owncast_user
                    else getattr(identity, "owncast_display_color", "")
                    or ""
                )[:32],
                "owncast_authenticated": bool(
                    owncast_user.get("authenticated")
                    if owncast_user
                    else getattr(identity, "owncast_authenticated", False)
                ),
                "launch_ip": str(resolve_client_ip(request) or "")[:64],
                "user_agent": str(request.META.get("HTTP_USER_AGENT", "") or "")[:255],
            }

            if identity:
                for field, value in identity_defaults.items():
                    setattr(identity, field, value)
                identity.session = session
                identity.owncast_user_id = owncast_user_id
                identity.access_token_hash = token_hash
                identity.access_token_secret = access_token_secret
                identity.save(
                    update_fields=[
                        "session",
                        "user",
                        "platform_user_id",
                        "platform_email",
                        "platform_full_name",
                        "platform_role",
                        "platform_display_name",
                        "owncast_user_id",
                        "owncast_display_name",
                        "owncast_display_color",
                        "owncast_authenticated",
                        "access_token_hash",
                        "access_token_secret",
                        "launch_ip",
                        "user_agent",
                        "updated_at",
                    ]
                )
                return identity, resolved_name, bridge_display_name

            created_identity = OwncastChatIdentity.objects.create(
                session=session,
                owncast_user_id=owncast_user_id,
                access_token_hash=token_hash,
                access_token_secret=access_token_secret,
                **identity_defaults,
            )
            return created_identity, resolved_name, bridge_display_name

        try:
            chat_identity, resolved_display_name, bridge_display_name = persist_chat_identity(
                chat_identity,
                token=access_token,
                owncast_user=chat_user,
            )
        except IntegrityError:
            chat_identity = OwncastChatIdentity.objects.get(platform_user_id=platform_user_id)
            persisted_access_token = chat_identity.reveal_access_token()
            if persisted_access_token:
                access_token = persisted_access_token
                chat_user = {}
            chat_identity, resolved_display_name, bridge_display_name = persist_chat_identity(
                chat_identity,
                token=access_token,
                owncast_user=chat_user,
            )

        bridge_payload = signing.dumps(
            {
                "access_token": access_token,
                "display_name": bridge_display_name,
                "platform_display_name": platform_display_name,
                "next_path": _OWNCAST_CHAT_BRIDGE_NEXT_PATH,
                "session_id": int(session.id),
                "user_id": int(request.user.id),
                "identity_id": int(chat_identity.id),
            },
            salt=_OWNCAST_CHAT_BRIDGE_SIGNING_SALT,
            compress=True,
        )
        launch_url = f"{chat_origin}/api/realtime/owncast/chat-bridge/?token={quote(bridge_payload, safe='')}"
        return api_response(
            success=True,
            message="Owncast chat launch URL prepared.",
            data={
                "launch_url": launch_url,
                "chat_embed_url": chat_embed_url,
                "display_name": resolved_display_name,
                "expires_in_seconds": _owncast_chat_bridge_ttl_seconds(),
            },
        )


def _serialize_owncast_identity(identity, *, disabled_ids, moderator_ids):
    is_timeout_active = bool(
        identity.owncast_timeout_until
        and identity.owncast_timeout_until > timezone.now()
        and identity.owncast_disabled_at
    )
    return {
        "id": identity.id,
        "owncast_user_id": identity.owncast_user_id,
        "owncast_display_name": identity.owncast_display_name,
        "platform_user_id": identity.platform_user_id,
        "platform_email": identity.platform_email,
        "platform_full_name": identity.platform_full_name,
        "platform_role": identity.platform_role,
        "last_session_id": identity.session_id,
        "last_session_title": str(identity.session or "") if identity.session_id else "",
        "bridge_used_at": identity.bridge_used_at,
        "launch_ip": identity.launch_ip,
        "is_disabled": bool(identity.owncast_user_id in disabled_ids or identity.owncast_disabled_at),
        "is_timeout_active": is_timeout_active,
        "timeout_until": identity.owncast_timeout_until,
        "is_moderator": bool(identity.owncast_user_id in moderator_ids or identity.owncast_is_moderator),
        "updated_at": identity.updated_at,
    }


def _build_owncast_chat_moderation_payload(*, session, request):
    release_expired_owncast_chat_timeouts()
    sync_result = sync_owncast_chat_identities_from_recent_messages(limit=500, timeout=5)
    messages = fetch_owncast_chat_messages_admin(limit=100, timeout=5)
    disabled_users = fetch_owncast_disabled_chat_users(timeout=5)
    moderator_users = fetch_owncast_moderator_chat_users(timeout=5)
    ip_bans = fetch_owncast_ip_bans(timeout=5)

    disabled_ids = {str(user.get("id") or "").strip() for user in disabled_users if user.get("id")}
    moderator_ids = {str(user.get("id") or "").strip() for user in moderator_users if user.get("id")}
    message_user_ids = {
        str(message.get("user", {}).get("id") or "").strip()
        for message in messages
        if message.get("user", {}).get("id")
    }
    relevant_user_ids = disabled_ids | moderator_ids | message_user_ids

    identities = OwncastChatIdentity.objects.select_related("session", "user")
    if relevant_user_ids:
        identities = identities.filter(Q(owncast_user_id__in=relevant_user_ids) | Q(session=session))
    else:
        identities = identities.filter(session=session)
    identities = identities.exclude(owncast_user_id="").order_by("-updated_at", "-id")[:200]

    return {
        "session": RealtimeSessionListSerializer(session, context={"request": request}).data,
        "sync": sync_result,
        "identities": [
            _serialize_owncast_identity(
                identity,
                disabled_ids=disabled_ids,
                moderator_ids=moderator_ids,
            )
            for identity in identities
        ],
        "recent_messages": messages,
        "disabled_users": disabled_users,
        "moderator_users": moderator_users,
        "ip_bans": ip_bans,
        "available_actions": [
            "ban_user",
            "unban_user",
            "timeout_user",
            "grant_moderator",
            "revoke_moderator",
            "hide_messages",
            "show_messages",
            "ban_ip",
            "unban_ip",
            "sync_handles",
        ],
    }


class RealtimeSessionOwncastChatModerationView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def _get_session(self, request, pk):
        session = get_object_or_404(RealtimeSession.objects.with_related(), pk=pk)
        if not _can_manage_session(request.user, session):
            return session, api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can moderate broadcast chat."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if session.session_type != RealtimeSession.TYPE_BROADCASTING:
            return session, api_response(
                success=False,
                message="Broadcast chat moderation unavailable.",
                errors={"detail": "Chat moderation is available only for broadcasting sessions."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        return session, None

    def get(self, request, pk):
        session, error_response = self._get_session(request, pk)
        if error_response:
            return error_response
        try:
            data = _build_owncast_chat_moderation_payload(session=session, request=request)
        except (OwncastConfigError, OwncastAdminError) as exc:
            return api_response(
                success=False,
                message="Unable to load Owncast chat moderation state.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        return api_response(success=True, message="Owncast chat moderation state fetched.", data=data)

    def post(self, request, pk):
        session, error_response = self._get_session(request, pk)
        if error_response:
            return error_response

        serializer = RealtimeOwncastChatModerationActionSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Owncast chat moderation action failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        action = serializer.validated_data["action"]
        owncast_user_id = str(serializer.validated_data.get("owncast_user_id") or "").strip()
        message_ids = serializer.validated_data.get("message_ids") or []
        ip_address = str(serializer.validated_data.get("ip_address") or "").strip()
        duration_seconds = int(serializer.validated_data.get("duration_seconds") or 0)
        now = timezone.now()
        owncast_result = {}

        try:
            if action == RealtimeOwncastChatModerationActionSerializer.ACTION_SYNC_HANDLES:
                sync_owncast_chat_identities_from_recent_messages(limit=500, timeout=5)
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_BAN_USER:
                owncast_result = owncast_set_chat_user_enabled(owncast_user_id=owncast_user_id, enabled=False)
                OwncastChatIdentity.objects.filter(owncast_user_id=owncast_user_id).update(
                    owncast_disabled_at=now,
                    owncast_timeout_until=None,
                    updated_at=now,
                )
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_UNBAN_USER:
                owncast_result = owncast_set_chat_user_enabled(owncast_user_id=owncast_user_id, enabled=True)
                OwncastChatIdentity.objects.filter(owncast_user_id=owncast_user_id).update(
                    owncast_disabled_at=None,
                    owncast_timeout_until=None,
                    updated_at=now,
                )
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_TIMEOUT_USER:
                timeout_until = now + timedelta(seconds=duration_seconds)
                owncast_result = owncast_set_chat_user_enabled(owncast_user_id=owncast_user_id, enabled=False)
                OwncastChatIdentity.objects.filter(owncast_user_id=owncast_user_id).update(
                    owncast_disabled_at=now,
                    owncast_timeout_until=timeout_until,
                    updated_at=now,
                )
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_GRANT_MODERATOR:
                owncast_result = owncast_set_chat_user_moderator(
                    owncast_user_id=owncast_user_id,
                    is_moderator=True,
                )
                OwncastChatIdentity.objects.filter(owncast_user_id=owncast_user_id).update(
                    owncast_is_moderator=True,
                    updated_at=now,
                )
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_REVOKE_MODERATOR:
                owncast_result = owncast_set_chat_user_moderator(
                    owncast_user_id=owncast_user_id,
                    is_moderator=False,
                )
                OwncastChatIdentity.objects.filter(owncast_user_id=owncast_user_id).update(
                    owncast_is_moderator=False,
                    updated_at=now,
                )
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_HIDE_MESSAGES:
                owncast_result = owncast_set_chat_message_visibility(message_ids=message_ids, visible=False)
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_SHOW_MESSAGES:
                owncast_result = owncast_set_chat_message_visibility(message_ids=message_ids, visible=True)
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_BAN_IP:
                owncast_result = owncast_ban_ip_address(ip_address=ip_address)
            elif action == RealtimeOwncastChatModerationActionSerializer.ACTION_UNBAN_IP:
                owncast_result = owncast_remove_ip_ban(ip_address=ip_address)
        except (OwncastConfigError, OwncastAdminError) as exc:
            return api_response(
                success=False,
                message="Owncast chat moderation action failed.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            data = _build_owncast_chat_moderation_payload(session=session, request=request)
        except (OwncastConfigError, OwncastAdminError):
            data = {"owncast_result": owncast_result}
        return api_response(success=True, message="Owncast chat moderation action applied.", data=data)


class RealtimeOwncastChatBridgeView(APIView):
    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = []

    def get(self, request):
        token = str(request.query_params.get("token") or "").strip()
        if not token:
            return api_response(
                success=False,
                message="Invalid chat bridge request.",
                errors={"detail": "Missing chat bridge token."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            payload = _decode_owncast_chat_bridge_payload(token)
        except signing.BadSignature:
            return api_response(
                success=False,
                message="Invalid chat bridge request.",
                errors={"detail": "Chat bridge token is invalid or expired."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        access_token = str(payload.get("access_token") or "").strip()
        if not access_token:
            return api_response(
                success=False,
                message="Invalid chat bridge request.",
                errors={"detail": "Chat bridge token did not include an access token."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        display_name = str(payload.get("display_name") or "").strip()[:80]
        try:
            identity_id = int(payload.get("identity_id") or 0)
        except (TypeError, ValueError):
            identity_id = 0
        if identity_id > 0:
            now = timezone.now()
            OwncastChatIdentity.objects.filter(pk=identity_id).update(
                bridge_used_at=now,
                updated_at=now,
            )

        return _render_owncast_chat_bridge_html(
            bridge_token=token,
            access_token=access_token,
            display_name=display_name,
            platform_display_name=str(payload.get("platform_display_name") or "").strip()[:80],
            next_path=_OWNCAST_CHAT_BRIDGE_NEXT_PATH,
        )

    def post(self, request):
        token = str(request.data.get("token") or "").strip()
        display_name = _clean_owncast_display_name(request.data.get("display_name"))
        if not token or not display_name:
            return api_response(
                success=False,
                message="Invalid chat bridge request.",
                errors={"detail": "Chat bridge token and Owncast display name are required."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            payload = _decode_owncast_chat_bridge_payload(token)
        except signing.BadSignature:
            return api_response(
                success=False,
                message="Invalid chat bridge request.",
                errors={"detail": "Chat bridge token is invalid or expired."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            identity_id = int(payload.get("identity_id") or 0)
            platform_user_id = int(payload.get("user_id") or 0)
        except (TypeError, ValueError):
            identity_id = 0
            platform_user_id = 0

        access_token = str(payload.get("access_token") or "").strip()
        display_name = _owncast_display_name_for_storage(
            display_name,
            platform_display_name=str(payload.get("platform_display_name") or ""),
        )
        if not display_name:
            return api_response(
                success=False,
                message="Invalid chat bridge request.",
                errors={"detail": "Owncast display name could not be verified as a chat handle."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        token_hash = OwncastChatIdentity.hash_access_token(access_token)
        identity = (
            OwncastChatIdentity.objects.filter(
                pk=identity_id,
                platform_user_id=platform_user_id,
            )
            .exclude(access_token_hash="")
            .first()
        )
        if not identity or identity.access_token_hash != token_hash:
            return api_response(
                success=False,
                message="Invalid chat bridge request.",
                errors={"detail": "Chat bridge identity could not be verified."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        if identity.owncast_display_name != display_name:
            identity.owncast_display_name = display_name
            identity.updated_at = timezone.now()
            identity.save(update_fields=["owncast_display_name", "updated_at"])

        return api_response(
            success=True,
            message="Owncast display name synced.",
            data={"display_name": display_name},
        )


class RealtimeOwncastStreamBridgeView(APIView):
    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = []

    def get(self, request):
        token = str(request.query_params.get("token") or "").strip()
        if not token:
            return api_response(
                success=False,
                message="Invalid stream bridge request.",
                errors={"detail": "Missing stream bridge token."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            payload = signing.loads(
                token,
                max_age=_owncast_stream_access_ttl_seconds(),
                salt=_OWNCAST_STREAM_BRIDGE_SIGNING_SALT,
            )
        except signing.BadSignature:
            return api_response(
                success=False,
                message="Invalid stream bridge request.",
                errors={"detail": "Stream bridge token is invalid or expired."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        expected_user_agent_hash = str(payload.get("user_agent_hash") or "").strip()
        if expected_user_agent_hash and expected_user_agent_hash != _request_user_agent_hash(request):
            return api_response(
                success=False,
                message="Invalid stream bridge request.",
                errors={"detail": "Stream bridge token does not match this browser."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        expected_client_ip = str(payload.get("client_ip") or "").strip()
        current_client_ip = str(resolve_client_ip(request) or "").strip()
        if expected_client_ip and current_client_ip and expected_client_ip != current_client_ip:
            return api_response(
                success=False,
                message="Invalid stream bridge request.",
                errors={"detail": "Stream bridge token does not match this network."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            session_id = int(payload.get("session_id") or 0)
            user_id = int(payload.get("user_id") or 0)
        except (TypeError, ValueError):
            session_id = 0
            user_id = 0
        if session_id <= 0 or user_id <= 0:
            return api_response(
                success=False,
                message="Invalid stream bridge request.",
                errors={"detail": "Stream bridge token is missing session details."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        cookie_payload = signing.dumps(
            {
                "session_id": session_id,
                "user_id": user_id,
                "issued_at": int(time.time()),
            },
            salt=_OWNCAST_STREAM_ACCESS_SIGNING_SALT,
            compress=True,
        )
        next_path = str(payload.get("next_path") or _OWNCAST_STREAM_BRIDGE_NEXT_PATH)
        if not next_path.startswith("/") or next_path.startswith("//"):
            next_path = _OWNCAST_STREAM_BRIDGE_NEXT_PATH

        response = HttpResponseRedirect(next_path)
        response["Cache-Control"] = "no-store, max-age=0"
        response["Cross-Origin-Resource-Policy"] = "cross-origin"
        response["Cross-Origin-Embedder-Policy"] = "unsafe-none"
        response["Cross-Origin-Opener-Policy"] = "unsafe-none"
        response.xframe_options_exempt = True
        secure_cookie = _is_secure_request(request)
        response.set_cookie(
            _owncast_stream_access_cookie_name(),
            cookie_payload,
            max_age=_owncast_stream_access_ttl_seconds(),
            path="/",
            secure=secure_cookie,
            httponly=True,
            samesite="None" if secure_cookie else "Lax",
        )
        return response


class RealtimeOwncastStreamAccessView(APIView):
    permission_classes = [permissions.AllowAny]
    authentication_classes = []
    throttle_classes = []

    def get(self, request):
        cookie_value = str(request.COOKIES.get(_owncast_stream_access_cookie_name()) or "").strip()
        if not cookie_value:
            return HttpResponse(status=401)

        try:
            payload = signing.loads(
                cookie_value,
                max_age=_owncast_stream_access_ttl_seconds(),
                salt=_OWNCAST_STREAM_ACCESS_SIGNING_SALT,
            )
            session_id = int(payload.get("session_id") or 0)
            user_id = int(payload.get("user_id") or 0)
        except (signing.BadSignature, TypeError, ValueError):
            return HttpResponse(status=401)

        session = RealtimeSession.objects.with_related().filter(pk=session_id).first()
        user = User.objects.filter(pk=user_id, is_active=True).first()
        if not session or not user or session.status == RealtimeSession.STATUS_ENDED:
            return HttpResponse(status=401)
        if session.session_type != RealtimeSession.TYPE_BROADCASTING and not session.allow_overflow_broadcast:
            return HttpResponse(status=401)

        access_decision = get_access_decision(session, user)
        if not access_decision.allowed:
            return HttpResponse(status=403)

        response = HttpResponse(status=204)
        response["Cache-Control"] = "no-store, max-age=0"
        return response


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

        if (
            session.stream_service == RealtimeSession.STREAM_SERVICE_OBS
            and session.stream_status != RealtimeSession.STREAM_STOPPED
        ):
            rotation_result = _rotate_obs_stream_key_if_enabled(session=session)
            if rotation_result["error"]:
                session.livekit_egress_error = str(rotation_result["error"])[:1000]
                session.save(update_fields=["livekit_egress_error", "updated_at"])

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
    if session.session_type not in {RealtimeSession.TYPE_MEETING, RealtimeSession.TYPE_BROADCASTING}:
        return api_response(
            success=False,
            message="Participant control unavailable.",
            errors={"detail": "Participant permissions are supported for meeting and broadcast sessions only."},
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

    target_label = "Stage" if permission_kind == "presenter" else "Mic"
    try:
        if permission_kind == "presenter":
            actor = session.grant_presenter if permission_action == "grant" else session.revoke_presenter
            presenter_ids = actor(target_user_id)
            speaker_ids = session.get_speaker_user_ids()
            allow_presenter = bool(
                session.is_moderator_allowed(target_user) or target_user_id in presenter_ids
            )
            allow_microphone = bool(
                session.is_moderator_allowed(target_user) or target_user_id in speaker_ids
            )
            live_update = apply_live_presenter_permission_update(
                session=session,
                target_user_id=target_user_id,
                allow_presenter=allow_presenter,
                allow_microphone=allow_microphone,
            )
        else:
            actor = session.grant_speaker if permission_action == "grant" else session.revoke_speaker
            speaker_ids = actor(target_user_id)
            presenter_ids = session.get_presenter_user_ids()
            allow_presenter = bool(
                session.is_moderator_allowed(target_user) or target_user_id in presenter_ids
            )
            allow_microphone = bool(
                session.is_moderator_allowed(target_user) or target_user_id in speaker_ids
            )
            live_update = apply_live_speaker_permission_update(
                session=session,
                target_user_id=target_user_id,
                allow_presenter=allow_presenter,
                allow_microphone=allow_microphone,
            )
    except DjangoValidationError as exc:
        error_payload = {"detail": str(exc)}
        if hasattr(exc, "message_dict") and exc.message_dict:
            error_payload = exc.message_dict
        return api_response(
            success=False,
            message="Participant permission update failed.",
            errors=error_payload,
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    if permission_action == "grant":
        message = f"{target_label} access granted."
    else:
        message = f"{target_label} access revoked."

    note = "Permission update saved."
    connected_matches = int(live_update.get("connected_matches") or 0)
    if connected_matches <= 0:
        note = "Permission saved. The user is not currently connected; it will apply on next join."
    elif live_update.get("applied"):
        note = "Permission applied instantly for connected participant sessions."
    elif permission_kind == "speaker":
        note = "Permission saved. Live update was partial; ask the participant to toggle microphone once."
    else:
        note = "Permission saved. Live update was partial; ask the participant to refresh camera/screen sharing."

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
        "note": note,
        "live_update": live_update,
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
        realtime_config = RealtimeConfiguration.get_solo()
        canonical_obs_key = str(session.default_obs_stream_key() or "").strip()
        if session.stream_service == RealtimeSession.STREAM_SERVICE_OBS and canonical_obs_key:
            if str(session.obs_stream_key or "").strip() != canonical_obs_key:
                session.obs_stream_key = canonical_obs_key
                session.save(update_fields=["obs_stream_key", "updated_at"])
        if session.stream_service == RealtimeSession.STREAM_SERVICE_OBS:
            return api_response(
                success=True,
                message="OBS stream details ready.",
                data={
                    "session": RealtimeSessionListSerializer(session, context={"request": request}).data,
                    "stream_service": session.stream_service,
                    "broadcast_profile": realtime_config.to_broadcast_dict(
                        audience_count=session.max_audience,
                        max_audience=session.max_audience,
                    ),
                    "obs": {
                        "stream_server_url": resolve_obs_stream_server_url(request=request, session=session),
                        "stream_key": canonical_obs_key,
                    },
                },
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
        return api_response(
            success=True,
            message="Host publisher token created.",
            data={
                "session": RealtimeSessionListSerializer(session, context={"request": request}).data,
                "stream_service": session.stream_service,
                "livekit_url": livekit_client_url,
                "room_name": session.livekit_room_name or session.room_name,
                "participant_identity": token_payload["identity"],
                "token": token_payload["token"],
                "broadcast_profile": realtime_config.to_broadcast_dict(
                    audience_count=session.max_audience,
                    max_audience=session.max_audience,
                ),
                "obs": {
                    "stream_server_url": resolve_obs_stream_server_url(request=request, session=session),
                    "stream_key": canonical_obs_key,
                },
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

        rtmp_target_url = session.resolve_stream_target_url()
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

        if (
            session.stream_service != RealtimeSession.STREAM_SERVICE_OBS
            and session.stream_status == RealtimeSession.STREAM_LIVE
            and session.livekit_egress_id
        ):
            return api_response(
                success=True,
                message="Stream already live.",
                data=RealtimeSessionListSerializer(session, context={"request": request}).data,
            )

        was_obs_marked_live = (
            session.stream_service == RealtimeSession.STREAM_SERVICE_OBS
            and session.stream_status == RealtimeSession.STREAM_LIVE
        )
        session.mark_stream_starting()
        if session.stream_service == RealtimeSession.STREAM_SERVICE_OBS:
            stream_key = str(session.default_obs_stream_key() or "").strip()
            if not stream_key:
                session.mark_stream_failed("Fixed OBS stream key is not configured.")
                return api_response(
                    success=False,
                    message="Unable to prepare OBS stream key.",
                    errors={"detail": "Fixed OBS stream key is not configured."},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            session.obs_stream_key = stream_key
            session.save(update_fields=["obs_stream_key", "updated_at"])
            try:
                sync_owncast_stream_key(stream_key)
            except (OwncastConfigError, OwncastAdminError) as exc:
                session.mark_stream_failed(str(exc))
                return api_response(
                    success=False,
                    message="Unable to prepare OBS stream key.",
                    errors={"detail": str(exc)},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            refresh_obs_session_stream_health(session, force_refresh=True)
            session.livekit_egress_error = ""
            session.save(update_fields=["livekit_egress_error", "updated_at"])
            _sync_owncast_chat_settings_non_blocking(session=session)
            data = RealtimeSessionListSerializer(session, context={"request": request}).data
            message = "OBS stream prepared. Start streaming from OBS now."
            if was_obs_marked_live:
                message = (
                    "OBS stream re-prepared. If OBS showed a disconnect warning, "
                    "resume publishing with the same server URL and key now."
                )
            return api_response(success=True, message=message, data=data)

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
            _sync_owncast_chat_settings_non_blocking(session=session)
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

        if session.stream_service == RealtimeSession.STREAM_SERVICE_OBS:
            session.mark_stream_stopped()
            rotation_result = _rotate_obs_stream_key_if_enabled(session=session)
            if rotation_result["error"]:
                session.livekit_egress_error = str(rotation_result["error"])[:1000]
                session.save(update_fields=["livekit_egress_error", "updated_at"])
                data = RealtimeSessionListSerializer(session, context={"request": request}).data
                return api_response(
                    success=True,
                    message="Live stream stopped, but OBS key rotation failed. Check stream error details.",
                    data=data,
                )

            data = RealtimeSessionListSerializer(session, context={"request": request}).data
            return api_response(success=True, message="Live stream stopped.", data=data)

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


class RealtimeSessionStreamRotateKeyView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        session = get_object_or_404(RealtimeSession, pk=pk)
        if not _can_manage_session(request.user, session):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only host, assigned instructor, or admin can rotate OBS stream key."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if session.stream_service != RealtimeSession.STREAM_SERVICE_OBS:
            return api_response(
                success=False,
                message="Key rotation unavailable.",
                errors={"detail": "OBS key rotation is available only for OBS stream mode sessions."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        rotation_result = _rotate_obs_stream_key_if_enabled(session=session, force=True)
        if rotation_result["error"]:
            session.livekit_egress_error = str(rotation_result["error"])[:1000]
            session.save(update_fields=["livekit_egress_error", "updated_at"])
            return api_response(
                success=False,
                message="Unable to rotate OBS stream key.",
                errors={"detail": rotation_result["error"]},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        session.livekit_egress_error = ""
        session.save(update_fields=["livekit_egress_error", "updated_at"])
        data = RealtimeSessionListSerializer(session, context={"request": request}).data
        return api_response(success=True, message="OBS stream key synced (fixed key mode).", data=data)


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
