"""Session-level entry points used by the realtime views and the admin.

None of these functions touch ffmpeg: capture and finalization run in the
``run_stream_recorder`` process, which owns the files. The web tier only moves
rows through the state machine, so a recorder failure can never break the
live stream or the stop/end endpoints.
"""

import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.courses.cache_utils import bump_course_list_cache_version
from apps.courses.models import Lecture
from config.audit import log_security_event

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
    if recording.source == R.SOURCE_IMPORTED:
        # Without a module there is nothing to retry: "Publish to module" instead.
        return recording.module_id is not None
    return recording.source != R.SOURCE_OBS_UPLOAD


# --------------------------------------------------------------------------
# Admin operations (staff only; every one is logged as a security event)
# --------------------------------------------------------------------------


def recording_course_id(recording):
    """The course a recording belongs to (lecture, then module, then session)."""
    lecture = recording.lecture if recording.lecture_id else None
    if lecture is not None:
        return lecture.section.course_id
    if recording.module_id:
        return recording.module.course_id
    if recording.session_id:
        return recording.session.resolve_course_id()
    return None


def can_publish_to_module(recording):
    return (
        recording.source == R.SOURCE_IMPORTED
        and not recording.lecture_id
        and recording.state in (R.STATE_IMPORTED, R.STATE_FAILED)
    )


def publish_to_module(recording, module, *, request=None):
    """Imported recording -> FINALIZING into ``module``; the recorder creates the lecture."""
    if not can_publish_to_module(recording):
        raise ValidationError("Only an imported recording without a lecture can be published to a module.")
    if module is None:
        raise ValidationError("Choose a module.")
    updates = {"module": module}
    if recording.state == R.STATE_FAILED:
        updates["attempts"] = recording.attempts + 1
    if not state.transition(recording, R.STATE_FINALIZING, reason="import_assigned", request=request, **updates):
        raise ValidationError("The recording changed meanwhile; reload the page and try again.")
    return True


def set_lecture_published(recording, published, *, request=None):
    """Publish or unpublish the recording's lecture. Returns True if it changed."""
    lecture = Lecture.objects.filter(pk=recording.lecture_id).first() if recording.lecture_id else None
    if lecture is None:
        raise ValidationError("This recording has no lecture yet.")
    if published and (lecture.stream_status != Lecture.STREAM_READY or not lecture.stream_manifest_key):
        raise ValidationError(
            f"The lecture's video stream is not ready yet ({lecture.get_stream_status_display()}). "
            "It is published automatically as soon as it is."
        )
    if not published and recording.state in (R.STATE_FINALIZING, R.STATE_PROCESSING):
        raise ValidationError(
            "This recording is still being processed and would be published automatically when it is ready. "
            "Unpublish it once it shows Published."
        )
    if bool(lecture.is_published) == bool(published):
        return False
    lecture.is_published = bool(published)
    lecture.save(update_fields=["is_published", "updated_at"])
    bump_course_list_cache_version()
    log_security_event(
        "realtime.class_recording_lecture_published" if published else "realtime.class_recording_lecture_unpublished",
        request=request,
        recording_id=recording.pk,
        lecture_id=lecture.pk,
    )
    return True


def move_to_module(recording, module, *, request=None):
    """Move the recording (and its lecture) to another module of the same course."""
    if module is None:
        raise ValidationError("Choose a module.")
    if recording.state == R.STATE_FINALIZING:
        raise ValidationError("The recording is being finalized right now; try again in a moment.")
    course_id = recording_course_id(recording)
    if course_id and module.course_id != course_id:
        raise ValidationError("Pick a module of the same course.")
    with transaction.atomic():
        if recording.lecture_id:
            lecture = Lecture.objects.select_for_update().get(pk=recording.lecture_id)
            if lecture.section_id != module.pk:
                from .publisher import next_lecture_order

                lecture.section = module
                lecture.order = next_lecture_order(module)
                lecture.save(update_fields=["section", "order", "updated_at"])
            # Every recording of this lecture (OBS replacements included) follows it.
            R.objects.filter(lecture_id=lecture.pk).update(module=module, updated_at=timezone.now())
        else:
            R.objects.filter(pk=recording.pk).update(module=module, updated_at=timezone.now())
    recording.module = module
    bump_course_list_cache_version()
    log_security_event(
        "realtime.class_recording_moved",
        request=request,
        recording_id=recording.pk,
        lecture_id=recording.lecture_id,
        module_id=module.pk,
    )
    return True


@dataclass
class RecordingFile:
    kind: str  # "parts" | "source" | "lecture_video"
    label: str
    path: Path
    size: int
    exists: bool
    is_dir: bool = False


def _allowed_file_roots():
    from .importer import scan_roots

    roots = [Path(settings.MEDIA_ROOT)] + [root.path for root in scan_roots()]
    return [Path(str(root)).resolve() for root in roots]


def is_managed_path(path):
    """Inside MEDIA_ROOT, the LiveKit output root or the recorder work dir."""
    try:
        target = Path(path).resolve()
    except (OSError, RuntimeError):
        return False
    for root in _allowed_file_roots():
        if target == root:
            return False
        try:
            target.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def source_file_path(recording):
    """Absolute path of ``source_path`` (absolute, or relative to MEDIA_ROOT)."""
    if not recording.source_path:
        return None
    path = Path(recording.source_path)
    if not path.is_absolute():
        path = Path(settings.MEDIA_ROOT) / recording.source_path
    return path


def lecture_video_path(recording):
    lecture = recording.lecture if recording.lecture_id else None
    name = str(getattr(getattr(lecture, "video_file", None), "name", "") or "") if lecture else ""
    return Path(settings.MEDIA_ROOT) / name if name else None


