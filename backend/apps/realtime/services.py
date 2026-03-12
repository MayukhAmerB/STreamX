import json
import hashlib
import logging
import re
import time
import base64
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import jwt
from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import DisallowedHost
from django.utils import timezone

from config.url_utils import get_media_public_url


logger = logging.getLogger(__name__)
LOCALHOST_HOSTNAMES = {"localhost", "127.0.0.1", "0.0.0.0", "testserver"}
INTERNAL_DOCKER_HOSTNAMES = {"livekit", "livekit-server", "backend", "redis", "postgres", "owncast", "media"}
NON_PUBLIC_HOSTNAMES = LOCALHOST_HOSTNAMES | INTERNAL_DOCKER_HOSTNAMES


class LiveKitConfigError(Exception):
    """Raised when LiveKit is requested without required credentials."""


class LiveKitEgressError(Exception):
    """Raised when starting/stopping egress fails."""


class LiveKitRoomServiceError(Exception):
    """Raised when LiveKit room service actions fail."""


class OwncastConfigError(Exception):
    """Raised when Owncast admin integration is requested without required settings."""


class OwncastAdminError(Exception):
    """Raised when Owncast admin API calls fail."""


class ParticipantCountSnapshot:
    def __init__(self, count=None, source="fallback"):
        self.count = count
        self.source = source


def is_livekit_configured():
    return bool(settings.LIVEKIT_URL and settings.LIVEKIT_API_KEY and settings.LIVEKIT_API_SECRET)


def _normalize_livekit_http_base_url(raw_url):
    parsed = urlparse(str(raw_url or "").strip())
    scheme = parsed.scheme.lower()
    if scheme == "wss":
        scheme = "https"
    elif scheme == "ws":
        scheme = "http"
    elif scheme not in {"http", "https"}:
        scheme = "https"

    netloc = parsed.netloc or parsed.path
    return f"{scheme}://{netloc}".rstrip("/")


def _get_livekit_server_base_urls():
    raw_server_url = (getattr(settings, "LIVEKIT_SERVER_URL", "") or "").strip()
    raw_client_url = (getattr(settings, "LIVEKIT_URL", "") or "").strip()

    raw_candidates = [raw_server_url, raw_client_url]
    normalized_candidates = []
    for raw_url in raw_candidates:
        if not raw_url:
            continue
        normalized_url = _normalize_livekit_http_base_url(raw_url)
        if normalized_url and normalized_url not in normalized_candidates:
            normalized_candidates.append(normalized_url)

        host, port = _parse_url_host_and_port(raw_url)
        if host in NON_PUBLIC_HOSTNAMES:
            fallback_port = port.strip() if port else "7880"
            docker_internal_url = f"http://livekit:{fallback_port}"
            if docker_internal_url not in normalized_candidates:
                normalized_candidates.append(docker_internal_url)

    return normalized_candidates


def _resolve_request_host(request):
    if not request:
        return ""

    candidate_hosts = []
    forwarded_host = (request.META.get("HTTP_X_FORWARDED_HOST") or "").strip()
    if forwarded_host:
        candidate_hosts.append(forwarded_host.split(",")[0].strip())

    origin = (request.META.get("HTTP_ORIGIN") or "").strip()
    if origin:
        candidate_hosts.append(urlparse(origin).hostname or "")

    referer = (request.META.get("HTTP_REFERER") or "").strip()
    if referer:
        candidate_hosts.append(urlparse(referer).hostname or "")

    host_header = ""
    try:
        host_header = (request.get_host() or "").strip()
    except DisallowedHost:
        host_header = (request.META.get("HTTP_HOST") or "").strip()
    except Exception:
        host_header = ""
    if host_header:
        candidate_hosts.append(host_header)

    cleaned_hosts = [item.split(":", 1)[0].strip() for item in candidate_hosts if item]
    non_local_hosts = [item for item in cleaned_hosts if item not in LOCALHOST_HOSTNAMES]
    return non_local_hosts[0] if non_local_hosts else (cleaned_hosts[0] if cleaned_hosts else "")


def _parse_url_host_and_port(raw_url):
    raw_value = str(raw_url or "").strip()
    if not raw_value:
        return "", ""
    parsed = urlparse(raw_value)
    netloc = parsed.netloc or parsed.path
    if not netloc:
        return "", ""
    cleaned = netloc.rsplit("@", 1)[-1].strip()
    if cleaned.startswith("["):
        # IPv6 host format [::1]:7880
        if "]:" in cleaned:
            host, port = cleaned.split("]:", 1)
            return f"{host}]", port.strip()
        return cleaned, ""
    if ":" in cleaned:
        host, port = cleaned.split(":", 1)
        return host.strip(), port.strip()
    return cleaned, ""


