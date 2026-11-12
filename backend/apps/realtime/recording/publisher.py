"""Turn a finished class recording into a lecture of the tagged module."""

import logging
import os
import shutil
from pathlib import Path

from django.conf import settings
from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import Max
from django.utils import timezone
from django.utils.text import slugify

from apps.courses.cache_utils import bump_course_list_cache_version
from apps.courses.models import Lecture

from . import config, ffmpeg, state
from .models import ClassRecording


GIB = 1024 * 1024 * 1024
logger = logging.getLogger("ops.realtime")


class RecordingPublishError(Exception):
    pass


NO_MODULE_ERROR = (
    "No target module is tagged for this session. Set the session's target module "
    "(admin or PATCH /api/realtime/sessions/<id>/) and retry the recording."
)


def lecture_title_for(session, when=None):
    when = timezone.localtime(when or getattr(session, "started_at", None) or timezone.now())
    base = (getattr(session, "title", "") or "Live class").strip()
    return f"{base} - {when:%d %b %Y}"[:255]


def resolve_module(recording):
    """The recording's module, falling back to the session's current tag."""
    module = recording.module
    if module is None and recording.session_id:
        module = getattr(recording.session, "target_module", None)
    if module is None:
        return None
    course_id = recording.session.resolve_course_id() if recording.session_id else module.course_id
    if course_id and module.course_id != course_id:
        raise RecordingPublishError("The tagged module does not belong to the session's course.")
    return module


def storage_name_for(recording, module, suffix=".mp4"):
    # Keep the stored name well under Lecture.video_file's max_length: the slug
    # is capped so long course names can't push the path past the column size.
    course_slug = (slugify(getattr(module.course, "slug", "") or "course") or "course")[:48].strip("-") or "course"
    stamp = timezone.localtime(recording.started_at or recording.created_at or timezone.now()).strftime("%Y%m%d-%H%M%S")
    return f"lecture_videos/{course_slug}/module_{module.pk}/rec-{recording.pk}-{stamp}{suffix}"


def next_lecture_order(module):
    current = Lecture.objects.filter(section=module).aggregate(top=Max("order"))["top"]
    return int(current or 0) + 1


def create_lecture(recording, module, *, storage_name, title=None):
    """Create (once) the unpublished lecture for ``recording``. Idempotent."""
    with transaction.atomic():
        locked = ClassRecording.objects.select_for_update().get(pk=recording.pk)
        if locked.lecture_id:
            recording.lecture_id = locked.lecture_id
            return locked.lecture
        title = title or lecture_title_for(recording.session, recording.started_at)
        earlier_takes = (
            ClassRecording.objects.filter(session_id=recording.session_id, lecture__isnull=False)
            .exclude(pk=recording.pk)
            .exclude(source=ClassRecording.SOURCE_OBS_UPLOAD)
            .count()
            if recording.session_id
            else 0
        )
        if earlier_takes:
            title = f"{title} (part {earlier_takes + 1})"[:255]
        lecture = Lecture(
            section=module,
            title=title,
            description=module.description or "",
            order=next_lecture_order(module),
            is_published=False,
        )
        lecture.video_file.name = storage_name
        lecture.save()
        ClassRecording.objects.filter(pk=recording.pk).update(
            lecture=lecture, module=module, updated_at=timezone.now()
        )
    recording.lecture = lecture
    recording.module = module
    return lecture


def free_disk_bytes(path):
    probe = Path(path)
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return None


def _format_bytes(value):
    return f"{value / GIB:.1f} GiB"


