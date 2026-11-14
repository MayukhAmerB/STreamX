"""``ctf.scheduler``: the exam lifecycle without SSH or Django admin.

A periodic hook (``CtfConfig.ready``, every ``CTF_SCHEDULER_INTERVAL_SECONDS``)
runs a few cheap EXISTS queries and, only when something is due, publishes
one deduplicated ``ctf.scheduler.tick`` outbox event. Its handler runs
``run_scheduler``, whose steps are each idempotent:

1. **publish**: a scheduled draft (``auto_publish``) whose ``opens_at`` passed
   is published, after re-running the readiness checklist; a draft that is
   not ready stays a draft and staff are told once.
2. **opening soon**: ``CTF_OPENING_SOON_MINUTES`` before ``opens_at`` the
   eligible students are notified once (``opening_soon_notified_at``).
3. **close**: a published exam whose ``closes_at`` passed becomes closed.
4. **expire**: active participations whose deadline passed, or whose exam is
   closed, become ``expired`` (they used to stay active until the student
   loaded the exam again).
5. **finalize**: once a closed exam has no active student participation, one
   ``CtfExamResult`` per student is written (the unified gradebook entry,
   ``results_finalized_at`` marks it done).
6. **results**: each student is sent "Your score X/Y" once (``notified_at``).

Every state change is a compare-and-set UPDATE, every notification has a
stable event key, and the outbox events carry dedupe keys, so two workers or
a retried event never publish, notify or finalize twice.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.db.models import Count, F, Q, Sum
from django.utils import timezone

from apps.core.outbox import outbox_handler, publish

from .models import CtfExam, CtfExamResult, CtfParticipation, CtfQuestion
from .readiness import check_exam

logger = logging.getLogger("apps.ctf.scheduler")

EVENT_TICK = "ctf.scheduler.tick"
EVENT_NOTIFY_PUBLISHED = "ctf.notify_exam_published"
EVENT_NOTIFY_OPENING_SOON = "ctf.notify_exam_opening_soon"
EVENT_NOTIFY_RESULTS = "ctf.notify_exam_results"
# Results of exams that closed longer ago than this are written to the
# gradebook silently (e.g. old exams closed by the first scheduler run).
RESULT_NOTIFY_MAX_AGE = timedelta(hours=72)


def enabled():
    return bool(getattr(settings, "CTF_SCHEDULER_ENABLED", True))


def interval_seconds():
    return max(15, int(getattr(settings, "CTF_SCHEDULER_INTERVAL_SECONDS", 60) or 60))


def opening_soon_window():
    return timedelta(minutes=max(5, int(getattr(settings, "CTF_OPENING_SOON_MINUTES", 60) or 60)))


# ---------------------------------------------------------------------------
# What is due (cheap EXISTS queries)
# ---------------------------------------------------------------------------
def _due_to_publish(now):
    return CtfExam.objects.filter(status=CtfExam.STATUS_DRAFT, auto_publish=True, opens_at__lte=now)


def _due_opening_soon(now):
    return CtfExam.objects.filter(
        Q(status=CtfExam.STATUS_PUBLISHED) | Q(status=CtfExam.STATUS_DRAFT, auto_publish=True),
        opening_soon_notified_at__isnull=True,
        opens_at__gt=now,
        opens_at__lte=now + opening_soon_window(),
    )


def _due_publish_notice():
    # Only exams published by the Console or the scheduler (published_at is
    # set); exams published in Django admin before Phase 3 are not announced.
    return CtfExam.objects.filter(
        status=CtfExam.STATUS_PUBLISHED, published_at__isnull=False, publish_notified_at__isnull=True
    )


def _due_to_close(now):
    return CtfExam.objects.filter(status=CtfExam.STATUS_PUBLISHED, closes_at__lte=now)


def _due_to_expire(now):
    return CtfParticipation.objects.filter(status=CtfParticipation.STATUS_ACTIVE).filter(
        Q(deadline_at__lte=now) | Q(is_staff_preview=False, exam__status=CtfExam.STATUS_CLOSED)
    )


def _due_to_finalize():
    return CtfExam.objects.filter(status=CtfExam.STATUS_CLOSED, results_finalized_at__isnull=True)


def _due_result_notice():
    return CtfExam.objects.filter(results_finalized_at__isnull=False, results_notified_at__isnull=True)


def has_work(now=None):
    now = now or timezone.now()
    return any(
        queryset.exists()
        for queryset in (
            _due_to_publish(now),
            _due_opening_soon(now),
            _due_publish_notice(),
            _due_to_close(now),
            _due_to_expire(now),
            _due_to_finalize(),
            _due_result_notice(),
        )
    )


def schedule_tick(now=None):
    """Periodic hook: publish this interval's tick only when something is due."""
    if not enabled():
        return None
    now = now or timezone.now()
    if not has_work(now):
        return None
    bucket = int(now.timestamp()) // interval_seconds()
    return publish(EVENT_TICK, {"bucket": bucket}, dedupe_key=f"ctf-scheduler:{bucket}")


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------
def publish_due_exams(now):
    published = 0
    from .notify import notify_staff_not_ready

    for exam in _due_to_publish(now).order_by("opens_at", "id"):
        readiness = check_exam(exam, at=now)
        if not readiness.ready:
            if exam.closes_at and exam.closes_at <= now:
                # The whole window passed while it was not ready: stop trying.
                CtfExam.objects.filter(pk=exam.pk, auto_publish=True).update(auto_publish=False, updated_at=now)
                logger.error("ctf exam %s: window passed before it was ready; unscheduled", exam.slug)
                continue
            notification = notify_staff_not_ready(exam, readiness.reasons())
            if notification is not None and notification.created_at >= now - timedelta(seconds=5):
                logger.error("ctf exam %s not auto-published: %s", exam.slug, "; ".join(readiness.reasons()))
            continue
        with transaction.atomic():
            changed = CtfExam.objects.filter(
                pk=exam.pk, status=CtfExam.STATUS_DRAFT, auto_publish=True
            ).update(status=CtfExam.STATUS_PUBLISHED, auto_publish=False, published_at=now, updated_at=now)
            if changed:
                publish(EVENT_NOTIFY_PUBLISHED, {"exam_id": exam.pk}, dedupe_key=f"ctf-exam-published:{exam.pk}")
                published += 1
                logger.info("ctf exam %s published by the scheduler", exam.slug)
    return published


