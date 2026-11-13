from dataclasses import dataclass
from typing import Callable, Optional

from django.conf import settings
from django.core.cache import cache
from django.db.models import Q

from apps.courses.access import (
    accessible_course_ids_for_user,
    accessible_live_class_ids_for_user,
    user_has_course_access,
    user_has_live_class_access,
)

from .models import RealtimeSession


@dataclass(frozen=True)
class JoinAccessDecision:
    allowed: bool
    status_code: int
    message: str
    detail: str
    is_host: bool
    is_admin: bool
    is_instructor_owner: bool


@dataclass(frozen=True)
class JoinPermissionSet:
    can_manage_presenters: bool
    can_present: bool
    can_speak: bool
    can_publish: bool
    can_publish_sources: Optional[list[str]]


@dataclass(frozen=True)
class ParticipantState:
    participant_count: int
    participant_count_source: str
    should_use_broadcast: bool
    overflow_triggered: bool


def _enrollment_access_cache_ttl_seconds():
    return max(0, int(getattr(settings, "REALTIME_ENROLLMENT_ACCESS_CACHE_TTL_SECONDS", 10) or 0))


def _build_enrollment_access_cache_key(*, user_id, course_id=None, live_class_id=None):
    return (
        f"realtime:join-access:user={int(user_id)}:"
        f"course={int(course_id or 0)}:live-class={int(live_class_id or 0)}"
    )


def invalidate_course_join_access_cache(*, user_id, course_id):
    if not user_id or not course_id:
        return
    live_class_ids = set(
        RealtimeSession.objects.filter(
            Q(linked_course_id=course_id) | Q(linked_live_class__linked_course_id=course_id)
        )
        .exclude(linked_live_class_id__isnull=True)
        .values_list("linked_live_class_id", flat=True)
    )
    cache.delete_many(
        [
            _build_enrollment_access_cache_key(
                user_id=user_id,
                course_id=course_id,
                live_class_id=live_class_id,
            )
            for live_class_id in [None, *sorted(live_class_ids)]
        ]
    )


SESSION_LIST_STATUS_ACTIVE = "active"
SESSION_LIST_STATUS_ALL = "all"


def normalize_session_list_status(raw_status, *, is_admin):
    """The status filter the session list really applies.

    Omitted (or unknown) means ``active``: scheduled and live sessions only.
    ``all`` (every session ever) is kept for staff; for everyone else it is the
    same as ``active`` -- every student-facing page drops ended sessions anyway,
    and all-time history is the most expensive thing this endpoint can return.
    """
    value = str(raw_status or "").strip().lower()
    if value in {
        RealtimeSession.STATUS_SCHEDULED,
        RealtimeSession.STATUS_LIVE,
        RealtimeSession.STATUS_ENDED,
    }:
        return value
    if value == SESSION_LIST_STATUS_ALL and is_admin:
        return SESSION_LIST_STATUS_ALL
    return SESSION_LIST_STATUS_ACTIVE


def base_list_queryset(*, session_type: str, status_filter: str):
    """Sessions matching the type/status filters, before per-user visibility."""
    queryset = RealtimeSession.objects.with_related()

    if session_type in {RealtimeSession.TYPE_MEETING, RealtimeSession.TYPE_BROADCASTING}:
        queryset = queryset.filter(session_type=session_type)

    if status_filter in {
        RealtimeSession.STATUS_SCHEDULED,
        RealtimeSession.STATUS_LIVE,
        RealtimeSession.STATUS_ENDED,
    }:
        queryset = queryset.filter(status=status_filter)
    elif status_filter != SESSION_LIST_STATUS_ALL:
        queryset = queryset.filter(
            status__in=[RealtimeSession.STATUS_SCHEDULED, RealtimeSession.STATUS_LIVE]
        )
    return queryset