def ensure_media_disk_space(input_bytes, *, action):
    """Refuse to start a finalize that would fill the media disk.

    Needs ``input_bytes x STREAM_RECORDER_FINALIZE_SPACE_FACTOR`` (the stream
    copy output plus the HLS transcode that follows) on top of the
    STREAM_RECORDER_MIN_FREE_BYTES reserve. The recording fails with a
    retryable error and its inputs are kept.
    """
    input_bytes = max(0, int(input_bytes or 0))
    factor = config.finalize_space_factor()
    reserve = config.min_free_bytes()
    required = int(input_bytes * factor) + reserve
    free = free_disk_bytes(settings.MEDIA_ROOT)
    if free is None or free >= required:
        return
    raise RecordingPublishError(
        f"Not enough free disk space to {action}: it needs {_format_bytes(required)} free on the media disk "
        f"({_format_bytes(input_bytes)} of video x {factor:g} + {_format_bytes(reserve)} reserve), but only "
        f"{_format_bytes(free)} is free. Free up space, then retry. The captured video is kept."
    )


def finalize_into_lecture(recording, inputs, *, list_path):
    """Concat ``inputs`` into the module's media folder and create the lecture.

    Safe to call again after a crash: an existing lecture is reused and the
    deterministic output path is simply overwritten.
    """
    if recording.lecture_id:
        state.transition(recording, ClassRecording.STATE_PROCESSING, reason="lecture_already_created")
        return recording.lecture
    module = resolve_module(recording)
    if module is None:
        raise RecordingPublishError(NO_MODULE_ERROR)
    ensure_media_disk_space(sum(Path(item).stat().st_size for item in inputs), action="finalize the recording")
    storage_name = storage_name_for(recording, module)
    output_path = Path(settings.MEDIA_ROOT) / storage_name
    try:
        ffmpeg.concat_to_mp4(inputs, output_path, list_path=list_path)
    except ffmpeg.FFmpegError as exc:
        raise RecordingPublishError(str(exc)) from exc
    lecture = create_lecture(recording, module, storage_name=storage_name)
    state.transition(
        recording,
        ClassRecording.STATE_PROCESSING,
        reason="lecture_created",
        file_size_bytes=output_path.stat().st_size,
        duration_seconds=ffmpeg.probe_duration_seconds(output_path),
        finalized_at=timezone.now(),
    )
    return lecture


def publish_if_ready(recording):
    """PROCESSING -> PUBLISHED once the lecture's HLS stream is ready."""
    lecture = Lecture.objects.filter(pk=recording.lecture_id).first() if recording.lecture_id else None
    if lecture is None:
        return state.transition(
            recording,
            ClassRecording.STATE_FAILED,
            error="The lecture for this recording no longer exists.",
            reason="lecture_missing",
        )
    if lecture.stream_status == Lecture.STREAM_FAILED:
        return state.transition(
            recording,
            ClassRecording.STATE_FAILED,
            error=f"HLS transcode failed: {lecture.stream_error or 'unknown error'}",
            reason="transcode_failed",
        )
    if lecture.stream_status != Lecture.STREAM_READY or not lecture.stream_manifest_key:
        return False
    if not state.transition(
        recording,
        ClassRecording.STATE_PUBLISHED,
        reason="hls_ready",
        published_at=timezone.now(),
        duration_seconds=recording.duration_seconds or lecture.stream_duration_seconds,
    ):
        return False
    if not lecture.is_published:
        lecture.is_published = True
        lecture.save(update_fields=["is_published", "updated_at"])
        bump_course_list_cache_version()
    return True


def staged_upload_path(recording):
    """Absolute path of an OBS upload waiting for its remux (under MEDIA_ROOT)."""
    return Path(default_storage.path(recording.source_path))


def _delete_storage_file_on_commit(name):
    def _delete():
        try:
            default_storage.delete(name)
        except Exception:
            pass

    transaction.on_commit(_delete)