def queue_publish_notices():
    queued = 0
    for exam_id in _due_publish_notice().values_list("pk", flat=True):
        publish(EVENT_NOTIFY_PUBLISHED, {"exam_id": exam_id}, dedupe_key=f"ctf-exam-published:{exam_id}")
        queued += 1
    return queued


def queue_opening_soon(now):
    queued = 0
    for exam in _due_opening_soon(now):
        opens = int(exam.opens_at.timestamp())
        publish(
            EVENT_NOTIFY_OPENING_SOON,
            {"exam_id": exam.pk, "opens": opens},
            dedupe_key=f"ctf-exam-opening-soon:{exam.pk}:{opens}",
        )
        queued += 1
    return queued


def close_due_exams(now):
    closed = 0
    for exam_id, slug in _due_to_close(now).values_list("pk", "slug"):
        changed = CtfExam.objects.filter(pk=exam_id, status=CtfExam.STATUS_PUBLISHED, closes_at__lte=now).update(
            status=CtfExam.STATUS_CLOSED, closed_at=now, updated_at=now
        )
        if changed:
            closed += 1
            logger.info("ctf exam %s closed by the scheduler", slug)
    return closed


def expire_participations(now):
    expired = CtfParticipation.objects.filter(status=CtfParticipation.STATUS_ACTIVE, deadline_at__lte=now).update(
        status=CtfParticipation.STATUS_EXPIRED, updated_at=now
    )
    closed_exam_ids = list(CtfExam.objects.filter(status=CtfExam.STATUS_CLOSED).values_list("pk", flat=True))
    if closed_exam_ids:
        expired += CtfParticipation.objects.filter(
            status=CtfParticipation.STATUS_ACTIVE, is_staff_preview=False, exam_id__in=closed_exam_ids
        ).update(status=CtfParticipation.STATUS_EXPIRED, updated_at=now)
    return expired


def leaderboard(exam):
    """Students' participations in ranking order (staff previews excluded)."""
    return (
        CtfParticipation.objects.filter(exam=exam, is_staff_preview=False)
        .select_related("user", "batch_course")
        .order_by(F("score").desc(), F("last_correct_at").asc(nulls_last=True), "started_at", "id")
    )


def exam_totals(exam):
    totals = CtfQuestion.objects.filter(exam=exam, is_active=True).aggregate(count=Count("id"), points=Sum("points"))
    return int(totals["count"] or 0), int(totals["points"] or 0)


def finalize_exam_results(exam, now):
    """Write the gradebook entries of one closed exam. Returns rows created,
    or ``None`` when the exam is not ready to finalize (or already was)."""
    with transaction.atomic():
        locked = (
            CtfExam.objects.select_for_update()
            .filter(pk=exam.pk, status=CtfExam.STATUS_CLOSED, results_finalized_at__isnull=True)
            .first()
        )
        if locked is None:
            return None
        if CtfParticipation.objects.filter(
            exam=locked, status=CtfParticipation.STATUS_ACTIVE, is_staff_preview=False
        ).exists():
            return None
        question_count, total_points = exam_totals(locked)
        rows = []
        previous_key = None
        rank = 0
        for position, participation in enumerate(leaderboard(locked), 1):
            key = (participation.score, participation.last_correct_at)
            if key != previous_key:
                rank = position
                previous_key = key
            rows.append(
                CtfExamResult(
                    exam=locked,
                    user_id=participation.user_id,
                    participation=participation,
                    batch_course_id=participation.batch_course_id,
                    status=participation.status,
                    score=participation.score,
                    total_points=max(total_points, participation.score),
                    solved_count=participation.solved_count,
                    question_count=question_count,
                    rank=rank,
                    finalized_at=now,
                    student_roll_number=participation.student_roll_number,
                    student_name_snapshot=participation.student_name_snapshot,
                    student_handle_snapshot=participation.student_handle_snapshot,
                )
            )
        CtfExamResult.objects.bulk_create(rows, ignore_conflicts=True, batch_size=500)
        locked.results_finalized_at = now
        locked.save(update_fields=["results_finalized_at", "updated_at"])
        publish(EVENT_NOTIFY_RESULTS, {"exam_id": locked.pk}, dedupe_key=f"ctf-exam-results:{locked.pk}")
    logger.info("ctf exam %s: %d result(s) written to the gradebook", exam.slug, len(rows))
    return len(rows)


