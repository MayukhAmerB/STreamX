"""``recording.reconcile``: the server owns every recording's lifecycle.

Runs in the async worker (``process_async_jobs``) every
RECORDING_RECONCILE_INTERVAL_SECONDS. The periodic hook is cheap (a few EXISTS
queries) and only publishes one deduplicated outbox event when there is work;
the handler then:

1. **Meetings** (RECORDING_AUTO_MEETINGS, OFF: meetings are never
   auto-recorded unless a deployment opts in): starts a LiveKit room-composite
   egress for every live meeting that has none, and stops it (then publishes
   the file) when the meeting ends. An egress that ended out of band (room
   closed, egress crashed) is completed and published too. No button exists.
2. **Completed egress / browser-fallback uploads** of the last
   RECORDING_RECONCILE_LOOKBACK_HOURS without a class recording join the
   finalize path (module derived, never failed for a missing module).
3. **Automatic retry** of failed recordings with backoff
   (RECORDING_AUTO_RETRY_MAX, RECORDING_AUTO_RETRY_BACKOFF_SECONDS).
4. **Alerts** (recording/alerts.py): failed, needs review, stuck in
   processing/finalizing, live class whose recorder stopped reporting.

The server recorder (Owncast captures, OBS and Host Studio) is driven by the
``stream-recorder`` process itself; this hook never touches its captures.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db.models import F, Q
from django.utils import timezone

from apps.core.concurrency import DistributedLock
from apps.core.outbox import outbox_handler, publish

from . import alerts, config
from . import services as recording_services
from .models import ClassRecording

logger = logging.getLogger("ops.realtime")
R = ClassRecording

EVENT_RECORDING_RECONCILE = "recording.reconcile"
LOCK_NAME = "recording.reconcile"
LOCK_SECONDS = 300
EGRESS_START_BACKOFF_SECONDS = 120
EGRESS_STATUS_MIN_AGE_SECONDS = 60
STOPPING_STALE_SECONDS = 600
BATCH = 25


def _models():
    from ..models import RealtimeSession, RealtimeSessionRecording

    return RealtimeSession, RealtimeSessionRecording


def _meetings_enabled():
    from ..services import is_livekit_configured

    return (
        config.auto_meetings()
        and bool(getattr(settings, "LIVEKIT_RECORDING_ENABLED", True))
        and is_livekit_configured()
    )


def _lookback_cutoff(now):
    return now - timedelta(seconds=config.reconcile_lookback_seconds())


def _completed_without_class_recording(now):
    _session_model, egress_model = _models()
    cutoff = _lookback_cutoff(now)
    return (
        egress_model.objects.filter(status=egress_model.STATUS_COMPLETED, class_recording__isnull=True)
        .filter(Q(ended_at__gte=cutoff) | Q(ended_at__isnull=True, updated_at__gte=cutoff))
        .filter((Q(video_file__isnull=False) & ~Q(video_file="")) | ~Q(output_file_path=""))
    )


def has_work(now=None):
    """Cheap EXISTS checks deciding whether the handler needs to run."""
    now = now or timezone.now()
    session_model, egress_model = _models()
    if egress_model.objects.filter(status__in=egress_model.ACTIVE_STATUSES).exists():
        return True
    if config.auto_meetings() and session_model.objects.filter(
        session_type=session_model.TYPE_MEETING, status=session_model.STATUS_LIVE
    ).exists():
        return True
    if _completed_without_class_recording(now).exists():
        return True
    if R.objects.filter(
        Q(state__in=(R.STATE_RECORDING, R.STATE_FINALIZING, R.STATE_PROCESSING))
        | Q(needs_review=True, alerted_at__isnull=True)
        | Q(state=R.STATE_FAILED, alerted_at__isnull=True)
        | Q(state=R.STATE_FAILED, alerted_at__lt=F("updated_at"))
    ).exists():
        return True
    # A failed recording is work only when an automatic retry is due; one that
    # is exhausted, waiting for its backoff, or cannot be auto-retried must not
    # publish a reconcile event every 30 s forever.
    return _auto_retry_due(now).exists()


def _transcode_exhausted_q():
    """Its lecture's HLS transcode used every attempt (the MP4 is published):
    only an explicit host/admin Retry may run it again (services.retry)."""
    from apps.courses.models import Lecture
    from apps.courses.transcode_queue import max_attempts

    return Q(lecture__stream_status=Lecture.STREAM_FAILED, lecture__stream_attempts__gte=max_attempts())


def _auto_retry_due(now):
    """Failed recordings an automatic retry may act on right now (scheduling a
    first retry time counts). ``auto_retry_failed`` and ``has_work`` share it so
    the hook never wakes the reconcile for rows the retry step would skip."""
    max_retries = config.auto_retry_max()
    if max_retries <= 0:
        return R.objects.none()
    return (
        R.objects.filter(state=R.STATE_FAILED, attempts__lt=max_retries)
        .filter(Q(next_retry_at__isnull=True) | Q(next_retry_at__lte=now))
        .exclude(_transcode_exhausted_q())
    )


def schedule_recording_reconcile(now=None):
    """Periodic hook: publish this interval's reconcile event when there is work."""
    now = now or timezone.now()
    if not has_work(now):
        return None
    interval = config.reconcile_interval_seconds()
    bucket = int(now.timestamp()) // interval
    return publish(EVENT_RECORDING_RECONCILE, {"bucket": bucket}, dedupe_key=f"recording-reconcile:{bucket}")