def resolve_livekit_client_url(request=None):
    configured_public_url = (getattr(settings, "LIVEKIT_PUBLIC_URL", "") or "").strip()
    if configured_public_url:
        return configured_public_url

    configured_url = (settings.LIVEKIT_URL or "").strip()
    if not configured_url:
        return configured_url

    parsed = urlparse(configured_url)
    scheme = parsed.scheme.lower()
    if scheme in {"ws", "wss"}:
        ws_scheme = scheme
    elif scheme == "https":
        ws_scheme = "wss"
    else:
        ws_scheme = "ws"

    request_host = _resolve_request_host(request)

    netloc = parsed.netloc or parsed.path
    configured_host = netloc.split(":", 1)[0] if netloc else ""
    configured_port = netloc.split(":", 1)[1] if ":" in netloc else ""

    # If configured URL points to localhost, replace host with current request host.
    if request_host and configured_host in NON_PUBLIC_HOSTNAMES:
        host = request_host
    else:
        host = configured_host or request_host

    port = configured_port or "7880"
    if not host:
        return configured_url
    return f"{ws_scheme}://{host}:{port}"


def resolve_frontend_public_origin(request=None):
    configured_frontend_public_origin = (getattr(settings, "FRONTEND_PUBLIC_ORIGIN", "") or "").strip()
    if configured_frontend_public_origin:
        return configured_frontend_public_origin.rstrip("/")

    configured_frontend_url = (getattr(settings, "FRONTEND_URL", "") or "").strip()
    request_host = _resolve_request_host(request)

    parsed = urlparse(configured_frontend_url)
    scheme = parsed.scheme or ("https" if request and request.is_secure() else "http")
    netloc = parsed.netloc or parsed.path
    configured_host = netloc.split(":", 1)[0] if netloc else ""
    configured_port = netloc.split(":", 1)[1] if ":" in netloc else ""

    if request_host and configured_host in LOCALHOST_HOSTNAMES:
        host = request_host
    else:
        host = configured_host or request_host

    if host in LOCALHOST_HOSTNAMES:
        livekit_public_host, _ = _parse_url_host_and_port(getattr(settings, "LIVEKIT_PUBLIC_URL", ""))
        if livekit_public_host and livekit_public_host not in LOCALHOST_HOSTNAMES:
            host = livekit_public_host

    port = configured_port or ("5173" if settings.DEBUG else "")
    if not host:
        return configured_frontend_url
    if port:
        return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


def _resolve_public_service_base_url(configured_base_url, request=None, default_port=""):
    configured_value = str(configured_base_url or "").strip().rstrip("/")
    if not configured_value:
        return ""

    parsed = urlparse(configured_value)
    scheme = parsed.scheme or ("https" if request and request.is_secure() else "http")
    netloc = parsed.netloc or parsed.path
    configured_host = netloc.split(":", 1)[0] if netloc else ""
    configured_port = netloc.split(":", 1)[1] if ":" in netloc else ""

    request_host = _resolve_request_host(request)
    if request_host and configured_host in LOCALHOST_HOSTNAMES:
        host = request_host
    else:
        host = configured_host or request_host

    port = configured_port or default_port
    if not host:
        return configured_value
    if port:
        return f"{scheme}://{host}:{port}"
    return f"{scheme}://{host}"


def _extract_stream_key_from_rtmp_target(raw_target):
    value = str(raw_target or "").strip()
    if not value:
        return ""
    parsed = urlparse(value)
    path_rows = [row for row in str(parsed.path or "").split("/") if row]
    return path_rows[-1] if path_rows else ""


def _extract_server_url_from_rtmp_target(raw_target):
    value = str(raw_target or "").strip()
    if not value:
        return ""
    parsed = urlparse(value)
    if not parsed.scheme or not parsed.netloc:
        return ""
    path_rows = [row for row in str(parsed.path or "").split("/") if row]
    base_path = ""
    if len(path_rows) > 1:
        base_path = "/" + "/".join(path_rows[:-1])
    elif len(path_rows) == 1:
        base_path = f"/{path_rows[0]}"
    return f"{parsed.scheme}://{parsed.netloc}{base_path}".rstrip("/")


def resolve_obs_stream_server_url(*, request=None, session=None):
    configured_obs_server_url = str(getattr(settings, "OWNCAST_OBS_STREAM_SERVER_URL", "") or "").strip()
    if configured_obs_server_url:
        return configured_obs_server_url.rstrip("/")

    derived_server_url = _extract_server_url_from_rtmp_target(getattr(settings, "OWNCAST_RTMP_TARGET", ""))
    if not derived_server_url and session is not None:
        derived_server_url = _extract_server_url_from_rtmp_target(getattr(session, "rtmp_target_url", ""))

    if derived_server_url:
        parsed = urlparse(derived_server_url)
        host = str(parsed.hostname or "").strip()
        scheme = str(parsed.scheme or "rtmp").strip().lower() or "rtmp"
        path = str(parsed.path or "/live").strip() or "/live"
        if not path.startswith("/"):
            path = f"/{path}"
        if host in NON_PUBLIC_HOSTNAMES:
            request_host = _resolve_request_host(request)
            if request_host and request_host not in NON_PUBLIC_HOSTNAMES:
                host = request_host
        if host:
            port = parsed.port or 1935
            return f"{scheme}://{host}:{port}{path}".rstrip("/")

    public_stream_base = _resolve_public_service_base_url(
        getattr(settings, "OWNCAST_STREAM_PUBLIC_BASE_URL", "") or getattr(settings, "OWNCAST_BASE_URL", ""),
        request=request,
        default_port="8080",
    )
    if public_stream_base:
        parsed = urlparse(public_stream_base)
        host = str(parsed.hostname or "").strip()
        if host:
            return f"rtmp://{host}:1935/live"
    return "rtmp://owncast:1935/live"