def _size(path):
    try:
        if path.is_dir():
            return sum(item.stat().st_size for item in path.iterdir() if item.is_file() and not item.is_symlink())
        return path.stat().st_size
    except OSError:
        return 0


def recording_files(recording):
    """The files a recording owns on disk, for the admin delete confirmation."""
    files = []
    if recording.work_dir:
        path = Path(recording.work_dir)
        exists = path.is_dir() and not path.is_symlink()
        label = "Captured parts (original)" if recording.source == R.SOURCE_IMPORTED else "Captured parts"
        files.append(RecordingFile("parts", label, path, _size(path) if exists else 0, exists, is_dir=True))
    source = source_file_path(recording)
    if source is not None:
        exists = source.is_file() and not source.is_symlink()
        label = {
            R.SOURCE_IMPORTED: "Imported original file",
            R.SOURCE_OBS_UPLOAD: "Uploaded OBS file (waiting for conversion)",
            R.SOURCE_LIVEKIT_EGRESS: "Host Studio (LiveKit egress) original file",
        }.get(recording.source, "Source file")
        files.append(RecordingFile("source", label, source, _size(source) if exists else 0, exists))
    video = lecture_video_path(recording)
    if video is not None:
        exists = video.is_file() and not video.is_symlink()
        files.append(RecordingFile("lecture_video", "Lecture video (MP4 the stream is built from)", video,
                                   _size(video) if exists else 0, exists))
    return files


DELETABLE_KINDS = ("parts", "source", "lecture_video")
# Kinds the stream recorder deletes on the web tier's behalf (outside MEDIA_ROOT).
DEFERRABLE_KINDS = ("parts", "source")


def _writable_here(item):
    targets = [item.path.parent] + ([item.path] if item.is_dir else [])
    return all(os.access(target, os.W_OK) for target in targets)


@dataclass
class DeleteResult:
    deleted: list
    deferred: list

    @property
    def deleted_bytes(self):
        return sum(item.size for item in self.deleted)


def delete_recording_files(recording, *, kinds, confirm_published=False, request=None, allow_defer=True):
    """Delete the chosen files of a recording.

    Never while the recording is capturing or finalizing, never outside the
    recording folders, never through a symlink, and a *published* lecture's
    video only with ``confirm_published``. Files this process cannot write
    (the /recordings volume is mounted read-only in the web containers) are
    queued for the stream recorder when ``allow_defer``.
    """
    kinds = {kind for kind in (kinds or ()) if kind in DELETABLE_KINDS}
    if not kinds:
        raise ValidationError("Choose which files to delete.")
    if recording.state in R.ACTIVE_STATES:
        raise ValidationError("The recording is still recording or finalizing; its files cannot be deleted now.")
    lecture = Lecture.objects.filter(pk=recording.lecture_id).first() if recording.lecture_id else None
    if "lecture_video" in kinds and lecture is not None and lecture.is_published and not confirm_published:
        raise ValidationError(
            "The lecture is published. Tick the confirmation to delete its video: students keep the already "
            "built stream, but it can never be re-processed or downloaded again."
        )
    result = DeleteResult(deleted=[], deferred=[])
    for item in recording_files(recording):
        if item.kind not in kinds or not item.exists:
            continue
        if item.path.is_symlink() or not is_managed_path(item.path):
            raise ValidationError(f"Refusing to delete {item.path}: it is outside the recording folders.")
        if not _writable_here(item):
            if allow_defer and item.kind in DEFERRABLE_KINDS:
                result.deferred.append(item)
                continue
            raise ValidationError(f"{item.path} is read-only here and could not be deleted.")
        if item.is_dir:
            shutil.rmtree(item.path)
        else:
            item.path.unlink()
        result.deleted.append(item)
    now = timezone.now()
    updates = {}
    if result.deleted:
        updates.update(files_deleted_at=now, updated_at=now)
        if any(item.kind == "parts" for item in result.deleted):
            updates.update(part_count=0, captured_bytes=0)
    if result.deferred:
        pending = sorted({item.kind for item in result.deferred})
        updates.update(delete_requested_kinds=",".join(pending), delete_requested_at=now, updated_at=now)
    if updates:
        R.objects.filter(pk=recording.pk).update(**updates)
    if lecture is not None and any(item.kind == "lecture_video" for item in result.deleted):
        # update(), not save(): Lecture.save() would drop the built HLS stream
        # when its source changes, and students keep watching that stream.
        lecture_updates = {"video_file": "", "updated_at": now}
        if not lecture.stream_manifest_key:
            lecture_updates.update(stream_status=Lecture.STREAM_FAILED, stream_error="Video file deleted by an admin.")
        Lecture.objects.filter(pk=lecture.pk).update(**lecture_updates)
    if result.deleted or result.deferred:
        log_security_event(
            "realtime.class_recording_files_deleted",
            request=request,
            recording_id=recording.pk,
            lecture_id=recording.lecture_id,
            deleted=[str(item.path) for item in result.deleted],
            queued_for_recorder=[str(item.path) for item in result.deferred],
            bytes=result.deleted_bytes,
        )
        logger.warning(
            "CLASS_RECORDING_FILES_DELETED recording_id=%s deleted=%s queued=%s",
            recording.pk,
            [str(item.path) for item in result.deleted],
            [str(item.path) for item in result.deferred],
        )
    return result


PLAYABLE_SUFFIXES = frozenset({".mp4", ".m4v", ".mov", ".webm"})


def playable_file(recording):
    """(path, playable_in_browser) of the best single file for this recording, or (None, False)."""
    for path in (lecture_video_path(recording), source_file_path(recording)):
        if path is not None and path.is_file() and not path.is_symlink() and is_managed_path(path):
            return path, path.suffix.lower() in PLAYABLE_SUFFIXES
    return None, False

