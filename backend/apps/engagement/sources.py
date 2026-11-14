"""Turn source rows (lecture progress, reports, exam results, live attendance)
into XP items. Shared by the outbox handlers (live flow) and the backfill, so
both produce the same idempotency keys and amounts.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from . import rules
from .badges import AwardedItem
from .models import XpEvent


# --- lectures --------------------------------------------------------------------------------
def watched_ratio(progress) -> float:
    lecture = getattr(progress, "lecture", None)
    duration = int(progress.duration_seconds or 0) or int(getattr(lecture, "stream_duration_seconds", 0) or 0)
    if duration <= 0:
        return 0.0
    return min(duration, int(progress.max_position_seconds or 0)) / duration


def lecture_item(progress) -> AwardedItem | None:
    if not progress.completed or watched_ratio(progress) < rules.LECTURE_MIN_WATCHED_RATIO:
        return None
    return AwardedItem(
        kind=rules.KIND_LECTURE_COMPLETED,
        points=rules.lecture_xp(),
        key=f"lecture:{progress.user_id}:{progress.lecture_id}",
        source_type=XpEvent.SOURCE_LECTURE,
        source_id=str(progress.lecture_id),
        occurred_at=progress.completed_at or progress.updated_at,
    )


# --- reports ---------------------------------------------------------------------------------
def report_submitted_item(submission) -> AwardedItem | None:
    if not submission.first_submitted_at or submission.status == "not_submitted":
        return None
    task = submission.task
    on_time = bool(task.due_at and submission.first_submitted_at <= task.due_at)
    return AwardedItem(
        kind=rules.KIND_REPORT_SUBMITTED,
        points=rules.report_submitted_xp(on_time=on_time),
        key=f"report-submitted:{submission.student_id}:{task.pk}",
        source_type=XpEvent.SOURCE_REPORT_TASK,
        source_id=str(task.pk),
        occurred_at=submission.first_submitted_at,
        ctx={"on_time": on_time},
    )


def report_graded_item(submission) -> AwardedItem | None:
    task = submission.task
    if submission.status != "graded" or not task.marks_released:
        return None
    grade = getattr(submission, "grade", None)
    if grade is None or grade.final_marks is None or not task.max_marks:
        return None
    percent = float(Decimal(grade.final_marks) * 100 / Decimal(task.max_marks))
    visible_at = max(value for value in (grade.graded_at, task.marks_released_at, submission.updated_at) if value)
    return AwardedItem(
        kind=rules.KIND_REPORT_GRADED,
        points=rules.report_graded_xp(percent),
        key=f"report-graded:{submission.pk}",
        source_type=XpEvent.SOURCE_REPORT_SUBMISSION,
        source_id=str(submission.pk),
        occurred_at=visible_at,
        ctx={"percent": round(percent, 2)},
    )


# --- exams -------------------------------------------------------------------------------------
def exam_items(results, peer_ranks=None) -> list[tuple[int, AwardedItem]]:
    """``(user_id, item)`` for finalised ``CtfExamResult`` rows of one or more exams.

    ``peer_ranks`` maps ``(exam_id, batch_course_id)`` to every rank in that
    batch (the backfill passes it; by default the given rows are the peers).
    """
    results = list(results)
    by_batch = peer_ranks
    if by_batch is None:
        by_batch = defaultdict(list)
        for result in results:
            by_batch[(result.exam_id, result.batch_course_id)].append(int(result.rank or 0))
    items = []
    for result in results:
        if not result.total_points:
            continue
        percent = result.score * 100.0 / result.total_points
        batch_rank = 0
        if result.batch_course_id and result.rank:
            batch_rank = 1 + sum(1 for rank in by_batch.get((result.exam_id, result.batch_course_id), []) if 0 < rank < result.rank)
        participation = getattr(result, "participation", None)
        finished_at = getattr(participation, "submitted_at", None) or result.finalized_at
        items.append(
            (
                result.user_id,
                AwardedItem(
                    kind=rules.KIND_EXAM_FINISHED,
                    points=rules.exam_xp(percent),
                    key=f"exam:{result.user_id}:{result.exam_id}",
                    source_type=XpEvent.SOURCE_EXAM,
                    source_id=str(result.exam_id),
                    occurred_at=finished_at,
                    ctx={"percent": round(percent, 2), "batch_rank": batch_rank},
                ),
            )
        )
    return items


# --- live ------------------------------------------------------------------------------------------
def on_air_seconds(session) -> int:
    if not session.started_at or not session.ended_at:
        return 0
    return max(0, int((session.ended_at - session.started_at).total_seconds()))


def attended_live(seconds: int, on_air: int) -> bool:
    """The owner's attendance rule (apps.attendance): present = 40+ minutes live,
    or the short-session share of a class on air for less than that. Falls back
    to the old ratio only if the attendance app cannot be read."""
    try:
        from apps.attendance import policy as attendance_policy
        from apps.attendance.models import AttendancePolicy

        rule = attendance_policy.Rule.from_policy(AttendancePolicy.current())
        status, _threshold = attendance_policy.classify(
            seconds_present=seconds, joined=seconds > 0, on_air_seconds=on_air, rule=rule
        )
        return status == attendance_policy.PRESENT
    except Exception:  # noqa: BLE001
        return seconds >= on_air * rules.LIVE_MIN_ATTENDED_RATIO


def live_item(attendance, session) -> AwardedItem | None:
    """Legacy presence rows (students attendance never tracked), judged by the attendance rule."""
    on_air = on_air_seconds(session)
    if on_air <= 0 or not attended_live(int(attendance.seconds or 0), on_air):
        return None
    return AwardedItem(
        kind=rules.KIND_LIVE_ATTENDED,
        points=rules.live_present_xp(),
        key=f"live:{attendance.user_id}:{session.pk}",
        source_type=XpEvent.SOURCE_LIVE,
        source_id=str(session.pk),
        occurred_at=session.ended_at,
        ctx={"attended_ratio": round(min(attendance.seconds, on_air) / on_air, 3)},
    )


def live_item_present(record, session) -> AwardedItem:
    """Live XP for a student the attendance app marked present (same ledger key
    as ``live_item``, so a class is never paid twice)."""
    on_air = on_air_seconds(session)
    seconds = int(getattr(record, "seconds_present", 0) or 0)
    return AwardedItem(
        kind=rules.KIND_LIVE_ATTENDED,
        points=rules.live_present_xp(),
        key=f"live:{record.user_id}:{session.pk}",
        source_type=XpEvent.SOURCE_LIVE,
        source_id=str(session.pk),
        occurred_at=session.ended_at,
        ctx={"attended_ratio": round(seconds / on_air, 3) if on_air else 0, "source": "attendance"},
    )


def live_item_partial(record, session) -> AwardedItem:
    """Joined the live class but below the attendance bar (apps.attendance PARTIAL).

    Its own ledger key: a later staff override to "present" still pays the
    present XP (the partial XP stays; both are real records).
    """
    on_air = on_air_seconds(session)
    seconds = int(getattr(record, "seconds_present", 0) or 0)
    return AwardedItem(
        kind=rules.KIND_LIVE_PARTIAL,
        points=rules.live_partial_xp(),
        key=f"live-partial:{record.user_id}:{session.pk}",
        source_type=XpEvent.SOURCE_LIVE,
        source_id=str(session.pk),
        occurred_at=session.ended_at,
        ctx={"attended_ratio": round(seconds / on_air, 3) if on_air else 0, "source": "attendance"},
    )


def first_live_item(user_id: int, session) -> AwardedItem:
    """+100 once ever, with the first live class a student joins (present or partial)."""
    return AwardedItem(
        kind=rules.KIND_FIRST_LIVE_BONUS,
        points=rules.first_live_bonus_xp(),
        key=f"first-live:{user_id}",
        source_type=XpEvent.SOURCE_LIVE,
        source_id=str(session.pk),
        occurred_at=session.ended_at,
    )


# --- purchases ----------------------------------------------------------------------------------------
SOURCE_PAYMENT = "payment"
SUBSCRIPTION_PLAN = "platform_sub"


def _payment_ref(payment) -> str:
    """The idempotency anchor: the Razorpay payment id (one per charge), else our row id."""
    return str(payment.razorpay_payment_id or f"row{payment.pk}")[:60]


def payment_is_subscription(payment) -> bool:
    return str(payment.plan or "") == SUBSCRIPTION_PLAN


def payment_item(payment) -> AwardedItem | None:
    """XP for one successful charge (paid, or later refunded: the refund is a separate reversal)."""
    if payment.user_id is None or str(payment.status) not in ("paid", "refunded"):
        return None
    if str(payment.currency or "INR").upper() != "INR":
        return None
    subscription = payment_is_subscription(payment)
    points = rules.purchase_xp(payment.amount, subscription=subscription)
    if points <= 0:
        return None
    return AwardedItem(
        kind=rules.KIND_SUBSCRIPTION_CHARGE if subscription else rules.KIND_COURSE_PURCHASE,
        points=points,
        key=f"purchase:{_payment_ref(payment)}",
        source_type=SOURCE_PAYMENT,
        source_id=str(payment.pk),
        occurred_at=payment.paid_at or payment.created_at,
        ctx={"amount": str(payment.amount), "subscription": subscription},
    )


def refund_item(payment, *, already_reversed: int) -> AwardedItem | None:
    """The reversal still owed for ``payment``'s cumulative refund (pro rata, never more than awarded).

    ``already_reversed`` = the (positive) XP already taken back for it. The key
    carries the refunded amount in paise, so each new cumulative refund total
    reverses exactly the difference and a replay is a no-op.
    """
    awarded_item = payment_item(payment)
    if awarded_item is None:
        return None
    try:
        amount = Decimal(payment.amount or 0)
        refunded = min(Decimal(payment.amount_refunded or 0), amount)
    except Exception:  # noqa: BLE001
        return None
    if str(payment.status) == "refunded":
        refunded = amount
    if amount <= 0 or refunded <= 0:
        return None
    target = int(round(awarded_item.points * float(refunded / amount)))
    owed = target - int(already_reversed or 0)
    if owed <= 0:
        return None
    paise = int(refunded * 100)
    return AwardedItem(
        kind=rules.KIND_PURCHASE_REFUND,
        points=-owed,
        key=f"purchase-refund:{_payment_ref(payment)}:{paise}",
        source_type=SOURCE_PAYMENT,
        source_id=str(payment.pk),
        occurred_at=payment.refunded_at or payment.updated_at,
        ctx={"refunded": str(refunded)},
    )
