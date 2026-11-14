"""Hooks on other apps' models: no code in those apps changes.

Every receiver is cheap and never raises into the caller:

* lecture progress -> watch seconds go to the Redis write-behind buffer
  (``HINCRBY``; nothing is written to the database per heartbeat); a
  completion publishes one deduplicated outbox event;
* report submission / grading / marks release, CTF results finalised and a
  live class ending each publish one deduplicated outbox event in the same
  transaction as the source change;
* an enrolment change re-pushes the student's scores to that batch board;
* a payment that is paid (each subscription charge, each one-time purchase)
  or refunded publishes one deduplicated outbox event (purchase XP and its
  pro-rata reversal; owner rules A).

The async worker (``outbox_handlers.py``) awards the XP.
"""

from __future__ import annotations

import contextvars
import logging
from datetime import datetime

from django.core.cache import cache
from django.db import transaction
from django.db.models.signals import post_init, post_save
from django.dispatch import receiver
from django.utils import timezone

from apps.core.outbox import publish

from . import buffer, rules
from .metrics import record_hook_failure

logger = logging.getLogger("apps.engagement.signals")

EVENT_LECTURE_COMPLETED = "engagement.lecture_completed"
EVENT_REPORT_SUBMITTED = "engagement.report_submitted"
EVENT_REPORT_GRADED = "engagement.report_graded"
EVENT_MARKS_RELEASED = "engagement.report_marks_released"
EVENT_EXAM_FINALIZED = "engagement.exam_finalized"
EVENT_LIVE_ENDED = "engagement.live_ended"
EVENT_FLUSH = "engagement.flush"
EVENT_WATCH_AWARD = "engagement.watch_award"
EVENT_REBUILD = "engagement.leaderboard_rebuild"
EVENT_PAYMENT_PAID = "engagement.payment_paid"
EVENT_PAYMENT_REFUNDED = "engagement.payment_refunded"
EVENT_STANDINGS = "engagement.standings_close"

MARKER_TTL_SECONDS = 24 * 3600

# Users whose request queued an XP-earning event: {user_id: estimated XP}.
# The middleware turns it into the ``X-Engagement`` response header.
pending_awards: contextvars.ContextVar[dict | None] = contextvars.ContextVar("engagement_pending", default=None)


def _note_pending(user_id: int, points: int) -> None:
    current = pending_awards.get()
    if current is None:
        return
    current[int(user_id)] = current.get(int(user_id), 0) + int(points)


def _enabled() -> bool:
    try:
        from .services import is_enabled

        return is_enabled()
    except Exception:  # noqa: BLE001
        return False


def _publish_once(marker: str, event_type: str, payload: dict, *, dedupe_key: str, delay_seconds: float = 0) -> bool:
    """Publish unless this process already did (cache marker set on commit).

    The insert runs in its own savepoint: a database error here rolls back
    only the outbox row, never the source action's transaction.
    """
    try:
        if cache.get(marker):
            return False
    except Exception:  # noqa: BLE001
        pass
    with transaction.atomic():
        publish(event_type, payload, dedupe_key=dedupe_key, delay_seconds=delay_seconds)

    def _mark():
        try:
            cache.set(marker, 1, timeout=MARKER_TTL_SECONDS)
        except Exception:  # noqa: BLE001
            pass

    transaction.on_commit(_mark)
    return True


def _safe(func):
    """Fail-safe hook: an engagement error is logged and counted, never raised
    into (or rolled back with) the lecture/report/exam/live action."""

    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception:  # noqa: BLE001 - engagement must never break the source action
            logger.exception("engagement.signal_failed receiver=%s", func.__name__)
            record_hook_failure(func.__name__)
            return None

    wrapper.__name__ = func.__name__
    return wrapper


# --- lecture progress -----------------------------------------------------------------
def _stash(instance) -> None:
    # Read __dict__ directly: a deferred field (``.only(...)``) must never
    # trigger a query from here.
    values = instance.__dict__
    instance._engagement_prev = (int(values.get("last_position_seconds") or 0), values.get("updated_at"))


@receiver(post_init, sender="courses.LectureProgress", dispatch_uid="engagement.progress_init")
def remember_progress(sender, instance, **kwargs):
    # Attribute assignment only: no I/O on model load.
    try:
        _stash(instance)
    except Exception:  # noqa: BLE001
        record_hook_failure("remember_progress")


def watch_credit(previous: tuple[int, datetime | None], position: int, now: datetime) -> int:
    """Seconds of watching credited for one progress update (anti-seek, anti-replay)."""
    previous_position, previous_at = previous
    delta = int(position or 0) - int(previous_position or 0)
    if delta <= 0 or previous_at is None:
        return 0
    elapsed = (now - previous_at).total_seconds()
    if elapsed <= 0:
        return 0
    return int(max(0, min(delta, elapsed + rules.WATCH_CREDIT_SLACK_SECONDS, rules.WATCH_MAX_CREDIT_PER_UPDATE_SECONDS)))


def lecture_watched_ratio(progress, lecture=None) -> float:
    # Fall back to the lecture's stream duration only when it is already loaded (no query).
    lecture = lecture or progress._state.fields_cache.get("lecture")
    duration = int(progress.duration_seconds or 0) or int(getattr(lecture, "stream_duration_seconds", 0) or 0)
    if duration <= 0:
        return 0.0
    watched = min(duration, int(progress.max_position_seconds or 0))
    return watched / duration


