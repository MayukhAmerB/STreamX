"""Turn a finished class recording into a lecture of the tagged module."""

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
    course_slug = slugify(getattr(module.course, "slug", "") or "course") or "course"
    stamp = timezone.localtime(recording.started_at or recording.created_at or timezone.now()).strftime("%Y%m%d-%H%M%S")
    return f"lecture_videos/{course_slug}/module_{module.pk}/class-recording-{recording.pk}-{stamp}{suffix}"


def next_lecture_order(module):
    current = Lecture.objects.filter(section=module).aggregate(top=Max("order"))["top"]
    return int(current or 0) + 1


def create_lecture(recording, module, *, storage_name):
    """Create (once) the unpublished lecture for ``recording``. Idempotent."""
    with transaction.atomic():
        locked = ClassRecording.objects.select_for_update().get(pk=recording.pk)
        if locked.lecture_id:
            recording.lecture_id = locked.lecture_id
            return locked.lecture
        title = lecture_title_for(recording.session, recording.started_at)
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