def build_obs_rtmp_target_url(*, stream_server_url, stream_key):
    server = str(stream_server_url or "").strip().rstrip("/")
    key = str(stream_key or "").strip()
    if not server or not key:
        return ""
    return f"{server}/{key}".rstrip("/")


def sync_owncast_stream_key(stream_key):
    admin_password = str(getattr(settings, "OWNCAST_ADMIN_PASSWORD", "") or "").strip()
    admin_username = str(getattr(settings, "OWNCAST_ADMIN_USERNAME", "admin") or "admin").strip() or "admin"
    if not admin_password:
        raise OwncastConfigError("OWNCAST_ADMIN_PASSWORD is required to rotate Owncast stream key.")

    base_url = str(
        getattr(settings, "OWNCAST_ADMIN_API_BASE_URL", "") or getattr(settings, "OWNCAST_BASE_URL", "")
    ).strip().rstrip("/")
    if not base_url:
        raise OwncastConfigError("OWNCAST_ADMIN_API_BASE_URL or OWNCAST_BASE_URL is required.")

    target_key = str(stream_key or "").strip()
    if not target_key:
        raise OwncastAdminError("Stream key cannot be empty.")

    auth_token = base64.b64encode(f"{admin_username}:{admin_password}".encode("utf-8")).decode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Basic {auth_token}",
    }
    # Newer Owncast releases (including v0.2.x) use /admin/config/streamkeys.
    # Keep legacy fallback for older nodes still exposing /admin/changekey.
    endpoint_candidates = (
        (
            f"{base_url}/api/admin/config/streamkeys",
            {"value": [{"key": target_key, "comment": "StreamX OBS session key"}]},
        ),
        (
            f"{base_url}/api/admin/changekey",
            {"key": target_key},
        ),
    )

    last_error = ""
    for endpoint, payload in endpoint_candidates:
        request = Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        try:
            with urlopen(request, timeout=10) as response:
                raw_payload = response.read().decode("utf-8") or "{}"
            parsed_payload = json.loads(raw_payload)
            if not bool(parsed_payload.get("success", True)):
                raise OwncastAdminError(
                    str(parsed_payload.get("errorMessage") or parsed_payload.get("message") or "Owncast key update failed.")
                )
            return parsed_payload
        except HTTPError as exc:
            response_body = ""
            try:
                response_body = exc.read().decode("utf-8")
            except Exception:
                response_body = str(exc)
            # Try next endpoint on not found to support mixed Owncast versions.
            if exc.code == 404:
                last_error = f"{endpoint} -> HTTP 404: {response_body}"
                continue
            raise OwncastAdminError(f"Owncast admin API HTTP {exc.code}: {response_body}") from exc
        except URLError as exc:
            raise OwncastAdminError(f"Owncast admin API network error: {exc}") from exc
        except Exception as exc:
            raise OwncastAdminError(f"Owncast admin API unknown error: {exc}") from exc

    raise OwncastAdminError(
        f"Owncast admin API returned 404 for all known stream-key endpoints. Last error: {last_error}"
    )


def build_session_join_url(session_id, request=None):
    if not session_id:
        return ""
    try:
        origin = resolve_frontend_public_origin(request=request).rstrip("/")
        if origin:
            return f"{origin}/join-live?session={session_id}"
    except Exception:
        # Never break session APIs due to public-origin resolution issues.
        pass
    return f"/join-live?session={session_id}"


def _build_server_token(*, identity, grants, ttl_seconds=3600, participant_name="", participant_metadata=None):
    if not is_livekit_configured():
        raise LiveKitConfigError("LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.")

    now = int(time.time())
    payload = {
        "iss": settings.LIVEKIT_API_KEY,
        "sub": identity,
        "nbf": now - 5,
        "exp": now + max(60, int(ttl_seconds)),
        "video": grants,
    }
    if participant_name:
        payload["name"] = participant_name
    if participant_metadata:
        payload["metadata"] = json.dumps(participant_metadata)
    token = jwt.encode(payload, settings.LIVEKIT_API_SECRET, algorithm="HS256")
    if isinstance(token, bytes):
        return token.decode("utf-8")
    return token


def _build_room_admin_token(room_name):
    if not is_livekit_configured():
        raise LiveKitConfigError("LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.")
    return _build_server_token(
        identity="server-room-admin",
        grants={"roomAdmin": True, "room": room_name},
        ttl_seconds=120,
    )