def finalize_obs_upload(recording):
    """Remux a staged OBS MKV/FLV/TS upload to MP4 and swap it into the lecture.

    FINALIZING -> PROCESSING. Runs in the recorder (never on a web worker). The
    lecture keeps its id, likes, comments and views; a replaced published
    lecture does not notify students again. Safe to run again after a crash:
    the swap and the state change commit together, and the staged file is only
    deleted after that commit.
    """
    staged = staged_upload_path(recording)
    if not staged.is_file():
        raise RecordingPublishError("The uploaded OBS file is no longer on the server. Upload it again.")
    if recording.lecture_id:
        module = Lecture.objects.select_related("section__course").get(pk=recording.lecture_id).section
    else:
        module = resolve_module(recording)
    if module is None:
        raise RecordingPublishError(NO_MODULE_ERROR)
    ensure_media_disk_space(staged.stat().st_size, action="convert the OBS recording")
    storage_name = storage_name_for(recording, module)
    output_path = Path(settings.MEDIA_ROOT) / storage_name
    container = staged.suffix.lstrip(".").upper() or "upload"
    try:
        ffmpeg.remux_to_mp4(staged, output_path)
    except ffmpeg.FFmpegError as exc:
        raise RecordingPublishError(
            f"Could not convert the OBS {container} recording to MP4: {exc} Retry, or remux it in OBS "
            "(File > Remux Recordings) and upload the MP4."
        ) from exc
    staged_name = recording.source_path
    with transaction.atomic():
        locked = ClassRecording.objects.select_for_update().get(pk=recording.pk)
        if locked.state != ClassRecording.STATE_FINALIZING or locked.source_path != staged_name:
            # Retried or replaced while ffmpeg ran: this output is not used.
            output_path.unlink(missing_ok=True)
            return None
        if locked.lecture_id:
            lecture = Lecture.objects.select_for_update().get(pk=locked.lecture_id)
            old_name = str(lecture.video_file.name or "")
            lecture.video_file.name = storage_name
            lecture.stream_status = Lecture.STREAM_UPLOADED
            # Students were already told about this lecture; a better file for
            # the same class is not a new video.
            lecture._suppress_upload_notification = True
            lecture.save()
            if old_name and old_name != storage_name:
                _delete_storage_file_on_commit(old_name)
        else:
            lecture = Lecture(
                section=module,
                title=lecture_title_for(recording.session, recording.started_at),
                description=module.description or "",
                order=next_lecture_order(module),
                is_published=False,
            )
            lecture.video_file.name = storage_name
            lecture.save()
        ClassRecording.objects.filter(pk=recording.pk).update(
            lecture=lecture, module=lecture.section, source_path="", updated_at=timezone.now()
        )
        recording.lecture = lecture
        recording.module = lecture.section
        recording.source_path = ""
        state.transition(
            recording,
            ClassRecording.STATE_PROCESSING,
            reason="obs_upload_remuxed",
            file_size_bytes=output_path.stat().st_size,
            duration_seconds=ffmpeg.probe_duration_seconds(output_path),
            finalized_at=timezone.now(),
        )
        _delete_storage_file_on_commit(staged_name)
    return lecture


# --------------------------------------------------------------------------
# Imported recordings (found on the server by the import scan)
# --------------------------------------------------------------------------

NO_IMPORT_MODULE_ERROR = 'No module chosen for this imported recording: use "Publish to module" in the admin.'
# Remuxed to a faststart MP4 on import; everything else is placed as it is.
IMPORT_REMUX_SUFFIXES = frozenset({".mkv", ".flv", ".ts"})


def imported_lecture_title(recording):
    when = recording.started_at or recording.created_at
    if recording.session_id:
        return lecture_title_for(recording.session, when)
    when = timezone.localtime(when or timezone.now())
    return f"Class recording - {when:%d %b %Y}"[:255]