def session_visibility_meta(session):
    """The columns ``list_queryset`` filters on, for filtering cached rows in Python."""
    linked_course = getattr(session, "linked_course", None)
    return {
        "host_id": session.host_id,
        "instructor_user_id": session.get_instructor_user_id(),
        "linked_course_id": session.linked_course_id,
        "linked_course_instructor_id": getattr(linked_course, "instructor_id", None),
        "linked_live_class_id": session.linked_live_class_id,
    }


class SessionVisibility:
    """Python twin of ``list_queryset``'s per-user filter for a non-admin user.

    The accessible course / live-class ids are loaded lazily, once, and only
    when a row is not visible for a cheaper reason.
    """

    def __init__(self, user):
        self.user_id = getattr(user, "id", None)
        self._user = user
        self._course_ids = None
        self._live_class_ids = None

    def _accessible_course_ids(self):
        if self._course_ids is None:
            self._course_ids = set(accessible_course_ids_for_user(self._user))
        return self._course_ids

    def _accessible_live_class_ids(self):
        if self._live_class_ids is None:
            self._live_class_ids = set(accessible_live_class_ids_for_user(self._user))
        return self._live_class_ids

    def can_see(self, meta):
        if not self.user_id:
            return False
        course_id = meta.get("linked_course_id")
        live_class_id = meta.get("linked_live_class_id")
        if meta.get("host_id") == self.user_id:
            return True
        if course_id is not None and meta.get("linked_course_instructor_id") == self.user_id:
            return True
        if course_id is None and live_class_id is None:
            return True
        if course_id is not None and course_id in self._accessible_course_ids():
            return True
        return live_class_id is not None and live_class_id in self._accessible_live_class_ids()

    def is_moderator(self, meta):
        return bool(self.user_id) and self.user_id in {meta.get("host_id"), meta.get("instructor_user_id")}


def list_queryset(*, session_type: str, status_filter: str, user):
    queryset = base_list_queryset(session_type=session_type, status_filter=status_filter)

    if not user or not getattr(user, "is_authenticated", False):
        return queryset.none()

    is_admin = bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
    if is_admin:
        return queryset

    accessible_course_ids = accessible_course_ids_for_user(user)
    accessible_live_class_ids = accessible_live_class_ids_for_user(user)
    return queryset.filter(
        Q(host_id=user.id)
        | Q(linked_course__instructor_id=user.id)
        | Q(linked_course_id__in=accessible_course_ids)
        | Q(linked_live_class_id__in=accessible_live_class_ids)
        | Q(linked_course__isnull=True, linked_live_class__isnull=True)
    )


def session_payload_for_create(validated_data):
    payload = dict(validated_data)
    linked_live_class = payload.get("linked_live_class")
    if linked_live_class and not payload.get("linked_course"):
        payload["linked_course"] = linked_live_class.linked_course
    default_capacity = int(
        getattr(settings, "REALTIME_DEFAULT_MEETING_CAPACITY", RealtimeSession.MAX_MEETING_CAPACITY)
        or RealtimeSession.MAX_MEETING_CAPACITY
    )
    payload.setdefault("meeting_capacity", max(2, min(RealtimeSession.MAX_MEETING_CAPACITY, default_capacity)))
    payload["meeting_capacity"] = max(
        2,
        min(RealtimeSession.MAX_MEETING_CAPACITY, int(payload.get("meeting_capacity") or 0)),
    )

    default_max_audience = int(
        getattr(settings, "REALTIME_DEFAULT_MAX_AUDIENCE", RealtimeSession.MAX_AUDIENCE_LIMIT)
        or RealtimeSession.MAX_AUDIENCE_LIMIT
    )
    payload.setdefault(
        "max_audience",
        max(payload["meeting_capacity"], min(RealtimeSession.MAX_AUDIENCE_LIMIT, default_max_audience)),
    )
    payload["max_audience"] = max(
        payload["meeting_capacity"],
        min(RealtimeSession.MAX_AUDIENCE_LIMIT, int(payload.get("max_audience") or 0)),
    )
    payload.setdefault("status", RealtimeSession.STATUS_LIVE)
    return payload


