"""Session-level entry points used by the realtime views and the admin.

None of these functions touch ffmpeg: capture and finalization run in the
``run_stream_recorder`` process, which owns the files. The web tier only moves
rows through the state machine, so a recorder failure can never break the
live stream or the stop/end endpoints.
"""

import logging

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.courses.models import Lecture

from . import config, state
from .models import ClassRecording

logger = logging.getLogger("ops.realtime")
R = ClassRecording


def is_obs_broadcast(session):
    return (
        session.session_type == session.TYPE_BROADCASTING
        and session.stream_service == session.STREAM_SERVICE_OBS
    )


def capturing_server_recording(session):
    return R.objects.filter(session=session, source=R.SOURCE_SERVER, state=R.STATE_RECORDING).first()


def ensure_server_recording(session, *, user=None, request=None):
    """Start (or return the already running) server recording for an OBS session.

    Owncast carries one feed at a time, so any capture still attached to a
    different session is asked to finalize first.
    """
    if not config.recorder_enabled() or not is_obs_broadcast(session):
        return None
    existing = capturing_server_recording(session)
    if existing is not None:
        return existing
    # A previous take of this session may still be finalizing; this starts a new take.
    for other in R.objects.filter(source=R.SOURCE_SERVER, state=R.STATE_RECORDING).exclude(session=session):
        state.transition(
            other,
            R.STATE_FINALIZING,
            reason="superseded_by_new_session",
            request=request,
            stop_requested_at=timezone.now(),
        )
    try:
        with transaction.atomic():
            recording = R.objects.create(
                session=session,
                module=session.target_module,
                started_by=user if getattr(user, "is_authenticated", False) else None,
                source=R.SOURCE_SERVER,
                state=R.STATE_RECORDING,
                started_at=timezone.now(),
            )
            recording.work_dir = str(config.work_root() / f"class-recording-{recording.pk}")
            recording.save(update_fields=["work_dir", "updated_at"])
    except IntegrityError:
        # A concurrent start already created the capturing recording.
        return capturing_server_recording(session)
    state.log_transition(recording, "", R.STATE_RECORDING, reason="stream_started", request=request)
    return recording


def request_finalize(session, *, reason, request=None):
    """Stop capturing and queue finalization. Idempotent (repeat calls no-op)."""
    recording = R.objects.filter(session=session, source=R.SOURCE_SERVER, state=R.STATE_RECORDING).first()
    if recording is None:
        return None
    state.transition(
        recording,
        R.STATE_FINALIZING,
        reason=reason,
        request=request,
        stop_requested_at=timezone.now(),
    )
    return recording


NO_MODULE_SELECTED_ERROR = "No module selected for this class — choose a module and retry."


def enqueue_egress_publish(livekit_recording, *, request=None):
    """Publish a completed Host Studio (LiveKit egress) recording into the module.

    Without a target module the recording is still recorded -- as a visible,
    retryable failure -- so the class video never vanishes silently: set the
    session's module (PATCH /api/realtime/sessions/<id>/) and retry.
    """
    session = livekit_recording.session
    if not livekit_recording.output_file_path:
        return None
    has_module = bool(session.target_module_id)
    initial_state = R.STATE_FINALIZING if has_module else R.STATE_FAILED
    try:
        with transaction.atomic():
            recording, created = R.objects.get_or_create(
                livekit_recording=livekit_recording,
                defaults={
                    "session": session,
                    "module": session.target_module if has_module else None,
                    "started_by": livekit_recording.started_by,
                    "source": R.SOURCE_LIVEKIT_EGRESS,
                    "state": initial_state,
                    "error": "" if has_module else NO_MODULE_SELECTED_ERROR,
                    "source_path": livekit_recording.output_file_path,
                    "started_at": livekit_recording.started_at,
                    "stop_requested_at": timezone.now(),
                },
            )
    except IntegrityError:
        return R.objects.filter(livekit_recording=livekit_recording).first()
    if created:
        state.log_transition(
            recording,
            "",
            initial_state,
            reason="egress_completed" if has_module else "egress_completed_without_module",
            request=request,
        )
    return recording


def is_pending_obs_remux(recording):
    """An OBS upload (MKV/FLV/TS) still waiting to be remuxed and swapped in."""
    return recording.source == R.SOURCE_OBS_UPLOAD and bool(recording.source_path)


def retry(recording, *, request=None):
    """Re-run a failed recording from where it can resume. Returns True if queued."""
    if not can_retry(recording):
        return False
    if is_pending_obs_remux(recording):
        # The staged OBS file is still on disk: convert and swap it again.
        return state.transition(
            recording, R.STATE_FINALIZING, reason="retry", request=request, attempts=recording.attempts + 1
        )
    if recording.lecture_id:
        lecture = Lecture.objects.filter(pk=recording.lecture_id).first()
        if lecture is None:
            return False
        if lecture.stream_status == Lecture.STREAM_FAILED:
            lecture.stream_status = Lecture.STREAM_UPLOADED
            lecture.stream_error = ""
            lecture.save(update_fields=["stream_status", "stream_error", "updated_at"])
        return state.transition(
            recording, R.STATE_PROCESSING, reason="retry", request=request, attempts=recording.attempts + 1
        )
    updates = {"attempts": recording.attempts + 1}
    if recording.module_id is None and recording.session_id and recording.session.target_module_id:
        updates["module_id"] = recording.session.target_module_id
    return state.transition(recording, R.STATE_FINALIZING, reason="retry", request=request, **updates)


def can_retry(recording):
    if recording.state != R.STATE_FAILED:
        return False
    if recording.lecture_id or is_pending_obs_remux(recording):
        return True
    return recording.source != R.SOURCE_OBS_UPLOAD
