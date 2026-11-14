"""Async XP awarding (autodiscovered by ``CoreConfig.ready``).

Each handler re-reads its source rows (the source of truth), builds items with
``sources`` and awards them per user through ``services.award_many``.
Handlers are idempotent: ledger keys are unique, so a retried delivery is a
no-op. With the engagement switch off a handler does nothing (the event is
marked delivered; the backfill command can award it later).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date

from django.utils import timezone

from apps.core.outbox import outbox_handler

from . import flush, leaderboard, rules, services, sources
from .models import LiveAttendance, XpEvent
from .signals import (
    EVENT_EXAM_FINALIZED,
    EVENT_PAYMENT_PAID,
    EVENT_PAYMENT_REFUNDED,
    EVENT_STANDINGS,
    EVENT_FLUSH,
    EVENT_LECTURE_COMPLETED,
    EVENT_LIVE_ENDED,
    EVENT_MARKS_RELEASED,
    EVENT_REBUILD,
    EVENT_REPORT_GRADED,
    EVENT_REPORT_SUBMITTED,
    EVENT_WATCH_AWARD,
)

logger = logging.getLogger("apps.engagement.outbox")


def _award_grouped(pairs) -> int:
    per_user = defaultdict(list)
    for user_id, item in pairs:
        if item is not None:
            per_user[user_id].append(item)
    awarded = 0
    for user_id, items in per_user.items():
        awarded += services.award_many(user_id, items).points
    return awarded


@outbox_handler(EVENT_LECTURE_COMPLETED, max_attempts=8)
def handle_lecture_completed(event):
    if not services.is_enabled():
        return
    from apps.courses.models import LectureProgress

    payload = event.payload or {}
    progress = (
        LectureProgress.objects.select_related("lecture")
        .filter(user_id=payload.get("user_id"), lecture_id=payload.get("lecture_id"))
        .first()
    )
    if progress is None:
        return
    item = sources.lecture_item(progress)
    if item is not None:
        services.award(progress.user_id, item)


def _submission(submission_id):
    from apps.reports.models import ReportSubmission

    return (
        ReportSubmission.objects.select_related("task", "grade").filter(pk=submission_id).first()
    )


@outbox_handler(EVENT_REPORT_SUBMITTED, max_attempts=8)
def handle_report_submitted(event):
    if not services.is_enabled():
        return
    submission = _submission((event.payload or {}).get("submission_id"))
    if submission is None:
        return
    item = sources.report_submitted_item(submission)
    if item is not None:
        services.award(submission.student_id, item)


@outbox_handler(EVENT_REPORT_GRADED, max_attempts=8)
def handle_report_graded(event):
    if not services.is_enabled():
        return
    submission = _submission((event.payload or {}).get("submission_id"))
    if submission is None:
        return
    items = [sources.report_submitted_item(submission), sources.report_graded_item(submission)]
    _award_grouped((submission.student_id, item) for item in items)


@outbox_handler(EVENT_MARKS_RELEASED, max_attempts=8)
def handle_marks_released(event):
    if not services.is_enabled():
        return
    from apps.reports.models import ReportSubmission

    task_id = (event.payload or {}).get("task_id")
    submissions = ReportSubmission.objects.select_related("task", "grade").filter(task_id=task_id, status="graded")
    _award_grouped((row.student_id, sources.report_graded_item(row)) for row in submissions.iterator(chunk_size=500))


@outbox_handler(EVENT_EXAM_FINALIZED, max_attempts=8)
def handle_exam_finalized(event):
    if not services.is_enabled():
        return
    from apps.ctf.models import CtfExamResult

    results = CtfExamResult.objects.select_related("participation").filter(exam_id=(event.payload or {}).get("exam_id"))
    _award_grouped(sources.exam_items(results))


@outbox_handler(EVENT_LIVE_ENDED, max_attempts=8)
def handle_live_ended(event):
    if not services.is_enabled():
        return
    from apps.realtime.models import RealtimeSession

    session = RealtimeSession.objects.filter(pk=(event.payload or {}).get("session_id")).first()
    if session is None:
        return
    flush.flush_live()  # the last presence pings
    on_air = sources.on_air_seconds(session)
    rows = list(LiveAttendance.objects.filter(session_id=session.pk))
    LiveAttendance.objects.filter(session_id=session.pk).update(on_air_seconds=on_air, finalized_at=timezone.now())
    present, tracked, partial = _attendance_results(session)
    # Attendance is the source of truth: XP for every student it marked present
    # (40+ minutes live, or the short-session share; staff overrides count) and
    # the smaller "joined" XP for those it marked partial. Students attendance
    # never saw (classes before it existed) keep the engagement rule on the
    # legacy presence rows. Same ledger key: never paid twice. The first live
    # class a student ever joins adds a one-time bonus (its own once-ever key).
    pairs = [(record.user_id, sources.live_item_present(record, session)) for record in present]
    pairs += [(record.user_id, sources.live_item_partial(record, session)) for record in partial]
    pairs += [(row.user_id, sources.live_item(row, session)) for row in rows if row.user_id not in tracked]
    pairs = [(user_id, item) for user_id, item in pairs if item is not None]
    joined = {user_id for user_id, _item in pairs}
    pairs += [(user_id, sources.first_live_item(user_id, session)) for user_id in sorted(joined)]
    _award_grouped(pairs)


def _attendance_results(session):
    """``(present records, user ids attendance tracked, partial records)`` for
    the class, finalising it first; ``([], set(), [])`` when attendance is
    unavailable (switched off, or an error): the legacy engagement rule applies then."""
    try:
        from apps.attendance import access as attendance_access
        from apps.attendance import services as attendance_services
        from apps.attendance.models import AttendanceRecord

        if not attendance_access.enabled():
            return [], set(), []
        if attendance_services.finalize_session(session.pk) is None:
            return [], set(), []
        records = list(AttendanceRecord.objects.filter(session_ref_id=session.pk))
        tracked = {row.user_id for row in records if row.first_joined_at is not None or row.manual_override}
        present = [row for row in records if row.status == AttendanceRecord.STATUS_PRESENT and row.user_id in tracked]
        partial = [
            row
            for row in records
            if row.status == AttendanceRecord.STATUS_PARTIAL and row.first_joined_at is not None and row.user_id in tracked
        ]
        return present, tracked, partial
    except Exception:  # noqa: BLE001 - fall back to the engagement rule
        logger.exception("engagement.live_ended: attendance results unavailable for session %s", session.pk)
        return [], set(), []


@outbox_handler(EVENT_WATCH_AWARD, max_attempts=8)
def handle_watch_award(event):
    payload = event.payload or {}
    days = []
    for text in payload.get("days") or []:
        try:
            days.append(date.fromisoformat(str(text)))
        except ValueError:
            continue
    if days:
        services.award_watch_xp(int(payload.get("user_id")), days)


@outbox_handler(EVENT_FLUSH, max_attempts=3)
def handle_flush(event):
    stats = flush.flush_all()
    if stats["watch"]["batches"] or stats["live"]["batches"]:
        logger.info("engagement.flush %s", stats)


@outbox_handler(EVENT_REBUILD, max_attempts=3)
def handle_rebuild(event):
    stats = leaderboard.rebuild_all()
    logger.info("engagement.leaderboard_rebuild %s", stats)


# --- purchases (owner rules A) ---------------------------------------------------------------------
def _payment(payment_id):
    from apps.payments.models import Payment

    return Payment.objects.filter(pk=payment_id).first()


def _purchase_state(payment) -> tuple[int | None, int]:
    """(points awarded for the charge or None, XP already reversed) from the ledger."""
    awarded = XpEvent.objects.filter(idempotency_key=f"purchase:{sources._payment_ref(payment)}").values_list(
        "points", flat=True
    ).first()
    reversed_points = -sum(
        XpEvent.objects.filter(
            user_id=payment.user_id, kind=rules.KIND_PURCHASE_REFUND, source_type=sources.SOURCE_PAYMENT,
            source_id=str(payment.pk),
        ).values_list("points", flat=True)
    )
    return awarded, reversed_points


@outbox_handler(EVENT_PAYMENT_PAID, max_attempts=8)
def handle_payment_paid(event):
    if not services.is_enabled():
        return
    payment = _payment((event.payload or {}).get("payment_id"))
    if payment is None or payment.user_id is None:
        return
    if str(payment.status) == "refunded":
        # Refunded before we awarded it: nothing to give, nothing to take back.
        awarded, _reversed = _purchase_state(payment)
        if awarded is None:
            return
    item = sources.payment_item(payment)
    if item is not None:
        services.award(payment.user_id, item)
        # A refund handled before this award (out-of-order delivery) is applied now.
        _reverse_refund(payment)


def _reverse_refund(payment) -> None:
    awarded, reversed_points = _purchase_state(payment)
    if awarded is None:
        return  # never awarded: never reversed (no negative XP from a refund alone)
    item = sources.refund_item(payment, already_reversed=reversed_points)
    if item is not None:
        services.award(payment.user_id, item)


@outbox_handler(EVENT_PAYMENT_REFUNDED, max_attempts=8)
def handle_payment_refunded(event):
    if not services.is_enabled():
        return
    payment = _payment((event.payload or {}).get("payment_id"))
    if payment is None or payment.user_id is None:
        return
    _reverse_refund(payment)


@outbox_handler(EVENT_STANDINGS, max_attempts=3)
def handle_standings(event):
    from . import standings

    stats = standings.run_due()
    if stats.get("weeks") or stats.get("months"):
        logger.info("engagement.standings %s", stats)
