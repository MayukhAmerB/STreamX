"""Write-behind flush: Redis presence buffer -> ``AttendanceRecord`` rows.

Runs from the worker (``attendance.flush`` periodic outbox event, every
``ATTENDANCE_FLUSH_INTERVAL_SECONDS``) and right before a session is
finalised. One batch = one transaction together with its
``AttendanceFlushLog`` row, so a batch is applied exactly once even if the
worker dies between the commit and the Redis ``DEL``.
"""

from __future__ import annotations

import logging
from datetime import datetime
from datetime import timezone as dt_timezone

from django.db import IntegrityError, transaction
from django.utils import timezone

from . import buffer, conf, policy
from .metrics import record_flush_rows
from .models import AttendanceFlushLog, AttendancePolicy, AttendanceRecord, SessionAttendance

logger = logging.getLogger("apps.attendance.flush")


def _dt(epoch: float | None):
    if epoch is None:
        return None
    try:
        return datetime.fromtimestamp(float(epoch), tz=dt_timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _session_rows(session_ids):
    from apps.realtime.models import RealtimeSession

    rows = RealtimeSession.objects.filter(pk__in=session_ids).values(
        "id", "title", "linked_course_id", "linked_live_class_id", "linked_live_class__linked_course_id", "started_at"
    )
    return {row["id"]: row for row in rows}


def apply_pairs(pairs: dict[tuple[int, int], dict[str, float]], *, now=None) -> int:
    """Merge one batch into the records (caller holds the transaction)."""
    if not pairs:
        return 0
    now = now or timezone.now()
    session_ids = {session_id for session_id, _user_id in pairs}
    user_ids = {user_id for _session_id, user_id in pairs}
    sessions = _session_rows(session_ids)
    existing = {
        (record.session_ref_id, record.user_id): record
        for record in AttendanceRecord.objects.select_for_update().filter(
            session_ref_id__in=session_ids, user_id__in=user_ids
        )
    }
    finalized = {
        row.session_ref_id: row
        for row in SessionAttendance.objects.filter(session_ref_id__in=session_ids, finalized_at__isnull=False)
    }
    rule = policy.Rule.from_policy(AttendancePolicy.current())
    to_create, to_update = [], []
    for (session_id, user_id), values in pairs.items():
        session = sessions.get(session_id)
        if session is not None and not conf.course_tracked(
            session["linked_course_id"] or session["linked_live_class__linked_course_id"]
        ):
            continue  # batch excluded by ATTENDANCE_FROM_COURSE_ID (pings buffered before the rule)
        seconds = int(values.get("sec", 0) or 0)
        first = _dt(values.get("first"))
        last = _dt(values.get("last"))
        record = existing.get((session_id, user_id))
        if record is None:
            session = sessions.get(session_id)
            if session is None:
                continue  # the session was deleted before the flush
            record = AttendanceRecord(
                session_id=session_id,
                session_ref_id=session_id,
                user_id=user_id,
                course_id=session["linked_course_id"] or session["linked_live_class__linked_course_id"],
                live_class_id=session["linked_live_class_id"],
                title=str(session["title"] or "")[:255],
                class_start=session["started_at"],
                first_joined_at=first or now,
                last_seen_at=last or now,
                seconds_present=max(0, seconds),
                source=AttendanceRecord.SOURCE_PRESENCE if seconds else AttendanceRecord.SOURCE_JOIN,
            )
            to_create.append(record)
        else:
            record.seconds_present = int(record.seconds_present or 0) + max(0, seconds)
            if first and (record.first_joined_at is None or first < record.first_joined_at):
                record.first_joined_at = first
            if last and (record.last_seen_at is None or last > record.last_seen_at):
                record.last_seen_at = last
            if record.source == AttendanceRecord.SOURCE_ROSTER:
                record.source = AttendanceRecord.SOURCE_PRESENCE
            to_update.append(record)
        summary = finalized.get(session_id)
        if summary is not None:
            # A late ping (cached "live" status) for an already finalised class.
            _restatus(record, summary.on_air_seconds, rule, now)
        elif not record.manual_override:
            # Provisional while the class runs: present once over the bar, else partial.
            record.status = (
                AttendanceRecord.STATUS_PRESENT
                if record.seconds_present >= rule.present_min_seconds
                else AttendanceRecord.STATUS_PARTIAL
            )
    if to_create:
        AttendanceRecord.objects.bulk_create(to_create)
    if to_update:
        AttendanceRecord.objects.bulk_update(
            to_update,
            ["seconds_present", "first_joined_at", "last_seen_at", "source", "status", "percent", "updated_at"],
        )
    if finalized:
        from .services import recount_summary

        for session_id in finalized:
            recount_summary(session_id)
    return len(to_create) + len(to_update)


def _restatus(record, on_air_seconds: int, rule, now) -> None:
    record.seconds_present = min(int(record.seconds_present or 0), int(on_air_seconds or 0))
    record.percent = policy.percent(record.seconds_present, on_air_seconds)
    if not record.manual_override:
        record.status, _threshold = policy.classify(
            seconds_present=record.seconds_present,
            joined=record.first_joined_at is not None,
            on_air_seconds=on_air_seconds,
            rule=rule,
        )
    record.updated_at = now


def flush(*, now=None) -> dict[str, int]:
    stats = {"batches": 0, "rows": 0}
    for token, data in buffer.take_batches():
        pairs = buffer.parse_batch(data)
        token = str(token)[:64]
        try:
            with transaction.atomic():
                try:
                    with transaction.atomic():
                        AttendanceFlushLog.objects.create(token=token, rows=len(pairs))
                except IntegrityError:
                    logger.info("attendance.flush: batch %s already applied", token)
                    pairs = {}
                rows = apply_pairs(pairs, now=now)
        except Exception:
            # Not acknowledged: a Redis batch stays in the processing set and is
            # retried by the next flush.
            logger.exception("attendance.flush: batch %s failed", token)
            raise
        buffer.ack(token)
        stats["batches"] += 1
        stats["rows"] += rows
        record_flush_rows(rows)
    return stats
