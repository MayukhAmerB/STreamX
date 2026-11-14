"""Push signals for class recordings that need a human (or will soon).

Every alert is (1) an ``ERROR``/``WARNING`` log line ``CLASS_RECORDING_ALERT``
that log-based alerting (and Sentry) picks up, (2) a security-audit event, and
(3) an in-app notification to every active staff user, deduplicated by an
event key so the same problem is announced once. Prometheus alert rules use
the gauges in ``recording/metrics.py`` (see the Phase 2 deploy notes).

Alerting must never break the pipeline: every entry point swallows errors.
"""

import logging

from config.audit import log_security_event
from django.contrib.auth import get_user_model
from django.core.cache import cache

from . import config

logger = logging.getLogger("ops.realtime")

KIND_FAILED = "failed"
KIND_NEEDS_REVIEW = "needs_review"
KIND_STUCK_PROCESSING = "stuck_processing"
KIND_STUCK_FINALIZING = "stuck_finalizing"
KIND_RECORDER_STALE = "recorder_stale"
KIND_TRANSCODE_EXHAUSTED = "transcode_exhausted"
KIND_CANARY_FAILED = "canary_failed"

TITLES = {
    KIND_FAILED: "Class recording failed",
    KIND_NEEDS_REVIEW: "Class recording needs review",
    KIND_STUCK_PROCESSING: "Class recording stuck in processing",
    KIND_STUCK_FINALIZING: "Class recording stuck in finalizing",
    KIND_RECORDER_STALE: "Stream recorder is not running",
    KIND_TRANSCODE_EXHAUSTED: "HD stream could not be built",
    KIND_CANARY_FAILED: "Nightly recording check failed",
}
ERROR_KINDS = frozenset(
    {KIND_FAILED, KIND_STUCK_PROCESSING, KIND_STUCK_FINALIZING, KIND_RECORDER_STALE, KIND_TRANSCODE_EXHAUSTED,
     KIND_CANARY_FAILED}
)
ADMIN_RECORDINGS_PATH = "/admin/realtime/classrecording/"
ALERT_DEDUPE_SECONDS = 24 * 3600


def _staff_user_ids():
    return list(
        get_user_model().objects.filter(is_active=True, is_staff=True).values_list("pk", flat=True)[:200]
    )


def _notify_staff(*, kind, title, body, event_key):
    from apps.notifications.models import Notification
    from apps.notifications.services import create_notification

    return create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title=title,
        body=body,
        recipients=_staff_user_ids(),
        event_key=event_key,
        action_url=ADMIN_RECORDINGS_PATH,
    )


def raise_alert(kind, *, body, event_key, **context):
    """Log + audit + notify staff once per ``event_key``. Returns True if sent."""
    if not config.alerts_enabled():
        return False
    try:
        if not cache.add(f"recording:alert:{event_key}"[:200], 1, timeout=ALERT_DEDUPE_SECONDS):
            return False  # already announced
    except Exception:
        pass
    title = TITLES.get(kind, "Class recording alert")
    payload = {"kind": kind, "event_key": event_key, **context}
    (logger.error if kind in ERROR_KINDS else logger.warning)("CLASS_RECORDING_ALERT %s %s", payload, body[:500])
    try:
        log_security_event("realtime.class_recording_alert", **payload)
    except Exception:
        pass
    try:
        _notify_staff(kind=kind, title=title, body=body[:2000], event_key=f"class-recording-alert:{event_key}"[:220])
    except Exception:
        logger.exception("CLASS_RECORDING_ALERT_NOTIFY_FAILED kind=%s", kind)
        return False
    return True


def _describe(recording):
    session_title = getattr(getattr(recording, "session", None), "title", "") or "a class"
    return f'Recording #{recording.pk} of "{session_title}"'


def recording_failed(recording):
    return raise_alert(
        KIND_FAILED,
        body=f"{_describe(recording)} failed: {recording.error or 'unknown error'}. "
        f"It retries automatically up to {config.auto_retry_max()} times; open Class recordings to act now.",
        event_key=f"{recording.pk}:failed:{recording.attempts}",
        recording_id=recording.pk,
        session_id=recording.session_id,
    )


def recording_needs_review(recording):
    return raise_alert(
        KIND_NEEDS_REVIEW,
        body=f"{_describe(recording)} was published automatically. {recording.review_reason}".strip(),
        event_key=f"{recording.pk}:needs-review",
        recording_id=recording.pk,
        session_id=recording.session_id,
    )


def recording_stuck(recording, kind, age_seconds):
    hours = age_seconds / 3600
    return raise_alert(
        kind,
        body=f"{_describe(recording)} has been {recording.get_state_display().lower()} for {hours:.1f} h.",
        event_key=f"{recording.pk}:{kind}",
        recording_id=recording.pk,
        session_id=recording.session_id,
        age_seconds=int(age_seconds),
    )


def recorder_stale(recording, age_seconds):
    return raise_alert(
        KIND_RECORDER_STALE,
        body=f"{_describe(recording)} is live but the stream recorder has not reported for {int(age_seconds)} s. "
        "Check the stream-recorder container.",
        event_key=f"{recording.pk}:recorder-stale",
        recording_id=recording.pk,
        session_id=recording.session_id,
        age_seconds=int(age_seconds),
    )


def lecture_transcode_exhausted(lecture, message):
    return raise_alert(
        KIND_TRANSCODE_EXHAUSTED,
        body=f'The HD stream of lecture "{lecture.title}" (#{lecture.pk}) failed after every retry: '
        f"{str(message or '')[:300]}. Students still get the MP4. Use Retry on the recording to try again.",
        event_key=f"lecture-{lecture.pk}:transcode-exhausted:{lecture.stream_attempts}",
        lecture_id=lecture.pk,
    )


def canary_failed(detail, day_key):
    return raise_alert(
        KIND_CANARY_FAILED,
        body=f"verify_recording_pipeline failed on the server: {str(detail or '')[:500]}",
        event_key=f"canary:{day_key}",
    )