def place_file(source, destination):
    """Put ``source`` at ``destination`` without touching the original.

    A hard link when both are on the same filesystem mount (no extra space;
    deleting either name later keeps the other), otherwise a copy written to
    ``<name>.partial`` and renamed into place. Docker volumes are separate
    mounts, so /recordings -> /app/media is always a copy, while files already
    under MEDIA_ROOT are linked. Returns "linked" or "copied".
    """
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        raise RecordingPublishError("The imported file is already at its lecture path.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)  # deterministic name: a retry replaces its own leftover
    try:
        os.link(source, destination)
        return "linked"
    except OSError:
        pass
    partial = destination.with_name(destination.name + ".partial")
    try:
        shutil.copyfile(source, partial)
        os.replace(partial, destination)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return "copied"


def _imported_parts(work_dir):
    directory = Path(work_dir)
    if not directory.is_dir() or directory.is_symlink():
        return []
    return sorted(
        path
        for path in directory.glob("part-*.ts")
        if path.is_file() and not path.is_symlink() and path.stat().st_size > 0
    )


def finalize_import(recording):
    """Imported file (or orphaned capture parts) -> lecture of the chosen module.

    FINALIZING -> PROCESSING; the transcoder and publish_if_ready do the rest.
    The original is never moved or deleted: a single file is hard-linked or
    copied into the module's media folder (MKV/FLV/TS are remuxed to a
    faststart MP4 instead, falling back to a copy if that fails), parts are
    concatenated like a server recording. Safe to run again after a crash.
    """
    from .importer import is_within_import_roots  # importer imports this module

    if recording.lecture_id:
        state.transition(recording, ClassRecording.STATE_PROCESSING, reason="lecture_already_created")
        return recording.lecture
    module = recording.module
    if module is None:
        raise RecordingPublishError(NO_IMPORT_MODULE_ERROR)
    if recording.work_dir:
        if not is_within_import_roots(recording.work_dir):
            raise RecordingPublishError("The imported folder is outside the recording folders and is not used.")
        parts = _imported_parts(recording.work_dir)
        if not parts:
            raise RecordingPublishError("The captured parts of this imported recording are no longer on the server.")
        ensure_media_disk_space(sum(part.stat().st_size for part in parts), action="import the recording")
        storage_name = storage_name_for(recording, module)
        output_path = Path(settings.MEDIA_ROOT) / storage_name
        # The list goes next to the output: the original folder is left untouched.
        list_path = output_path.with_name(output_path.name + ".concat.txt")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            ffmpeg.concat_to_mp4(parts, output_path, list_path=list_path)
        except ffmpeg.FFmpegError as exc:
            raise RecordingPublishError(str(exc)) from exc
        finally:
            list_path.unlink(missing_ok=True)
        method = "concatenated"
    else:
        source = Path(recording.source_path or "")
        if not recording.source_path or not source.is_absolute() or not is_within_import_roots(source):
            raise RecordingPublishError("The imported file is outside the recording folders and is not used.")
        if source.is_symlink() or not source.is_file():
            raise RecordingPublishError(f"The imported file is no longer on the server: {source}")
        ensure_media_disk_space(source.stat().st_size, action="import the recording")
        suffix = source.suffix.lower() or ".mp4"
        storage_name = storage_name_for(recording, module, ".mp4" if suffix in IMPORT_REMUX_SUFFIXES else suffix)
        output_path = Path(settings.MEDIA_ROOT) / storage_name
        if suffix in IMPORT_REMUX_SUFFIXES:
            try:
                ffmpeg.remux_to_mp4(source, output_path)
                method = "remuxed"
            except ffmpeg.FFmpegError as exc:
                # The transcoder decodes far more than MP4 can carry: keep the original container.
                logger.warning(
                    "CLASS_RECORDING_IMPORT_REMUX_FAILED recording_id=%s error=%s (using the original file)",
                    recording.pk,
                    exc,
                )
                storage_name = storage_name_for(recording, module, suffix)
                output_path = Path(settings.MEDIA_ROOT) / storage_name
                method = place_file(source, output_path)
        else:
            method = place_file(source, output_path)
    create_lecture(recording, module, storage_name=storage_name, title=imported_lecture_title(recording))
    state.transition(
        recording,
        ClassRecording.STATE_PROCESSING,
        reason=f"import_{method}",
        file_size_bytes=output_path.stat().st_size,
        duration_seconds=ffmpeg.probe_duration_seconds(output_path) or recording.duration_seconds,
        finalized_at=timezone.now(),
    )
    return recording.lecture