def get_access_decision(session: RealtimeSession, user) -> JoinAccessDecision:
    is_host = bool(getattr(user, "id", None) == session.host_id)
    is_admin = bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
    is_instructor_owner = session.is_instructor_owner(user)

    if not (is_host or is_admin or is_instructor_owner):
        linked_course_id = session.linked_course_id or getattr(
            getattr(session, "linked_live_class", None),
            "linked_course_id",
            None,
        )
        # Preserve legacy general sessions: only explicitly linked classrooms
        # require a course or live-class entitlement.
        if not linked_course_id and not session.linked_live_class_id:
            return JoinAccessDecision(
                allowed=True,
                status_code=200,
                message="OK",
                detail="",
                is_host=is_host,
                is_admin=is_admin,
                is_instructor_owner=is_instructor_owner,
            )
        cache_ttl_seconds = _enrollment_access_cache_ttl_seconds()
        cache_key = _build_enrollment_access_cache_key(
            user_id=user.id,
            course_id=linked_course_id,
            live_class_id=session.linked_live_class_id,
        )
        is_enrolled = None
        if cache_ttl_seconds > 0:
            is_enrolled = cache.get(cache_key)
        if is_enrolled is None:
            is_enrolled = user_has_course_access(
                user,
                course_id=linked_course_id,
            ) or user_has_live_class_access(
                user,
                live_class_id=session.linked_live_class_id,
                linked_course_id=linked_course_id,
            )
            if cache_ttl_seconds > 0:
                cache.set(cache_key, bool(is_enrolled), timeout=cache_ttl_seconds)
        else:
            is_enrolled = bool(is_enrolled)
        if not is_enrolled:
            return JoinAccessDecision(
                allowed=False,
                status_code=403,
                message="Access denied.",
                detail="You do not have access to the course or live class linked to this session.",
                is_host=is_host,
                is_admin=is_admin,
                is_instructor_owner=is_instructor_owner,
            )

    return JoinAccessDecision(
        allowed=True,
        status_code=200,
        message="OK",
        detail="",
        is_host=is_host,
        is_admin=is_admin,
        is_instructor_owner=is_instructor_owner,
    )


def build_permission_set(session: RealtimeSession, user, decision: JoinAccessDecision) -> JoinPermissionSet:
    can_manage_presenters = session.is_moderator_allowed(user)
    can_present = session.is_presenter_allowed(user)
    can_speak = session.is_speaker_allowed(user)
    can_publish = bool(can_present or can_speak)

    can_publish_sources = None
    if can_present:
        can_publish_sources = ["camera", "screen_share", "screen_share_audio"]
        if can_speak:
            can_publish_sources.append("microphone")
    elif can_speak:
        can_publish_sources = ["microphone"]

    return JoinPermissionSet(
        can_manage_presenters=can_manage_presenters,
        can_present=can_present,
        can_speak=can_speak,
        can_publish=can_publish,
        can_publish_sources=can_publish_sources,
    )


def resolve_participant_state(
    session: RealtimeSession,
    *,
    room_name: str,
    is_host: bool,
    participant_counter: Callable[[str], Optional[int]],
) -> ParticipantState:
    participant_count = 0
    participant_count_source = "fallback"

    if session.session_type == RealtimeSession.TYPE_MEETING:
        count_result = participant_counter(room_name)
        count = getattr(count_result, "count", count_result)
        source = getattr(count_result, "source", "livekit" if count is not None else "fallback")
        if count is not None:
            participant_count = max(0, int(count))
            participant_count_source = source or "livekit"

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

    return ParticipantState(
        participant_count=participant_count,
        participant_count_source=participant_count_source,
        should_use_broadcast=should_use_broadcast,
        overflow_triggered=overflow_triggered,
    )