def _twirp_room_service_post(*, room_name, method_name, payload, timeout=4):
    base_urls = _get_livekit_server_base_urls()
    if not base_urls:
        raise LiveKitRoomServiceError(
            "LiveKit server URL is not configured. Set LIVEKIT_SERVER_URL or LIVEKIT_URL."
        )

    auth_header = f"Bearer {_build_room_admin_token(room_name)}"
    request_body = json.dumps(payload).encode("utf-8")
    last_error_message = ""

    for base_url in base_urls:
        endpoint = f"{base_url}/twirp/livekit.RoomService/{method_name}"
        request = Request(
            endpoint,
            data=request_body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": auth_header,
            },
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8")
            except Exception:
                body = str(exc)
            last_error_message = f"RoomService {method_name} HTTP {exc.code}: {body}"
            if exc.code in {404, 405, 502, 503, 504}:
                continue
            raise LiveKitRoomServiceError(last_error_message) from exc
        except URLError as exc:
            last_error_message = f"RoomService {method_name} network error: {exc}"
            continue
        except Exception as exc:
            last_error_message = f"RoomService {method_name} unknown error: {exc}"
            continue

    raise LiveKitRoomServiceError(last_error_message or f"RoomService {method_name} request failed.")


_LIVEKIT_USER_IDENTITY_RE = re.compile(r"^user-(\d+)-")


def _parse_user_id_from_participant_identity(identity):
    identity_str = str(identity or "").strip()
    match = _LIVEKIT_USER_IDENTITY_RE.match(identity_str)
    if not match:
        return None
    try:
        user_id = int(match.group(1))
    except (TypeError, ValueError):
        return None
    return user_id if user_id > 0 else None


def _list_room_participants(room_name):
    payload = {"room": room_name}
    response = _twirp_room_service_post(
        room_name=room_name,
        method_name="ListParticipants",
        payload=payload,
        timeout=4,
    )
    participants = response.get("participants") or []
    return participants if isinstance(participants, list) else []


def _build_livekit_publish_sources(*, allow_presenter, allow_microphone):
    publish_sources = []
    if allow_presenter:
        publish_sources.extend(["CAMERA", "SCREEN_SHARE", "SCREEN_SHARE_AUDIO"])
    if allow_microphone:
        publish_sources.append("MICROPHONE")
    return publish_sources


def _track_source_needs_mute(*, source, allow_presenter, allow_microphone):
    normalized_source = str(source or "").strip().lower()
    if normalized_source in {"microphone", "mic"}:
        return not allow_microphone
    if normalized_source in {"camera", "screen_share", "screen_share_audio", "screen", "screenshare"}:
        return not allow_presenter
    return False


def _apply_live_publish_permission_update(*, session, target_user_id, allow_presenter, allow_microphone):
    """
    Apply presenter/speaker permission changes for already-connected participants without forcing rejoin.

    Returns a diagnostics payload used by API responses and telemetry.
    """
    room_name = str(getattr(session, "livekit_room_name", "") or getattr(session, "room_name", "") or "").strip()
    result = {
        "applied": False,
        "room_name": room_name,
        "target_user_id": int(target_user_id),
        "allow_presenter": bool(allow_presenter),
        "allow_microphone": bool(allow_microphone),
        "connected_matches": 0,
        "updated_identities": [],
        "muted_track_count": 0,
        "errors": [],
    }

    if not room_name or not is_livekit_configured():
        return result

    try:
        participants = _list_room_participants(room_name)
    except Exception as exc:
        result["errors"].append(str(exc))
        return result

    matched_rows = []
    for participant in participants:
        identity = str(participant.get("identity") or "").strip()
        if not identity:
            continue
        if _parse_user_id_from_participant_identity(identity) != int(target_user_id):
            continue
        matched_rows.append((identity, participant))

    result["connected_matches"] = len(matched_rows)
    if not matched_rows:
        # No active participant session to update right now.
        result["applied"] = True
        return result

    publish_sources = _build_livekit_publish_sources(
        allow_presenter=bool(allow_presenter),
        allow_microphone=bool(allow_microphone),
    )
    can_publish_any = bool(publish_sources)
    for identity, participant in matched_rows:
        try:
            _twirp_room_service_post(
                room_name=room_name,
                method_name="UpdateParticipant",
                payload={
                    "room": room_name,
                    "identity": identity,
                    "permission": {
                        "canPublish": can_publish_any,
                        "canSubscribe": True,
                        "canPublishData": True,
                        "canPublishSources": publish_sources,
                    },
                },
                timeout=4,
            )
            result["updated_identities"].append(identity)
        except Exception as exc:
            result["errors"].append(f"{identity}: {exc}")
            continue

        if allow_presenter and allow_microphone:
            continue

        # Revoke should take effect immediately; mute any now-disallowed published tracks.
        for track in participant.get("tracks") or []:
            source = str(track.get("source") or "").strip().lower()
            track_sid = str(track.get("sid") or track.get("trackSid") or "").strip()
            if not track_sid:
                continue
            if not _track_source_needs_mute(
                source=source,
                allow_presenter=bool(allow_presenter),
                allow_microphone=bool(allow_microphone),
            ):
                continue
            try:
                _twirp_room_service_post(
                    room_name=room_name,
                    method_name="MutePublishedTrack",
                    payload={
                        "room": room_name,
                        "identity": identity,
                        "trackSid": track_sid,
                        "muted": True,
                    },
                    timeout=4,
                )
                result["muted_track_count"] += 1
            except Exception as exc:
                result["errors"].append(f"{identity}:{track_sid}:{exc}")

    result["applied"] = len(result["updated_identities"]) == result["connected_matches"] and not result["errors"]
    return result


