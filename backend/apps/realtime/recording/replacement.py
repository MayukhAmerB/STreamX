"""Replace a class recording's video with the higher-quality file OBS saved.

The lecture row is kept (same id, likes, comments, views, progress); only its
source file changes, which makes Lecture.save() drop the old HLS manifest so
the transcoder re-encodes the new file. The upload itself uses the same
multipart path as the existing lecture uploads (nginx streams it to Django
with request buffering off; Django spools it to a temp file).

OBS's default MKV (and FLV/TS) recordings are accepted too. They are not
remuxed on the web worker: the file is staged under MEDIA_ROOT and a
FINALIZING upload recording is queued; the stream recorder remuxes it to a
faststart MP4 (stream copy) and only then swaps it into the lecture
(publisher.finalize_obs_upload).
"""

import os

from django.core.exceptions import ValidationError
from django.core.files.storage import default_storage
from django.db import transaction
from django.utils import timezone

from apps.courses.models import Lecture
from config.upload_validators import needs_obs_remux, validate_obs_recording_upload

from . import config, state
from .models import ClassRecording
from .publisher import lecture_title_for, next_lecture_order

R = ClassRecording


def replacement_target(session, recording=None):
    """The recording whose lecture should be replaced (latest with a lecture)."""
    if recording is not None:
        return recording
    return (
        R.objects.filter(session=session, lecture__isnull=False)
        .exclude(state=R.STATE_FAILED)
        .select_related("lecture")
        .order_by("-created_at", "-id")
        .first()
    )


def _upload_name(session, uploaded_file):
    ext = os.path.splitext(getattr(uploaded_file, "name", "") or "")[1].lower() or ".mp4"
    stamp = timezone.localtime().strftime("%Y%m%d-%H%M%S")
    return f"obs-class-{session.pk}-{stamp}{ext}"


def _delete_file_later(storage, name):
    def _delete():
        try:
            storage.delete(name)
        except Exception:
            pass

    transaction.on_commit(_delete)


def _queue_for_remux(*, session, uploaded_file, user, target, request):
    """Stage an MKV/FLV/TS upload for the recorder to remux; nothing is swapped yet."""
    lecture = target.lecture if target is not None and target.lecture_id else None
    module = lecture.section if lecture is not None else session.target_module
    if module is None:
        raise ValidationError({"target_module": "Tag the session with a target module before uploading a recording."})
    staged_name = default_storage.save(
        f"{config.OBS_UPLOAD_STAGING_DIR}/{_upload_name(session, uploaded_file)}", uploaded_file
    )
    try:
        queued = R.objects.create(
            session=session,
            module=module,
            lecture=lecture,
            started_by=user if getattr(user, "is_authenticated", False) else None,
            source=R.SOURCE_OBS_UPLOAD,
            state=R.STATE_FINALIZING,
            source_path=staged_name,
            file_size_bytes=getattr(uploaded_file, "size", None),
            started_at=getattr(session, "started_at", None),
            stop_requested_at=timezone.now(),
        )
    except Exception:
        default_storage.delete(staged_name)
        raise
    state.log_transition(queued, "", R.STATE_FINALIZING, reason="obs_upload_queued_for_remux", request=request)
    return queued


def replace_with_obs_upload(*, session, uploaded_file, user, recording=None, request=None):
    """Attach ``uploaded_file`` to the session's lecture (creating it if needed).

    MP4/MOV/M4V/WEBM are swapped in at once. MKV/FLV/TS are queued for the
    recorder to remux first; the returned recording is then FINALIZING.
    """
    validate_obs_recording_upload(uploaded_file, "video_file")
    if recording is not None and recording.session_id != session.pk:
        raise ValidationError({"recording_id": "Recording does not belong to this session."})
    target = replacement_target(session, recording)
    if needs_obs_remux(getattr(uploaded_file, "name", "")):
        return _queue_for_remux(
            session=session, uploaded_file=uploaded_file, user=user, target=target, request=request
        )
    with transaction.atomic():
        if target is not None and target.lecture_id:
            lecture = Lecture.objects.select_for_update().select_related("section__course").get(pk=target.lecture_id)
            old_name = str(lecture.video_file.name or "")
            old_storage = lecture.video_file.storage
            lecture.video_file.save(_upload_name(session, uploaded_file), uploaded_file, save=False)
            lecture.stream_status = Lecture.STREAM_UPLOADED
            # Students were already told about this lecture; a better-quality
            # file for the same class is not a new video.
            lecture._suppress_upload_notification = True
            lecture.save()
            if old_name and old_name != lecture.video_file.name:
                _delete_file_later(old_storage, old_name)
            created_lecture = False
        else:
            module = session.target_module
            if module is None:
                raise ValidationError(
                    {"target_module": "Tag the session with a target module before uploading a recording."}
                )
            lecture = Lecture(
                section=module,
                title=lecture_title_for(session),
                description=module.description or "",
                order=next_lecture_order(module),
                is_published=False,
            )
            lecture.video_file.save(_upload_name(session, uploaded_file), uploaded_file, save=False)
            lecture.save()
            created_lecture = True
        replacement = R.objects.create(
            session=session,
            module=lecture.section,
            lecture=lecture,
            started_by=user if getattr(user, "is_authenticated", False) else None,
            source=R.SOURCE_OBS_UPLOAD,
            state=R.STATE_PROCESSING,
            file_size_bytes=getattr(uploaded_file, "size", None),
            started_at=getattr(session, "started_at", None),
            finalized_at=timezone.now(),
        )
    state.log_transition(
        replacement,
        "",
        R.STATE_PROCESSING,
        reason="obs_upload_created_lecture" if created_lecture else "obs_upload_replaced_video",
        request=request,
    )
    return replacement
