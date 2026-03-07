import json
import logging
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import jwt
from django.conf import settings
from django.core.exceptions import DisallowedHost
from django.utils import timezone


logger = logging.getLogger(__name__)
LOCALHOST_HOSTNAMES = {"localhost", "127.0.0.1", "0.0.0.0", "testserver"}


class LiveKitConfigError(Exception):
    """Raised when LiveKit is requested without required credentials."""


class LiveKitEgressError(Exception):
    """Raised when starting/stopping egress fails."""


def is_livekit_configured():
    return bool(settings.LIVEKIT_URL and settings.LIVEKIT_API_KEY and settings.LIVEKIT_API_SECRET)


def _normalize_livekit_http_base_url():
    parsed = urlparse(settings.LIVEKIT_URL)
    scheme = parsed.scheme.lower()
    if scheme == "wss":
        scheme = "https"
    elif scheme == "ws":
        scheme = "http"
    elif scheme not in {"http", "https"}:
        scheme = "https"

    netloc = parsed.netloc or parsed.path
    return f"{scheme}://{netloc}".rstrip("/")


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
    if request_host and configured_host in LOCALHOST_HOSTNAMES:
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


def _build_server_token(*, identity, grants, ttl_seconds=3600, participant_name=""):
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
    token = jwt.encode(payload, settings.LIVEKIT_API_SECRET, algorithm="HS256")
    if isinstance(token, bytes):
        return token.decode("utf-8")
    return token


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
    )


def get_room_participant_count(room_name):
    if not is_livekit_configured():
        return None

    admin_token = _build_server_token(
        identity="server-room-admin",
        grants={"roomAdmin": True, "room": room_name},
        ttl_seconds=90,
    )
    endpoint = f"{_normalize_livekit_http_base_url()}/twirp/livekit.RoomService/ListParticipants"
    payload = json.dumps({"room": room_name}).encode("utf-8")
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
            return len(participants)
    except HTTPError as exc:
        if exc.code in {400, 404}:
            return 0
        logger.warning("LiveKit participant count HTTP error: %s", exc)
        return None
    except URLError as exc:
        logger.warning("LiveKit participant count network error: %s", exc)
        return None
    except Exception as exc:  # defensive fallback
        logger.warning("LiveKit participant count unknown error: %s", exc)
        return None


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

    return {
        "stream_embed_url": stream_embed_url,
        "chat_embed_url": chat_embed_url,
    }


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
    endpoint = f"{_normalize_livekit_http_base_url()}/twirp/{path}"
    request = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_build_egress_admin_token()}",
        },
    )
    try:
        with urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8")
        except Exception:
            body = str(exc)
        raise LiveKitEgressError(f"Egress HTTP {exc.code}: {body}") from exc
    except URLError as exc:
        raise LiveKitEgressError(f"Egress network error: {exc}") from exc
    except Exception as exc:
        raise LiveKitEgressError(f"Egress unknown error: {exc}") from exc


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

    relative = None
    if prefix == normalized:
        relative = ""
    elif prefix != "/" and normalized.startswith(f"{prefix}/"):
        relative = normalized[len(prefix) + 1 :]

    if relative is None:
        candidate_path = Path(normalized)
        if candidate_path.is_absolute():
            candidate = candidate_path.resolve()
        else:
            relative = normalized.lstrip("./")
            if relative.startswith("recordings/"):
                relative = relative[len("recordings/") :]
            candidate = (root / relative).resolve()
    else:
        candidate = (root / relative).resolve()

    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


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