def apply_live_speaker_permission_update(*, session, target_user_id, allow_microphone, allow_presenter=False):
    return _apply_live_publish_permission_update(
        session=session,
        target_user_id=target_user_id,
        allow_presenter=bool(allow_presenter),
        allow_microphone=allow_microphone,
    )


def apply_live_presenter_permission_update(*, session, target_user_id, allow_presenter, allow_microphone):
    return _apply_live_publish_permission_update(
        session=session,
        target_user_id=target_user_id,
        allow_presenter=allow_presenter,
        allow_microphone=allow_microphone,
    )


def build_participant_token(
    *,
    identity,
    room_name,
    participant_name,
    can_publish,
    can_subscribe,
    room_admin,
    ttl_seconds,
    can_publish_sources=None,
    participant_metadata=None,
):
    grants = {
        "roomJoin": True,
        "room": room_name,
        "canPublish": can_publish,
        "canSubscribe": can_subscribe,
        "canPublishData": True,
        "roomAdmin": room_admin,
    }
    if can_publish_sources:
        grants["canPublishSources"] = list(can_publish_sources)
    return _build_server_token(
        identity=identity,
        grants=grants,
        ttl_seconds=ttl_seconds,
        participant_name=participant_name,
        participant_metadata=participant_metadata,
    )


def build_participant_metadata(*, user, request=None):
    if not user:
        return {}
    profile_image_url = ""
    if getattr(user, "profile_image", None):
        try:
            profile_image_url = get_media_public_url(user.profile_image.url, request=request)
        except Exception:
            profile_image_url = ""
    return {
        "user_id": getattr(user, "id", None),
        "full_name": getattr(user, "full_name", "") or getattr(user, "email", "") or "",
        "role": getattr(user, "role", ""),
        "is_admin": bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False)),
        "profile_image_url": profile_image_url,
    }


def _room_participant_count_cache_key(room_name):
    return f"realtime-room-participants:{str(room_name or '').strip().lower()}"


def cache_room_participant_count(room_name, count):
    cache_ttl = max(0, int(getattr(settings, "REALTIME_PARTICIPANT_COUNT_CACHE_TTL_SECONDS", 5)))
    if cache_ttl <= 0 or not room_name or count is None:
        return
    cache.set(_room_participant_count_cache_key(room_name), max(0, int(count)), timeout=cache_ttl)


def get_room_participant_count(room_name, *, refresh=False):
    if not is_livekit_configured():
        return ParticipantCountSnapshot(count=None, source="fallback")

    cache_ttl = max(0, int(getattr(settings, "REALTIME_PARTICIPANT_COUNT_CACHE_TTL_SECONDS", 5)))
    cache_key = _room_participant_count_cache_key(room_name)
    if not refresh and cache_ttl > 0:
        cached_count = cache.get(cache_key)
        if cached_count is not None:
            return ParticipantCountSnapshot(count=max(0, int(cached_count)), source="cache")

    admin_token = _build_server_token(
        identity="server-room-admin",
        grants={"roomAdmin": True, "room": room_name},
        ttl_seconds=90,
    )
    payload = json.dumps({"room": room_name}).encode("utf-8")
    base_urls = _get_livekit_server_base_urls()
    if not base_urls:
        logger.warning("LiveKit participant count unavailable: no LiveKit server URL configured.")
        return ParticipantCountSnapshot(count=None, source="fallback")

    last_error = ""
    for base_url in base_urls:
        endpoint = f"{base_url}/twirp/livekit.RoomService/ListParticipants"
        request = Request(
            endpoint,
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {admin_token}",
            },
        )
        try:
            with urlopen(request, timeout=4) as response:
                body = json.loads(response.read().decode("utf-8") or "{}")
                participants = body.get("participants") or []
                count = len(participants)
                cache_room_participant_count(room_name, count)
                return ParticipantCountSnapshot(count=count, source="livekit")
        except HTTPError as exc:
            if exc.code in {400, 404}:
                cache_room_participant_count(room_name, 0)
                return ParticipantCountSnapshot(count=0, source="livekit")
            last_error = f"HTTP {exc.code}"
            try:
                body = exc.read().decode("utf-8")
            except Exception:
                body = str(exc)
            logger.warning(
                "LiveKit participant count HTTP error on %s: %s",
                endpoint,
                body or exc,
            )
        except URLError as exc:
            last_error = f"network error: {exc}"
            logger.warning("LiveKit participant count network error on %s: %s", endpoint, exc)
        except Exception as exc:  # defensive fallback
            last_error = f"unknown error: {exc}"
            logger.warning("LiveKit participant count unknown error on %s: %s", endpoint, exc)

    if last_error:
        logger.warning("LiveKit participant count fallback after retries: %s", last_error)
    return ParticipantCountSnapshot(count=None, source="fallback")


