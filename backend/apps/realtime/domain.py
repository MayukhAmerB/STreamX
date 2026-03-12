from dataclasses import dataclass
from typing import Callable, Optional

from django.conf import settings
from django.db.models import Q

from apps.courses.models import LiveClassEnrollment

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


def list_queryset(*, session_type: str, status_filter: str, user):
    queryset = RealtimeSession.objects.with_related()

    if session_type in {RealtimeSession.TYPE_MEETING, RealtimeSession.TYPE_BROADCASTING}:
        queryset = queryset.filter(session_type=session_type)

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

    if not user or not getattr(user, "is_authenticated", False):
        return queryset.none()

    is_admin = bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
    if is_admin:
        return queryset

    approved_live_class_ids = LiveClassEnrollment.objects.filter(
        user_id=user.id,
        status=LiveClassEnrollment.STATUS_APPROVED,
        live_class__is_active=True,
    ).values_list("live_class_id", flat=True)
    return queryset.filter(
        Q(host_id=user.id)
        | Q(linked_course__instructor_id=user.id)
        | Q(linked_live_class_id__in=approved_live_class_ids)
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
        if not session.linked_live_class_id:
            return JoinAccessDecision(
                allowed=False,
                status_code=403,
                message="Access denied.",
                detail="This live session is not linked to a permitted live class.",
                is_host=is_host,
                is_admin=is_admin,
                is_instructor_owner=is_instructor_owner,
            )
        is_enrolled = LiveClassEnrollment.objects.filter(
            user_id=user.id,
            live_class_id=session.linked_live_class_id,
            status=LiveClassEnrollment.STATUS_APPROVED,
            live_class__is_active=True,
        ).exists()
        if not is_enrolled:
            return JoinAccessDecision(
                allowed=False,
                status_code=403,
                message="Access denied.",
                detail="You are not approved for the live class linked to this session.",
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
    can_speak = session.session_type == RealtimeSession.TYPE_MEETING and session.is_speaker_allowed(user)
    can_publish = bool(can_present or can_speak)

    can_publish_sources = None
    if session.session_type == RealtimeSession.TYPE_MEETING:
        if can_present:
            can_publish_sources = ["camera", "microphone", "screen_share", "screen_share_audio"]
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
