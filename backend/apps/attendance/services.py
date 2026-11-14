"""Attendance writes: finalisation, staff overrides and summary counts.

``finalize_session`` is idempotent: running it again (outbox retry, sweep,
engagement asking first) recomputes the same statuses, never duplicates rows
and never touches a staff override.
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone

from apps.core.errors import NotFound, ValidationFailed

from . import access, flush, policy
from .models import AttendanceAudit, AttendancePolicy, AttendanceRecord, SessionAttendance

logger = logging.getLogger("apps.attendance.services")

OVERRIDE_STATUSES = (*AttendanceRecord.STATUSES, "auto")
REASON_MIN_LENGTH = 3
REASON_MAX_LENGTH = 300


def current_rule() -> policy.Rule:
    return policy.Rule.from_policy(AttendancePolicy.current())


def on_air_seconds(session) -> int:
    if not session.started_at or not session.ended_at:
        return 0
    return max(0, int((session.ended_at - session.started_at).total_seconds()))


def recount_summary(session_ref_id) -> SessionAttendance | None:
    summary = SessionAttendance.objects.filter(session_ref_id=session_ref_id).first()
    if summary is None:
        return None
    counts = {status: 0 for status in AttendanceRecord.STATUSES}
    for status in AttendanceRecord.objects.filter(session_ref_id=session_ref_id).values_list("status", flat=True):
        counts[status] = counts.get(status, 0) + 1
    summary.present_count = counts[AttendanceRecord.STATUS_PRESENT]
    summary.partial_count = counts[AttendanceRecord.STATUS_PARTIAL]
    summary.absent_count = counts[AttendanceRecord.STATUS_ABSENT]
    summary.excused_count = counts[AttendanceRecord.STATUS_EXCUSED]
    summary.roster_count = sum(counts.values())
    summary.save(
        update_fields=[
            "present_count",
            "partial_count",
            "absent_count",
            "excused_count",
            "roster_count",
            "updated_at",
        ]
    )
    return summary


def _apply_status(record, *, on_air: int, rule: policy.Rule, now) -> None:
    record.seconds_present = min(int(record.seconds_present or 0), on_air)
    record.on_air_seconds = on_air
    record.percent = policy.percent(record.seconds_present, on_air)
    if not record.manual_override:
        record.status, _threshold = policy.classify(
            seconds_present=record.seconds_present,
            joined=record.first_joined_at is not None,
            on_air_seconds=on_air,
            rule=rule,
        )
    record.finalized_at = record.finalized_at or now
    record.updated_at = now


def finalize_session(session_id, *, now=None, flush_first: bool = True) -> SessionAttendance | None:
    """Finalise one ended class: absent rows for non-joiners, statuses, counts."""
    from apps.courses.models import Course
    from apps.realtime.models import RealtimeSession

    session = RealtimeSession.objects.select_related("linked_live_class", "linked_course").filter(pk=session_id).first()
    if session is None or session.status != RealtimeSession.STATUS_ENDED:
        return None
    if not session.started_at or not session.ended_at:
        return None  # never went on air: nothing to attend
    if flush_first:
        flush.flush(now=now)
    now = now or timezone.now()
    rule = current_rule()
    on_air = on_air_seconds(session)
    threshold = policy.threshold_for(on_air, rule)
    course_id = access.session_course_id(session)
    course = session.linked_course
    if course is None and course_id:
        course = Course.objects.filter(pk=course_id).only("id", "instructor_id").first()
    roster = access.roster_user_ids(
        course_id=course_id,
        live_class_id=session.linked_live_class_id,
        enrolled_before=session.ended_at,
        exclude_ids=access.session_managers(session, course),
    )
    with transaction.atomic():
        summary = SessionAttendance.objects.select_for_update().filter(session_ref_id=session.pk).first()
        if summary is None:
            summary = SessionAttendance.objects.create(session=session, session_ref_id=session.pk)
            summary = SessionAttendance.objects.select_for_update().get(pk=summary.pk)
        known = set(AttendanceRecord.objects.filter(session_ref_id=session.pk).values_list("user_id", flat=True))
        missing = [user_id for user_id in roster if user_id not in known]
        if missing:
            AttendanceRecord.objects.bulk_create(
                [
                    AttendanceRecord(
                        session=session,
                        session_ref_id=session.pk,
                        user_id=user_id,
                        course_id=course_id,
                        live_class_id=session.linked_live_class_id,
                        title=session.title[:255],
                        class_start=session.started_at,
                        status=AttendanceRecord.STATUS_ABSENT,
                        source=AttendanceRecord.SOURCE_ROSTER,
                    )
                    for user_id in missing
                ],
                ignore_conflicts=True,
            )
        records = list(AttendanceRecord.objects.select_for_update().filter(session_ref_id=session.pk))
        for record in records:
            _apply_status(record, on_air=on_air, rule=rule, now=now)
            if record.course_id is None and course_id:
                record.course_id = course_id
            if record.class_start is None:
                record.class_start = session.started_at
        if records:
            AttendanceRecord.objects.bulk_update(
                records,
                ["seconds_present", "on_air_seconds", "percent", "status", "finalized_at", "updated_at", "course", "class_start"],
                batch_size=500,
            )
        summary.session = session
        summary.course_id = course_id
        summary.title = session.title[:255]
        summary.class_start = session.started_at
        summary.on_air_seconds = on_air
        summary.threshold_seconds = threshold.seconds
        summary.short_session = threshold.short_session
        summary.finalized_at = summary.finalized_at or now
        summary.finalize_count = int(summary.finalize_count or 0) + 1
        summary.save()
        recount_summary(session.pk)
    summary.refresh_from_db()
    if threshold.short_session:
        logger.info(
            "attendance.short_session session_id=%s on_air=%ss threshold=%ss", session.pk, on_air, threshold.seconds
        )
    return summary


def finalize_pending_sessions(*, now=None, limit: int = 20) -> list[int]:
    """Safety net: finalise ended classes that have no summary yet."""
    from datetime import timedelta

    from apps.realtime.models import RealtimeSession

    from . import conf

    now = now or timezone.now()
    since = now - timedelta(hours=conf.finalize_sweep_lookback_hours())
    settle = now - timedelta(seconds=conf.finalize_delay_seconds())
    done_ids = SessionAttendance.objects.filter(finalized_at__isnull=False).values_list("session_ref_id", flat=True)
    candidates = list(
        RealtimeSession.objects.filter(
            status=RealtimeSession.STATUS_ENDED,
            started_at__isnull=False,
            ended_at__gte=since,
            ended_at__lte=settle,
        )
        .exclude(pk__in=done_ids)
        .order_by("ended_at")
        .values_list("pk", flat=True)[:limit]
    )
    finalized = []
    flushed = False
    for session_id in candidates:
        try:
            finalize_session(session_id, now=now, flush_first=not flushed)
            flushed = True
            finalized.append(session_id)
        except Exception:  # noqa: BLE001 - one bad session must not stop the sweep
            logger.exception("attendance.finalize_sweep failed session_id=%s", session_id)
    return finalized


def _clean_reason(reason) -> str:
    from config.model_validators import validate_no_active_content

    text = " ".join(str(reason or "").split())
    if len(text) < REASON_MIN_LENGTH:
        raise ValidationFailed("Give a short reason.", details={"reason": ["Give a short reason (3+ characters)."]})
    if len(text) > REASON_MAX_LENGTH:
        raise ValidationFailed("The reason is too long.", details={"reason": [f"Use at most {REASON_MAX_LENGTH} characters."]})
    try:
        validate_no_active_content(text, "reason")
    except Exception as exc:  # noqa: BLE001
        raise ValidationFailed(
            "The reason contains unsupported content.", details={"reason": ["Remove script or HTML from the reason."]}
        ) from exc
    return text


def _client_ip(request) -> str:
    if request is None:
        return ""
    try:
        from config.client_ip import resolve_client_ip

        return str(resolve_client_ip(request) or "")[:64]
    except Exception:  # noqa: BLE001
        return str(request.META.get("REMOTE_ADDR", "") or "")[:64]


def override_status(*, session_ref_id, user_id, status: str, reason: str, actor, scope=access.ALL, request=None):
    """Staff/instructor correction (audited). ``status="auto"`` removes the override."""
    from apps.realtime.models import RealtimeSession

    status = str(status or "").strip().lower()
    if status not in OVERRIDE_STATUSES:
        raise ValidationFailed("Unknown status.", details={"status": [f"Use one of: {', '.join(OVERRIDE_STATUSES)}."]})
    reason = _clean_reason(reason)
    session = RealtimeSession.objects.select_related("linked_live_class").filter(pk=session_ref_id).first()
    with transaction.atomic():
        record = (
            AttendanceRecord.objects.select_for_update().filter(session_ref_id=session_ref_id, user_id=user_id).first()
        )
        if record is None:
            if session is None:
                raise NotFound("Class not found.", code="attendance_session_not_found")
            course_id = access.session_course_id(session)
            access.require_course_in_scope(scope, course_id)
            roster = access.roster_user_ids(course_id=course_id, live_class_id=session.linked_live_class_id)
            if int(user_id) not in roster:
                raise ValidationFailed(
                    "This student is not in the class's batch.", details={"user_id": ["Not enrolled in this batch."]}
                )
            record = AttendanceRecord.objects.create(
                session=session,
                session_ref_id=session.pk,
                user_id=user_id,
                course_id=course_id,
                live_class_id=session.linked_live_class_id,
                title=session.title[:255],
                class_start=session.started_at,
                status=AttendanceRecord.STATUS_ABSENT,
                source=AttendanceRecord.SOURCE_MANUAL,
            )
        else:
            access.require_course_in_scope(scope, record.course_id)
        from_status, from_override = record.status, record.manual_override
        now = timezone.now()
        if status == "auto":
            record.manual_override = False
            summary = SessionAttendance.objects.filter(session_ref_id=session_ref_id, finalized_at__isnull=False).first()
            if summary is not None:
                _apply_status(record, on_air=summary.on_air_seconds, rule=current_rule(), now=now)
        else:
            record.status = status
            record.manual_override = True
        record.override_reason = reason
        record.overridden_by = actor if getattr(actor, "pk", None) else None
        record.overridden_at = now
        record.save()
        AttendanceAudit.objects.create(
            record=record,
            actor=actor if getattr(actor, "pk", None) else None,
            from_status=from_status,
            to_status=record.status,
            from_override=from_override,
            to_override=record.manual_override,
            reason=reason,
            ip_address=_client_ip(request),
        )
        recount_summary(session_ref_id)
    try:
        from config.audit import log_security_event

        log_security_event(
            "attendance.override",
            request=request,
            session_id=int(session_ref_id),
            student_id=int(user_id),
            from_status=from_status,
            to_status=record.status,
            manual_override=record.manual_override,
        )
    except Exception:  # noqa: BLE001
        logger.debug("attendance.override audit log failed", exc_info=True)
    return record