def build_meet_embed_url(token, livekit_url=None):
    meet_base_url = settings.LIVEKIT_MEET_URL
    parsed = urlparse(meet_base_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update(
        {
            "token": token,
            "liveKitUrl": livekit_url or settings.LIVEKIT_URL,
            "prejoin": "true",
        }
    )
    encoded_query = urlencode(query)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, encoded_query, parsed.fragment))


def resolve_broadcast_urls(session, request=None):
    cache_ttl = max(0, int(getattr(settings, "REALTIME_BROADCAST_URL_CACHE_TTL_SECONDS", 15) or 0))

    request_host = _resolve_request_host(request)
    cache_key = ""
    if cache_ttl > 0:
        cache_fingerprint = "|".join(
            [
                str(getattr(session, "id", "")),
                str(getattr(session, "stream_embed_url", "") or "").strip(),
                str(getattr(session, "chat_embed_url", "") or "").strip(),
                str(getattr(settings, "OWNCAST_STREAM_PUBLIC_BASE_URL", "") or "").strip(),
                str(getattr(settings, "OWNCAST_CHAT_PUBLIC_BASE_URL", "") or "").strip(),
                str(getattr(settings, "OWNCAST_BASE_URL", "") or "").strip(),
                str(getattr(settings, "OWNCAST_DEFAULT_STREAM_PATH", "/embed/video") or "").strip(),
                str(getattr(settings, "OWNCAST_DEFAULT_CHAT_PATH", "/embed/chat/readwrite") or "").strip(),
                request_host,
            ]
        )
        fingerprint_digest = hashlib.sha256(cache_fingerprint.encode("utf-8")).hexdigest()[:20]
        cache_key = f"realtime:broadcast-urls:{fingerprint_digest}"
        cached_payload = cache.get(cache_key)
        if isinstance(cached_payload, dict):
            cached_stream = str(cached_payload.get("stream_embed_url", "")).strip()
            cached_chat = str(cached_payload.get("chat_embed_url", "")).strip()
            if cached_stream or cached_chat:
                return {
                    "stream_embed_url": cached_stream,
                    "chat_embed_url": cached_chat,
                }

    def _normalized_embed_path(raw_path, fallback):
        path = str(raw_path or "").strip()
        if not path:
            path = fallback
        if not path.startswith("/"):
            path = f"/{path}"
        return path

    def _derive_embed_url(base_embed_url, target_path):
        parsed = urlparse(str(base_embed_url or "").strip())
        if not parsed.scheme or not parsed.netloc:
            return ""
        return urlunparse((parsed.scheme, parsed.netloc, target_path, "", "", ""))

    stream_embed_url = (session.stream_embed_url or "").strip()
    chat_embed_url = (session.chat_embed_url or "").strip()
    configured_stream_base_url = (
        getattr(settings, "OWNCAST_STREAM_PUBLIC_BASE_URL", "") or settings.OWNCAST_BASE_URL
    )
    configured_chat_base_url = (
        getattr(settings, "OWNCAST_CHAT_PUBLIC_BASE_URL", "") or settings.OWNCAST_BASE_URL
    )
    stream_base_url = _resolve_public_service_base_url(
        configured_stream_base_url,
        request=request,
        default_port="8080",
    )
    chat_base_url = _resolve_public_service_base_url(
        configured_chat_base_url,
        request=request,
        default_port="8080",
    )

    if stream_base_url and not stream_embed_url:
        stream_embed_url = f"{stream_base_url}{_normalized_embed_path(settings.OWNCAST_DEFAULT_STREAM_PATH, '/embed/video')}"
    if chat_base_url and not chat_embed_url:
        chat_embed_url = f"{chat_base_url}{_normalized_embed_path(settings.OWNCAST_DEFAULT_CHAT_PATH, '/embed/chat/readwrite')}"

    # Fallback derivation: if one embed URL is set and the other is missing, build
    # the missing counterpart from the same host so stream/chat iframes stay usable.
    if stream_embed_url and not chat_embed_url:
        chat_embed_url = _derive_embed_url(
            stream_embed_url,
            _normalized_embed_path(settings.OWNCAST_DEFAULT_CHAT_PATH, "/embed/chat/readwrite"),
        )
    if chat_embed_url and not stream_embed_url:
        stream_embed_url = _derive_embed_url(
            chat_embed_url,
            _normalized_embed_path(settings.OWNCAST_DEFAULT_STREAM_PATH, "/embed/video"),
        )

    payload = {
        "stream_embed_url": stream_embed_url,
        "chat_embed_url": chat_embed_url,
    }
    if cache_ttl > 0 and cache_key:
        cache.set(cache_key, payload, timeout=cache_ttl)
    return payload


