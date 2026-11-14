"""Finishing a live class on an evicted device (Phase 2, D5).

Signing in on one device too many evicts the least recently used device
(session_policy). When that device is watching a live class, it is not thrown
out mid-class: its slot becomes a SessionSlotLiveGrace bound to that class.
Until the class ends, the device's tokens still authenticate the requests the
class needs on every live surface (the OBS / Host Studio player and its
stream-access refresh, the chat, meeting rejoin, the session poll), and its
refresh token keeps rotating so a class longer than the access-token lifetime
keeps playing. Everything else is refused. Every response to such a device
carries ``X-Session-State: live-grace`` so the client shows the "signed in on
another device" banner instead of the blocking dialog. Once the class ends,
the device's next refresh is rejected (``session_replaced``, reason
``live_class_ended``) and it is signed out with that explanation.

The grace never counts against the device cap and is bound to one class: an
evicted device cannot use it to watch a later class.
"""

from django.urls import Resolver404, resolve
from django.utils import timezone
from rest_framework_simplejwt.settings import api_settings

from .models import SessionSlotLiveGrace


LIVE_GRACE_HEADER = "X-Session-State"
LIVE_GRACE_STATE = "live-grace"
# Set on the Django HttpRequest by the authentication class (or the refresh
# view); LiveGraceHeaderMiddleware turns it into the response header.
LIVE_GRACE_REQUEST_ATTR = "session_live_grace"
LIVE_CLASS_ENDED_REASON = "live_class_ended"

GRACE_LIVE = "live"
GRACE_ENDED = "ended"

_READ = frozenset({"GET", "HEAD", "OPTIONS"})
_WRITE = frozenset({"POST", "OPTIONS"})

# Requests about the class the device may finish (URL kwarg ``pk`` must be it).
_CLASS_ROUTES = {
    "realtime-session-detail": _READ,
    "realtime-session-join": _WRITE,
    "realtime-session-connection-event": _WRITE,
    "realtime-session-broadcast-playback-issue": _WRITE,
    "realtime-session-owncast-chat-launch": _WRITE,
    "realtime-session-owncast-stream-launch": _WRITE,
}
# Reads the live-class page needs to load (a reload mid-class) and to notice
# the class ending.
_PAGE_ROUTES = {
    "auth-user": _READ,
    "realtime-session-list-create": _READ,
}


def live_class_running(session_id):
    """True while attendees may still be in the class (live, not abandoned)."""
    if not session_id:
        return False
    # Imported lazily: the users app must not depend on realtime at import time.
    from apps.realtime.models import RealtimeSession
    from apps.realtime.schedule import attendee_can_join_live_session

    session = RealtimeSession.objects.filter(pk=session_id).only("id", "status", "started_at").first()
    return bool(session is not None and attendee_can_join_live_session(session))


def live_grace_state(user, slot_id):
    """(GRACE_LIVE | GRACE_ENDED, session_id) for an evicted slot, else None."""
    if not user or not slot_id:
        return None
    grace = (
        SessionSlotLiveGrace.objects.filter(user_id=user.pk, slot_id=slot_id)
        .values_list("session_id", flat=True)
        .first()
    )
    if grace is None:
        return None
    return (GRACE_LIVE if live_class_running(grace) else GRACE_ENDED), grace


def grant_live_graces(user, evicted_slots, *, now=None):
    """Let evicted slots that are in a running class finish it.

    ``evicted_slots`` holds (slot_id, live_session_id) pairs. Caller holds the
    user's row lock. Returns how many were granted.
    """
    now = now or timezone.now()
    granted = 0
    running = {}
    for slot_id, session_id in evicted_slots:
        if not session_id:
            continue
        if session_id not in running:
            running[session_id] = live_class_running(session_id)
        if not running[session_id]:
            continue
        SessionSlotLiveGrace.objects.update_or_create(
            slot_id=slot_id,
            defaults={"user": user, "session_id": session_id, "evicted_at": now},
        )
        granted += 1
    return granted


def purge_expired_live_graces(user, *, now=None):
    """Drop graces whose refresh tokens have expired anyway.

    A grace whose class ended is kept until then, so a device that comes back
    late still learns why it was signed out.
    """
    cutoff = (now or timezone.now()) - api_settings.REFRESH_TOKEN_LIFETIME
    SessionSlotLiveGrace.objects.filter(user_id=user.pk, evicted_at__lt=cutoff).delete()


def release_live_grace(user, slot_id):
    if slot_id:
        SessionSlotLiveGrace.objects.filter(user_id=user.pk, slot_id=slot_id).delete()


def release_all_live_graces(user):
    SessionSlotLiveGrace.objects.filter(user_id=user.pk).delete()


def request_allowed_during_live_grace(request, session_id):
    """True when ``request`` is one the class ``session_id`` needs."""
    method = str(getattr(request, "method", "") or "").upper()
    path = getattr(request, "path_info", None) or getattr(request, "path", "")
    try:
        match = resolve(path)
    except Resolver404:
        return False
    name = match.url_name
    if name in _PAGE_ROUTES:
        return method in _PAGE_ROUTES[name]
    methods = _CLASS_ROUTES.get(name)
    if not methods or method not in methods:
        return False
    try:
        return int(match.kwargs.get("pk")) == int(session_id)
    except (TypeError, ValueError):
        return False


def mark_live_grace(request):
    """Flag the response (X-Session-State: live-grace) for this request."""
    target = getattr(request, "_request", request)
    setattr(target, LIVE_GRACE_REQUEST_ATTR, True)


class LiveGraceHeaderMiddleware:
    """Adds ``X-Session-State: live-grace`` for devices finishing a class."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if getattr(request, LIVE_GRACE_REQUEST_ATTR, False):
            response[LIVE_GRACE_HEADER] = LIVE_GRACE_STATE
        return response