@receiver(post_save, sender="courses.LectureProgress", dispatch_uid="engagement.progress_saved")
@_safe
def lecture_progress_saved(sender, instance, created, **kwargs):
    if not _enabled():
        _stash(instance)
        return
    now = timezone.now()
    previous = getattr(instance, "_engagement_prev", (0, None))
    credit = watch_credit(previous, instance.last_position_seconds, now)
    if credit:
        buffer.incr("watch", f"{instance.user_id}:{instance.lecture_id}:{rules.ist_day(now).isoformat()}", credit)
    _stash(instance)
    if instance.completed and lecture_watched_ratio(instance) >= rules.LECTURE_MIN_WATCHED_RATIO:
        if _publish_once(
            f"eng:mk:lecture:{instance.user_id}:{instance.lecture_id}",
            EVENT_LECTURE_COMPLETED,
            {"user_id": instance.user_id, "lecture_id": instance.lecture_id},
            dedupe_key=f"eng-lecture:{instance.user_id}:{instance.lecture_id}",
        ):
            _note_pending(instance.user_id, rules.LECTURE_COMPLETED_XP)


# --- reports -------------------------------------------------------------------------------
@receiver(post_save, sender="reports.ReportSubmission", dispatch_uid="engagement.report_saved")
@_safe
def report_submission_saved(sender, instance, **kwargs):
    if not _enabled() or not instance.first_submitted_at:
        return
    if instance.status == "not_submitted":
        return
    if _publish_once(
        f"eng:mk:report-sub:{instance.pk}",
        EVENT_REPORT_SUBMITTED,
        {"submission_id": instance.pk},
        dedupe_key=f"eng-report-sub:{instance.pk}",
    ):
        _note_pending(instance.student_id, rules.REPORT_SUBMITTED_XP)
    if instance.status == "graded":
        _publish_once(
            f"eng:mk:report-grade:{instance.pk}",
            EVENT_REPORT_GRADED,
            {"submission_id": instance.pk},
            dedupe_key=f"eng-report-grade:{instance.pk}",
        )


@receiver(post_save, sender="reports.ReportTask", dispatch_uid="engagement.report_task_saved")
@_safe
def report_task_saved(sender, instance, update_fields=None, **kwargs):
    if not instance.marks_released_at or not _enabled():
        return
    if update_fields is not None and "marks_released_at" not in update_fields:
        return
    stamp = int(instance.marks_released_at.timestamp())
    _publish_once(
        f"eng:mk:release:{instance.pk}:{stamp}",
        EVENT_MARKS_RELEASED,
        {"task_id": instance.pk},
        dedupe_key=f"eng-report-release:{instance.pk}:{stamp}",
    )


# --- CTF exams ------------------------------------------------------------------------------
@receiver(post_save, sender="ctf.CtfExam", dispatch_uid="engagement.exam_saved")
@_safe
def exam_saved(sender, instance, update_fields=None, **kwargs):
    if not instance.results_finalized_at or not _enabled():
        return
    if update_fields is not None and "results_finalized_at" not in update_fields:
        return
    _publish_once(
        f"eng:mk:exam:{instance.pk}",
        EVENT_EXAM_FINALIZED,
        {"exam_id": instance.pk},
        dedupe_key=f"eng-exam:{instance.pk}",
    )


# --- live classes ------------------------------------------------------------------------------
@receiver(post_save, sender="realtime.RealtimeSession", dispatch_uid="engagement.live_saved")
@_safe
def live_session_saved(sender, instance, **kwargs):
    if instance.status != "ended" or not instance.started_at or not instance.ended_at or not _enabled():
        return
    _publish_once(
        f"eng:mk:live:{instance.pk}",
        EVENT_LIVE_ENDED,
        {"session_id": instance.pk},
        dedupe_key=f"eng-live-end:{instance.pk}",
        delay_seconds=rules.LIVE_FINALIZE_DELAY_SECONDS,
    )


# --- batch membership ------------------------------------------------------------------------------
@receiver(post_save, sender="courses.Enrollment", dispatch_uid="engagement.enrollment_saved")
@_safe
def enrollment_saved(sender, instance, **kwargs):
    user_id, course_id = instance.user_id, instance.course_id

    def _push():  # after commit: cannot affect the enrolment either way
        try:
            from . import leaderboard
            from .models import EngagementSummary

            if not EngagementSummary.objects.filter(user_id=user_id, total_xp__gt=0).exists():
                return
            if course_id in leaderboard.member_batch_ids(user_id):
                leaderboard.on_summary_changed(user_id, batch_ids=[course_id])
            else:
                leaderboard.remove_member(user_id, [course_id])
        except Exception:  # noqa: BLE001
            logger.warning("engagement.enrollment_push_failed", exc_info=True)

    transaction.on_commit(_push)


# --- purchases ------------------------------------------------------------------------------------
@receiver(post_save, sender="payments.Payment", dispatch_uid="engagement.payment_saved")
@_safe
def payment_saved(sender, instance, **kwargs):
    if instance.user_id is None or not _enabled():
        return
    status = str(instance.status or "")
    if status in ("paid", "refunded"):
        _publish_once(
            f"eng:mk:pay:{instance.pk}:{instance.user_id}",
            EVENT_PAYMENT_PAID,
            {"payment_id": instance.pk},
            dedupe_key=f"eng-pay:{instance.pk}:{instance.user_id}",
        )
    refunded = instance.amount_refunded or 0
    if status == "refunded" or refunded > 0:
        paise = int(round(float(instance.amount if status == "refunded" else refunded) * 100))
        _publish_once(
            f"eng:mk:refund:{instance.pk}:{paise}",
            EVENT_PAYMENT_REFUNDED,
            {"payment_id": instance.pk},
            dedupe_key=f"eng-refund:{instance.pk}:{paise}",
        )
