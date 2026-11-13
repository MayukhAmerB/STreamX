"""Session list (``GET /api/realtime/sessions/``): shared cache and ETags.

Every open live-class page polls this list, so it must cost almost nothing:

* The default is **active sessions only** (scheduled + live). ``status=all``
  (all-time history) is a staff-only view; see ``normalize_session_list_status``.
* Rows for ordinary students come from ONE shared, short-lived cache entry per
  (filters, public host) instead of one entry per user. It is filled with
  ``get_or_compute`` (single flight), so a class of 500 polling at once costs
  one query + one serialization per TTL. Per-user visibility is applied in
  Python from the cached visibility columns.
* OBS stream health is read from the cached Owncast status and applied in
  memory only. GETs never write ``stream_status``; the periodic
  ``realtime.obs_stream_health`` hook is the writer.
* Responses carry a weak ETag. A poll whose ``If-None-Match`` matches gets a
  bodiless 304.
* Unpaginated responses are bounded (``REALTIME_SESSION_LIST_MAX_ROWS``).

Staff, instructors and anyone who moderates a listed session take the direct
(per-user) path, because their rows carry private fields (the OBS key) and
moderator-only join flags.
"""

from __future__ import annotations

import hashlib
import json

from django.conf import settings
from django.contrib.auth.models import AnonymousUser
from django.http import HttpResponseNotModified

from apps.core.concurrency import get_or_compute

from .domain import SessionVisibility, base_list_queryset, session_visibility_meta
from .models import RealtimeSession
from .serializers import RealtimeSessionListSerializer
from .services import refresh_obs_session_stream_health

SHARED_CACHE_VERSION = 1
SHARED_STATUSES = {"active", RealtimeSession.STATUS_SCHEDULED, RealtimeSession.STATUS_LIVE}
# Per-request fields that never feed the ETag (they change on every compute).
VOLATILE_SCHEDULE_KEYS = ("server_time",)


def max_rows():
    return max(1, int(getattr(settings, "REALTIME_SESSION_LIST_MAX_ROWS", 200) or 200))


def shared_cache_ttl_seconds():
    return max(0, int(getattr(settings, "REALTIME_SESSION_LIST_SHARED_CACHE_TTL_SECONDS", 4) or 0))


def is_privileged_user(user):
    """Users whose rows differ from the shared student view."""
    if bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False)):
        return True
    return str(getattr(user, "role", "") or "").strip().lower() == "instructor"


def apply_in_memory_stream_health(sessions):
    """Owncast is the authority for OBS availability; read it from the cached
    status and apply it to the rows in memory only (no write on a GET)."""
    for session in sessions:
        if (
            session.session_type == RealtimeSession.TYPE_BROADCASTING
            and session.stream_service == RealtimeSession.STREAM_SERVICE_OBS
            and session.status != RealtimeSession.STATUS_ENDED
        ):
            refresh_obs_session_stream_health(session, persist=False)


class _AnonymousView:
    """The request as seen by an anonymous user: serializes rows without any
    per-user field so the result can be shared between students."""

    def __init__(self, request):
        self._request = request
        self.user = AnonymousUser()

    def __getattr__(self, name):
        return getattr(self._request, name)


def _host_fingerprint(request):
    try:
        host = request.get_host().lower()
    except Exception:  # noqa: BLE001 - DisallowedHost already rejected upstream
        host = ""
    raw = f"{request.scheme}://{host}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _compute_shared_rows(*, request, session_type, status_filter):
    sessions = list(base_list_queryset(session_type=session_type, status_filter=status_filter)[: max_rows()])
    apply_in_memory_stream_health(sessions)
    serializer = RealtimeSessionListSerializer(sessions, many=True, context={"request": _AnonymousView(request)})
    return [
        {"data": dict(row), "meta": session_visibility_meta(session)}
        for row, session in zip(serializer.data, sessions, strict=True)
    ]


def shared_rows(*, request, session_type, status_filter):
    ttl = shared_cache_ttl_seconds()

    def compute():
        return _compute_shared_rows(request=request, session_type=session_type, status_filter=status_filter)

    if ttl <= 0:
        return compute()
    key = (
        f"realtime:session-list:shared:v{SHARED_CACHE_VERSION}:"
        f"type={session_type or '-'}:status={status_filter}:host={_host_fingerprint(request)}"
    )
    return get_or_compute(key, ttl, compute, stale_ttl=ttl, lock_ttl=10, wait_timeout=2.0)


def personalise_shared_rows(rows, user):
    """The rows ``user`` may see, with the per-user flags filled in.

    Returns None when the user moderates one of the visible sessions: those
    rows need the direct path (private OBS key, moderator join flags).
    """
    visibility = SessionVisibility(user)
    payload = []
    for row in rows:
        meta = row["meta"]
        if not visibility.can_see(meta):
            continue
        if visibility.is_moderator(meta):
            return None
        data = dict(row["data"])
        data["is_host"] = False
        data["can_manage"] = False
        payload.append(data)
    return payload


def _etag_material(payload):
    rows = payload.get("results") if isinstance(payload, dict) else payload
    stable = []
    for row in rows or []:
        if isinstance(row, dict) and isinstance(row.get("live_schedule"), dict):
            row = {
                **row,
                "live_schedule": {
                    key: value for key, value in row["live_schedule"].items() if key not in VOLATILE_SCHEDULE_KEYS
                },
            }
        stable.append(row)
    if isinstance(payload, dict):
        return {**payload, "results": stable}
    return stable


def build_etag(payload):
    material = json.dumps(_etag_material(payload), sort_keys=True, default=str, separators=(",", ":"))
    return 'W/"' + hashlib.sha256(material.encode("utf-8")).hexdigest()[:32] + '"'


def _strip_weak(tag):
    tag = tag.strip()
    return tag[2:] if tag.startswith("W/") else tag


def if_none_match_matches(request, etag):
    header = str(request.META.get("HTTP_IF_NONE_MATCH", "") or "").strip()
    if not header:
        return False
    if header == "*":
        return True
    wanted = _strip_weak(etag)
    return any(_strip_weak(candidate) == wanted for candidate in header.split(","))


def not_modified(etag):
    response = HttpResponseNotModified()
    response["ETag"] = etag
    response["Cache-Control"] = "private, no-cache"
    return response