def finalize_due_results(now):
    finalized = 0
    for exam in _due_to_finalize():
        if finalize_exam_results(exam, now) is not None:
            finalized += 1
    return finalized


def queue_result_notices():
    queued = 0
    for exam_id in _due_result_notice().values_list("pk", flat=True):
        publish(EVENT_NOTIFY_RESULTS, {"exam_id": exam_id}, dedupe_key=f"ctf-exam-results:{exam_id}")
        queued += 1
    return queued


def run_scheduler(now=None):
    """One pass of every step. Safe to run any number of times."""
    now = now or timezone.now()
    stats = {
        "published": publish_due_exams(now),
        "opening_soon": queue_opening_soon(now),
        "publish_notices": queue_publish_notices(),
        "closed": close_due_exams(now),
        "expired": expire_participations(now),
        "finalized": finalize_due_results(now),
        "result_notices": queue_result_notices(),
    }
    return stats


# ---------------------------------------------------------------------------
# Notification delivery (idempotent markers + event keys)
# ---------------------------------------------------------------------------
def send_publish_notice(exam_id, now=None):
    from .notify import notify_exam_published

    now = now or timezone.now()
    exam = CtfExam.objects.filter(pk=exam_id).first()
    if exam is None or exam.publish_notified_at is not None:
        return False
    if exam.status == CtfExam.STATUS_PUBLISHED and exam.window(now) != CtfExam.WINDOW_CLOSED:
        notify_exam_published(exam)
    CtfExam.objects.filter(pk=exam.pk, publish_notified_at__isnull=True).update(publish_notified_at=now)
    return True


def send_opening_soon_notice(exam_id, now=None):
    from .notify import notify_exam_opening_soon

    now = now or timezone.now()
    exam = CtfExam.objects.filter(pk=exam_id).first()
    if exam is None or exam.opening_soon_notified_at is not None or not exam.opens_at:
        return False
    if exam.opens_at > now and exam.status in (CtfExam.STATUS_PUBLISHED, CtfExam.STATUS_DRAFT):
        if exam.status == CtfExam.STATUS_PUBLISHED or exam.auto_publish:
            notify_exam_opening_soon(exam)
    CtfExam.objects.filter(pk=exam.pk, opening_soon_notified_at__isnull=True).update(opening_soon_notified_at=now)
    return True


def send_result_notices(exam_id, now=None):
    from .notify import notify_result

    now = now or timezone.now()
    exam = CtfExam.objects.filter(pk=exam_id).first()
    if exam is None or exam.results_finalized_at is None or exam.results_notified_at is not None:
        return 0
    # When the exam actually ended: its closing time, or an earlier manual close.
    ended = [moment for moment in (exam.closes_at, exam.closed_at) if moment] or [exam.results_finalized_at]
    stale = min(ended) < now - RESULT_NOTIFY_MAX_AGE
    sent = 0
    last_id = 0
    while True:
        # Primary-key pages, not .iterator(): server-side cursors do not
        # survive PgBouncer transaction pooling.
        batch = list(
            CtfExamResult.objects.filter(exam=exam, notified_at__isnull=True, pk__gt=last_id).order_by("pk")[:200]
        )
        if not batch:
            break
        for result in batch:
            last_id = result.pk
            if not stale:
                notify_result(result, exam)
                sent += 1
            CtfExamResult.objects.filter(pk=result.pk, notified_at__isnull=True).update(notified_at=now)
    CtfExam.objects.filter(pk=exam.pk, results_notified_at__isnull=True).update(results_notified_at=now)
    return sent


@outbox_handler(EVENT_TICK, max_attempts=3)
def handle_tick(event):
    stats = run_scheduler()
    if any(stats.values()):
        logger.info("ctf scheduler: %s", stats)
    return stats


@outbox_handler(EVENT_NOTIFY_PUBLISHED, max_attempts=6)
def handle_notify_published(event):
    return send_publish_notice(event.payload.get("exam_id"))


@outbox_handler(EVENT_NOTIFY_OPENING_SOON, max_attempts=6)
def handle_notify_opening_soon(event):
    return send_opening_soon_notice(event.payload.get("exam_id"))


@outbox_handler(EVENT_NOTIFY_RESULTS, max_attempts=6)
def handle_notify_results(event):
    return send_result_notices(event.payload.get("exam_id"))