@outbox_handler(EVENT_RECORDING_RECONCILE, max_attempts=1)
def handle_recording_reconcile(event):
    return reconcile_recordings()


def reconcile_recordings(now=None):
    """One full pass (single-flight across workers). Returns a stats dict."""
    # Owner-token lock: a pass that outlives LOCK_SECONDS must not delete the
    # lock another worker took after it expired.
    lock = DistributedLock(LOCK_NAME, ttl=LOCK_SECONDS)
    try:
        acquired = lock.acquire(blocking=False)
    except Exception:
        lock = None
        acquired = True  # no cache: run anyway (each step is idempotent)
    if not acquired:
        return {"skipped": "locked"}
    now = now or timezone.now()
    stats = {}
    try:
        for name, step in (
            ("meetings", reconcile_meeting_egress),
            ("egress_published", publish_completed_recordings),
            ("retried", auto_retry_failed),
            ("alerts", raise_due_alerts),
        ):
            try:
                stats[name] = step(now)
            except Exception:  # one step must never block the others
                logger.exception("RECORDING_RECONCILE_STEP_FAILED step=%s", name)
                stats[name] = "error"
    finally:
        if lock is not None:
            try:
                lock.release()
            except Exception:
                pass
    if any(value not in (0, None, {}, "error") for value in stats.values()):
        logger.info("RECORDING_RECONCILE %s", stats)
    return stats


# --------------------------------------------------------------- meetings
def _egress_status(egress_id):
    from ..services import LiveKitConfigError, LiveKitEgressError, get_broadcast_egress_status

    try:
        return get_broadcast_egress_status(egress_id=egress_id)
    except (LiveKitConfigError, LiveKitEgressError) as exc:
        return {"running": None, "status": "UNKNOWN", "error": str(exc)}


def complete_and_publish(recording, *, reason, stop=True):
    """Stop (when asked) a LiveKit file egress, mark it completed and publish it."""
    from ..services import (
        LiveKitConfigError,
        LiveKitEgressError,
        extract_recording_output,
        stop_room_recording_egress,
    )

    payload = {}
    if stop and recording.livekit_egress_id:
        if recording.status != recording.STATUS_STOPPING:
            recording.mark_stopping()
        try:
            payload = stop_room_recording_egress(egress_id=recording.livekit_egress_id) or {}
        except (LiveKitConfigError, LiveKitEgressError) as exc:
            # Usually "already ended": the file is still there to publish.
            logger.warning(
                "RECORDING_RECONCILE_EGRESS_STOP_FAILED recording_id=%s egress_id=%s error=%s",
                recording.pk,
                recording.livekit_egress_id,
                exc,
            )
    resolved = extract_recording_output(stop_payload=payload, fallback_file_path=recording.output_file_path)
    recording.mark_completed(
        file_path=resolved.get("file_path", ""),
        file_url=resolved.get("download_url", ""),
        payload={"stop_response": payload, "completed_by": "recording.reconcile", "reason": reason},
    )
    class_recording = recording_services.enqueue_egress_publish(recording)
    logger.info(
        "RECORDING_RECONCILE_EGRESS_COMPLETED recording_id=%s session_id=%s reason=%s class_recording_id=%s",
        recording.pk,
        recording.session_id,
        reason,
        getattr(class_recording, "pk", None),
    )
    return class_recording