def build_host_publisher_identity(user_id, session_id):
    return f"host-{user_id}-session-{session_id}"


def build_host_publisher_token(*, session, user):
    identity = build_host_publisher_identity(user.id, session.id)
    token = build_participant_token(
        identity=identity,
        room_name=session.livekit_room_name or session.room_name,
        participant_name=user.full_name or user.email,
        can_publish=True,
        can_subscribe=True,
        room_admin=True,
        ttl_seconds=settings.REALTIME_JOIN_TOKEN_TTL_SECONDS,
        participant_metadata=build_participant_metadata(user=user),
    )
    return {
        "identity": identity,
        "token": token,
    }


def _build_egress_admin_token():
    if not is_livekit_configured():
        raise LiveKitConfigError("LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.")
    return _build_server_token(
        identity="server-egress-admin",
        grants={"roomRecord": True},
        ttl_seconds=120,
    )


def _twirp_post(path, payload):
    base_urls = _get_livekit_server_base_urls()
    if not base_urls:
        raise LiveKitEgressError(
            "LiveKit server URL is not configured. Set LIVEKIT_SERVER_URL or LIVEKIT_URL."
        )

    auth_header = f"Bearer {_build_egress_admin_token()}"
    request_body = json.dumps(payload).encode("utf-8")
    last_error_message = ""

    for base_url in base_urls:
        endpoint = f"{base_url}/twirp/{path}"
        request = Request(
            endpoint,
            data=request_body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": auth_header,
            },
        )
        try:
            with urlopen(request, timeout=settings.LIVEKIT_EGRESS_TWIRP_TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8")
            except Exception:
                body = str(exc)
            last_error_message = f"Egress HTTP {exc.code}: {body}"
            # Retry across configured base URLs on connectivity/proxy style failures.
            if exc.code in {404, 405, 502, 503, 504}:
                continue
            raise LiveKitEgressError(last_error_message) from exc
        except URLError as exc:
            last_error_message = f"Egress network error: {exc}"
            continue
        except Exception as exc:
            last_error_message = f"Egress unknown error: {exc}"
            continue

    raise LiveKitEgressError(last_error_message or "Egress request failed.")


def start_room_broadcast_egress(*, room_name, rtmp_target_url, participant_identity=""):
    # Prefer participant egress for browser-published host media because it avoids
    # the headless-browser ICE path used by room-composite egress.
    if participant_identity:
        payload = {
            "room_name": room_name,
            "identity": participant_identity,
            "stream_outputs": [{"urls": [rtmp_target_url]}],
        }
        data = _twirp_post("livekit.Egress/StartParticipantEgress", payload)
    else:
        payload = {
            "room_name": room_name,
            "layout": settings.LIVEKIT_EGRESS_LAYOUT,
            "stream_outputs": [{"urls": [rtmp_target_url]}],
        }
        data = _twirp_post("livekit.Egress/StartRoomCompositeEgress", payload)
    egress_id = data.get("egress_id") or data.get("egressId") or ""
    if not egress_id:
        raise LiveKitEgressError("Egress started but no egress_id was returned by LiveKit.")
    return egress_id


def stop_room_broadcast_egress(*, egress_id):
    if not egress_id:
        return
    _twirp_post("livekit.Egress/StopEgress", {"egress_id": egress_id})


def build_recording_filepath(*, room_name, session_type):
    prefix = str(getattr(settings, "LIVEKIT_RECORDING_FILEPATH_PREFIX", "/recordings") or "").strip()
    if not prefix:
        prefix = "/recordings"
    if prefix != "/":
        prefix = prefix.rstrip("/")
    normalized_room = "".join(
        char if (char.isalnum() or char in {"-", "_"}) else "-"
        for char in str(room_name or "").strip().lower()
    ).strip("-")
    if not normalized_room:
        normalized_room = "room"
    normalized_type = "meeting" if str(session_type or "").strip() == "meeting" else "broadcasting"
    timestamp = timezone.now().strftime("%Y%m%d-%H%M%S")
    file_name = f"{normalized_room}-{timestamp}.mp4"
    return f"{prefix}/{normalized_type}/{file_name}"


def resolve_recording_local_path(output_file_path):
    raw_path = str(output_file_path or "").strip()
    if not raw_path:
        return None

    root = Path(
        str(getattr(settings, "LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT", "/recordings") or "/recordings")
    ).expanduser()
    if not root.is_absolute():
        root = (Path.cwd() / root).resolve()
    else:
        root = root.resolve()

    normalized = raw_path.replace("\\", "/")
    prefix = str(getattr(settings, "LIVEKIT_RECORDING_FILEPATH_PREFIX", "/recordings") or "/recordings").strip()
    if not prefix:
        prefix = "/recordings"
    prefix = prefix.replace("\\", "/")
    if not prefix.startswith("/"):
        prefix = f"/{prefix}"
    if prefix != "/":
        prefix = prefix.rstrip("/")

    candidate_values = []

    def add_candidate(value):
        normalized_value = str(value or "").strip()
        if normalized_value and normalized_value not in candidate_values:
            candidate_values.append(normalized_value)

    if prefix == normalized:
        add_candidate("")
    elif prefix != "/" and normalized.startswith(f"{prefix}/"):
        add_candidate(normalized[len(prefix) + 1 :])

    if prefix != "/" and f"{prefix}/" in normalized:
        add_candidate(normalized.split(f"{prefix}/", 1)[1])

    add_candidate(normalized)
    add_candidate(normalized.lstrip("./"))
    if normalized.startswith("recordings/"):
        add_candidate(normalized[len("recordings/") :])

    file_name = Path(normalized).name.strip()

    for candidate_value in candidate_values:
        candidate_path = Path(candidate_value)
        if candidate_path.is_absolute():
            candidate = candidate_path.resolve()
        else:
            relative = str(candidate_value).replace("\\", "/").lstrip("/")
            candidate = (root / relative).resolve()

        if candidate.exists() and candidate.is_file():
            try:
                candidate.relative_to(root)
            except ValueError:
                continue
            return candidate

    if file_name:
        for matched_file in root.rglob(file_name):
            resolved_match = matched_file.resolve()
            try:
                resolved_match.relative_to(root)
            except ValueError:
                continue
            if resolved_match.is_file():
                return resolved_match

    return None


def delete_recording_assets(recording):
    """Best-effort deletion for storage assets linked to a recording row."""
    if not recording:
        return {"video_file_deleted": False, "local_file_deleted": False}

    result = {"video_file_deleted": False, "local_file_deleted": False}

    video_field = getattr(recording, "video_file", None)
    video_name = str(getattr(video_field, "name", "") or "").strip()
    if video_name:
        try:
            video_field.delete(save=False)
            result["video_file_deleted"] = True
        except Exception as exc:
            logger.warning(
                "Realtime recording video_file cleanup failed. recording_id=%s file=%s error=%s",
                getattr(recording, "id", None),
                video_name,
                str(exc),
            )

    output_file_path = str(getattr(recording, "output_file_path", "") or "").strip()
    if output_file_path:
        local_file = resolve_recording_local_path(output_file_path)
        if local_file and local_file.exists() and local_file.is_file():
            try:
                local_file.unlink()
                result["local_file_deleted"] = True
            except Exception as exc:
                logger.warning(
                    "Realtime recording local file cleanup failed. recording_id=%s path=%s error=%s",
                    getattr(recording, "id", None),
                    str(local_file),
                    str(exc),
                )

    return result


def start_room_recording_egress(*, room_name, output_file_path, layout=""):
    payload = {
        "room_name": room_name,
        "layout": (layout or settings.LIVEKIT_EGRESS_LAYOUT or "speaker-dark"),
        "file_outputs": [{"filepath": output_file_path}],
    }
    data = _twirp_post("livekit.Egress/StartRoomCompositeEgress", payload)
    egress_id = data.get("egress_id") or data.get("egressId") or ""
    if not egress_id:
        raise LiveKitEgressError("Recording egress started but no egress_id was returned by LiveKit.")
    return {
        "egress_id": egress_id,
        "output_file_path": output_file_path,
        "response": data,
    }


def stop_room_recording_egress(*, egress_id):
    if not egress_id:
        raise LiveKitEgressError("Missing recording egress id.")
    return _twirp_post("livekit.Egress/StopEgress", {"egress_id": egress_id})


def extract_recording_output(*, stop_payload, fallback_file_path=""):
    file_path = str(fallback_file_path or "").strip()
    download_url = ""
    payload = stop_payload if isinstance(stop_payload, dict) else {}

    file_results = payload.get("file_results") or payload.get("fileResults") or []
    if isinstance(file_results, list) and file_results:
        first_result = file_results[0] if isinstance(file_results[0], dict) else {}
    else:
        first_result = {}

    if isinstance(first_result, dict):
        file_path = (
            str(
                first_result.get("filename")
                or first_result.get("filepath")
                or first_result.get("file_path")
                or file_path
            ).strip()
        )
        download_url = str(first_result.get("location") or first_result.get("url") or "").strip()

    if not download_url and file_path:
        base_public_url = str(getattr(settings, "LIVEKIT_RECORDING_OUTPUT_PUBLIC_BASE_URL", "") or "").strip().rstrip("/")
        if base_public_url:
            download_url = f"{base_public_url}/{file_path.lstrip('/')}"

    return {
        "file_path": file_path,
        "download_url": download_url,
    }