def start_meeting_egress(session):
    """Room-composite file egress for a live meeting (what the old button did)."""
    from ..services import (
        LiveKitConfigError,
        LiveKitEgressError,
        build_recording_filepath,
        start_room_recording_egress,
    )

    _session_model, egress_model = _models()
    backoff_key = f"recording:reconcile:egress-start:{session.pk}"
    try:
        if not cache.add(backoff_key, 1, timeout=EGRESS_START_BACKOFF_SECONDS):
            return None
    except Exception:
        pass
    room_name = session.livekit_room_name or session.room_name
    output_file_path = build_recording_filepath(room_name=room_name, session_type=session.session_type)
    recording = egress_model.objects.create(
        session=session,
        recording_type=session.session_type,
        started_by=None,
        status=egress_model.STATUS_STARTING,
        output_file_path=output_file_path,
        started_at=timezone.now(),
        livekit_payload={"source": "auto_meeting_egress"},
    )
    try:
        result = start_room_recording_egress(
            room_name=room_name, output_file_path=output_file_path, layout=settings.LIVEKIT_EGRESS_LAYOUT
        )
    except (LiveKitConfigError, LiveKitEgressError) as exc:
        recording.mark_failed(str(exc), payload={"start_error": str(exc), "source": "auto_meeting_egress"})
        logger.warning("RECORDING_RECONCILE_MEETING_EGRESS_FAILED session_id=%s error=%s", session.pk, exc)
        return None
    recording.mark_recording(egress_id=result.get("egress_id", ""), payload={"start_response": result.get("response")})
    logger.info(
        "RECORDING_RECONCILE_MEETING_EGRESS_STARTED session_id=%s recording_id=%s egress_id=%s",
        session.pk,
        recording.pk,
        recording.livekit_egress_id,
    )
    return recording


def reconcile_meeting_egress(now):
    session_model, egress_model = _models()
    stats = {"started": 0, "completed": 0}
    meetings_on = _meetings_enabled()
    active = list(
        egress_model.objects.filter(status__in=egress_model.ACTIVE_STATUSES)
        .exclude(livekit_egress_id="")
        .select_related("session")
        .order_by("pk")[:BATCH]
    )
    for recording in active:
        session = recording.session
        if session.status == session_model.STATUS_ENDED:
            complete_and_publish(recording, reason="session_ended")
            stats["completed"] += 1
            continue
        age = (now - (recording.updated_at or recording.created_at)).total_seconds()
        if age < EGRESS_STATUS_MIN_AGE_SECONDS or not meetings_on:
            continue
        status = _egress_status(recording.livekit_egress_id)
        if status.get("running") is False:
            complete_and_publish(recording, reason=str(status.get("status") or "egress_ended").lower(), stop=False)
            stats["completed"] += 1
        elif recording.status == recording.STATUS_STOPPING and age > STOPPING_STALE_SECONDS:
            complete_and_publish(recording, reason="stopping_timeout")
            stats["completed"] += 1
    if not meetings_on:
        return stats
    live_meetings = session_model.objects.filter(
        session_type=session_model.TYPE_MEETING, status=session_model.STATUS_LIVE
    ).order_by("pk")[:BATCH]
    for session in live_meetings:
        if egress_model.objects.filter(session=session, status__in=egress_model.ACTIVE_STATUSES).exists():
            continue
        if start_meeting_egress(session) is not None:
            stats["started"] += 1
    return stats


# ------------------------------------------------------ finished uploads
def publish_completed_recordings(now):
    """Completed egress / browser uploads without a class recording -> finalize."""
    published = 0
    for recording in _completed_without_class_recording(now).select_related("session").order_by("pk")[:BATCH]:
        session = recording.session
        if (
            session.session_type == session.TYPE_BROADCASTING
            and R.objects.filter(session=session, source=R.SOURCE_SERVER).exclude(state=R.STATE_FAILED).exists()
        ):
            continue  # the server recorder already has this class; the file stays for the admin scan
        if recording.video_file:
            created = recording_services.enqueue_browser_fallback_publish(recording)
        else:
            created = recording_services.enqueue_egress_publish(recording)
        if created is not None:
            published += 1
    return published


# ------------------------------------------------------------- retries
def _nothing_captured(recording):
    if recording.source != R.SOURCE_SERVER or recording.lecture_id:
        return False
    if recording.part_count or recording.captured_bytes:
        return False
    from .recorder import list_parts  # the worker mounts /recordings read-only

    try:
        return not list_parts(recording.work_dir)
    except OSError:
        return False


def _defer_recheck(recording, now, schedule):
    """Not auto-retryable now (no captured video, nothing to resume from, or
    lost a race): look again only after the longest backoff, so the row
    neither wakes the reconcile every interval nor starves the batch."""
    R.objects.filter(pk=recording.pk, state=R.STATE_FAILED).update(
        next_retry_at=now + timedelta(seconds=max(schedule))
    )


def auto_retry_failed(now):
    if config.auto_retry_max() <= 0:
        return 0
    schedule = config.auto_retry_backoff_seconds()
    retried = 0
    rows = _auto_retry_due(now).select_related("session", "lecture", "module").order_by("pk")[:BATCH]
    for recording in rows:
        if not recording_services.can_retry(recording) or _nothing_captured(recording):
            # e.g. a class that never streamed: retrying cannot help (alerted once)
            _defer_recheck(recording, now, schedule)
            continue
        if recording.next_retry_at is None:
            wait = schedule[min(recording.attempts, len(schedule) - 1)]
            R.objects.filter(pk=recording.pk, state=R.STATE_FAILED, next_retry_at__isnull=True).update(
                next_retry_at=now + timedelta(seconds=wait)
            )
            continue
        if recording.next_retry_at > now:
            continue
        if recording_services.retry(recording, automatic=True):
            retried += 1
            logger.info("CLASS_RECORDING_AUTO_RETRY recording_id=%s attempt=%s", recording.pk, recording.attempts)
        else:
            _defer_recheck(recording, now, schedule)
    return retried


# --------------------------------------------------------------- alerts
def raise_due_alerts(now):
    sent = 0
    failed = R.objects.filter(state=R.STATE_FAILED).filter(
        Q(alerted_at__isnull=True) | Q(alerted_at__lt=F("updated_at"))
    ).select_related("session")[:BATCH]
    for recording in failed:
        alerts.recording_failed(recording)
        R.objects.filter(pk=recording.pk).update(alerted_at=now)
        sent += 1
    review = R.objects.filter(needs_review=True, alerted_at__isnull=True).exclude(state=R.STATE_FAILED).select_related(
        "session"
    )[:BATCH]
    for recording in review:
        if recording.lecture_id is None:
            continue  # alert once it is actually published
        alerts.recording_needs_review(recording)
        R.objects.filter(pk=recording.pk).update(alerted_at=now)
        sent += 1
    processing_cutoff = now - timedelta(seconds=config.processing_alert_seconds())
    for recording in R.objects.filter(state=R.STATE_PROCESSING, updated_at__lt=processing_cutoff).select_related(
        "session"
    )[:BATCH]:
        if alerts.recording_stuck(recording, alerts.KIND_STUCK_PROCESSING, (now - recording.updated_at).total_seconds()):
            sent += 1
    finalizing_cutoff = now - timedelta(seconds=config.finalizing_alert_seconds())
    for recording in R.objects.filter(state=R.STATE_FINALIZING, updated_at__lt=finalizing_cutoff).select_related(
        "session"
    )[:BATCH]:
        if alerts.recording_stuck(recording, alerts.KIND_STUCK_FINALIZING, (now - recording.updated_at).total_seconds()):
            sent += 1
    stale_cutoff = now - timedelta(seconds=config.heartbeat_alert_seconds())
    stale = (
        R.objects.filter(source=R.SOURCE_SERVER, state=R.STATE_RECORDING, created_at__lt=stale_cutoff)
        .filter(Q(recorder_heartbeat_at__isnull=True) | Q(recorder_heartbeat_at__lt=stale_cutoff))
        .exclude(session__status="ended")
        .select_related("session")[:BATCH]
    )
    for recording in stale:
        reference = recording.recorder_heartbeat_at or recording.created_at
        if alerts.recorder_stale(recording, (now - reference).total_seconds()):
            sent += 1
    return sent
