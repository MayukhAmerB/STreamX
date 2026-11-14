"""Resumable recording uploads: create, receive chunks, complete, process, revert, clean up.

Web requests only stream bytes to disk and flip small rows under a row lock;
everything heavy (assembly, ffprobe, remux, the lecture swap) runs in the
async worker (outbox event ``recording_uploads.assemble``), so a 3 GB file
never pins a web worker or meets Cloudflare's 100 s response limit.

What the worker does with a finished upload (owner decision "better copy wins"):

* the class already has a recording lecture (normally the server's
  auto-recording) -> its video is REPLACED. The lecture keeps its id, so
  students' progress, likes and comments stay; students are not notified
  again; the HLS stream is rebuilt from the new file. The old video file is
  kept for RECORDING_UPLOAD_REVERT_RETENTION_DAYS so an admin can switch back.
* no recording lecture yet -> a lecture is CREATED (published at once, like
  auto-recordings) in the derived module (session module, the live class's
  default, or the course's auto-created "Class recordings" section, flagged
  needs_review).
* the class's auto-recording is still being captured or finalized -> the
  upload waits for it (re-checked every RECORDING_UPLOAD_WAIT_POLL_SECONDS,
  at most RECORDING_UPLOAD_WAIT_FOR_RECORDING_SECONDS), so the two never end
  up as two lectures.
"""

from __future__ import annotations

import logging
import math
import os
import re
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.files import File
from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import F, Q, Sum
from django.utils import timezone
from django.utils.text import slugify

from apps.core.errors import DomainError
from apps.core.outbox import publish
from apps.courses.cache_utils import bump_course_list_cache_version
from apps.courses.models import Lecture
from apps.realtime.models import RealtimeSession
from apps.realtime.recording import modules, publisher, state
from apps.realtime.recording.models import ClassRecording
from config.upload_validators import validate_obs_recording_upload

from . import config, storage
from .media import MediaError
from .models import RecordingUpload
from .tokens import can_upload_recordings

logger = logging.getLogger("ops.recording_uploads")

U = RecordingUpload
R = ClassRecording
ASSEMBLE_EVENT = "recording_uploads.assemble"
CLEANUP_EVENT = "recording_uploads.cleanup"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
STALE_PART_SECONDS = 3600
MISSING_PREVIEW = 50


class UploadError(DomainError):
    """A request the client must change: the core error contract renders it
    (``errors.code`` stable, ``details`` merged into ``errors``)."""

    def __init__(self, message, *, code, status=400, extra=None):
        super().__init__(message, code=code, status=status, details=extra or {})
        self.extra = self.details


class UploadBusy(Exception):
    """Another worker holds the assembly lease: the outbox retries later."""


class ProcessingFailed(Exception):
    """The upload cannot be published (shown to the uploader; no retry)."""


# --------------------------------------------------------------------- access
def can_manage_session(user, session):
    return bool(session is not None and can_upload_recordings(user) and session.is_moderator_allowed(user))


def _session_or_error(user, session_id):
    try:
        session = RealtimeSession.objects.with_related().get(pk=int(session_id))
    except (RealtimeSession.DoesNotExist, TypeError, ValueError) as exc:
        raise UploadError("This class does not exist.", code="session_not_found", status=404) from exc
    if not can_manage_session(user, session):
        raise UploadError(
            "Only the class host, its instructor or an admin can upload its recording.",
            code="session_forbidden",
            status=403,
        )
    if modules.session_course_id(session) is None:
        raise UploadError(
            "This class is not linked to a course, so its recording has nowhere to be published. "
            "Link the live class to a course first.",
            code="session_without_course",
        )
    return session


def _recent_sessions(user):
    since = timezone.now() - timedelta(days=config.target_lookback_days())
    queryset = (
        RealtimeSession.objects.with_related()
        .filter(Q(status=RealtimeSession.STATUS_LIVE) | Q(started_at__gte=since) | Q(ended_at__gte=since))
        .exclude(status=RealtimeSession.STATUS_SCHEDULED)
        .order_by(F("started_at").desc(nulls_last=True), "-id")
    )
    if not (user.is_staff or user.is_superuser):
        queryset = queryset.filter(
            Q(host=user) | Q(linked_course__instructor=user) | Q(linked_live_class__linked_course__instructor=user)
        )
    return [session for session in queryset[:200] if can_manage_session(user, session)]


def publisher_target(session):
    """The recording whose lecture an upload replaces (latest with a lecture, not failed)."""
    return (
        R.objects.filter(session=session, lecture__isnull=False)
        .exclude(state=R.STATE_FAILED)
        .select_related("lecture", "lecture__section")
        .order_by("-created_at", "-id")
        .first()
    )


def describe_target(session):
    target = publisher_target(session)
    course_id = modules.session_course_id(session)
    if target is not None and target.lecture_id:
        destination = {
            "action": U.ACTION_REPLACED,
            "lecture_id": target.lecture_id,
            "lecture_title": target.lecture.title,
            "module_title": target.lecture.section.title,
        }
    else:
        choice = modules.derive_module(R(session=session), create=False)
        destination = {
            "action": U.ACTION_CREATED,
            "lecture_id": None,
            "lecture_title": "",
            "module_title": getattr(choice.module, "title", "") or config_auto_module_title(),
        }
    course = getattr(session, "linked_course", None) or getattr(
        getattr(session, "linked_live_class", None), "linked_course", None
    )
    return {
        "session_id": session.pk,
        "title": session.title,
        "session_type": session.session_type,
        "status": session.status,
        "started_at": session.started_at,
        "ended_at": session.ended_at,
        "course_id": course_id,
        "course_title": getattr(course, "title", "") if course is not None else "",
        "has_course": course_id is not None,
        "auto_recording_pending": auto_recording_pending(session),
        **destination,
    }


def config_auto_module_title():
    from apps.realtime.recording import config as recording_config

    return recording_config.auto_module_title()


def upload_targets(user):
    return [describe_target(session) for session in _recent_sessions(user) if modules.session_course_id(session)]


def latest_session_for(user):
    """The class a desktop upload belongs to when it names none: the user's live
    class, else the one that ended last (within the lookback window)."""
    sessions = [session for session in _recent_sessions(user) if modules.session_course_id(session)]
    live = [session for session in sessions if session.status == RealtimeSession.STATUS_LIVE]
    if live:
        return live[0]
    ended = sorted(
        (session for session in sessions if session.ended_at or session.started_at),
        key=lambda session: session.ended_at or session.started_at,
        reverse=True,
    )
    return ended[0] if ended else None


# --------------------------------------------------------------------- create
def _normalise_sha256(value, field="sha256"):
    value = str(value or "").strip().lower()
    if value and not SHA256_RE.match(value):
        raise UploadError("SHA-256 must be 64 hexadecimal characters.", code="invalid_sha256", extra={"field": field})
    return value


def create_upload(*, user, session_id=None, filename, total_bytes, sha256="", content_type="", token=None):
    """Start an upload, or return the matching unfinished one (resume).

    Returns ``(upload, created)``. An unfinished upload of the same file
    (owner, class, name, size, and checksum when both declare one) is resumed
    instead of starting again, which is how a refreshed browser tab or a
    restarted desktop uploader continues where it stopped.
    """
    if not can_upload_recordings(user):
        raise UploadError("Only instructors and admins can upload class recordings.", code="forbidden", status=403)
    if session_id in (None, ""):
        latest = latest_session_for(user)
        if latest is None:
            raise UploadError(
                "No recent class of yours was found. Choose the class to upload to.", code="session_required"
            )
        session_id = latest.pk
    session = _session_or_error(user, session_id)
    try:
        safe_name, extension = storage.sanitize_filename(filename)
    except ValidationError as exc:
        raise UploadError(exc.message_dict["filename"][0], code="invalid_filename") from exc
    try:
        total_bytes = int(total_bytes)
    except (TypeError, ValueError) as exc:
        raise UploadError("File size must be a whole number of bytes.", code="invalid_size") from exc
    if total_bytes <= 0:
        raise UploadError("The file is empty.", code="invalid_size")
    limit = config.max_file_bytes()
    if total_bytes > limit:
        raise UploadError(
            f"The file is too large. The limit is {limit / config.GIB:.0f} GB.",
            code="file_too_large",
            status=413,
            extra={"max_bytes": limit},
        )
    sha256 = _normalise_sha256(sha256)
    now = timezone.now()

    with transaction.atomic():
        resumable = U.objects.select_for_update().filter(
            owner=user, session=session, filename=safe_name, total_bytes=total_bytes, status=U.STATUS_UPLOADING
        )
        for existing in resumable.order_by("-created_at"):
            if existing.expires_at <= now:
                continue
            if sha256 and existing.sha256 and existing.sha256 != sha256:
                continue
            existing.expires_at = now + timedelta(seconds=config.expiry_seconds())
            fields = ["expires_at", "updated_at"]
            if sha256 and not existing.sha256:
                existing.sha256 = sha256
                fields.append("sha256")
            existing.save(update_fields=fields)
            return existing, False

        active = U.objects.filter(owner=user, status__in=U.ACTIVE_STATUSES)
        if active.count() >= config.max_active_per_user():
            raise UploadError(
                "You already have the maximum number of unfinished uploads. Finish or cancel one first.",
                code="too_many_uploads",
                status=429,
            )
        active_bytes = active.aggregate(total=Sum("total_bytes"))["total"] or 0
        if active_bytes + total_bytes > config.max_active_bytes_per_user():
            raise UploadError(
                "Your unfinished uploads would use too much space. Finish or cancel one first.",
                code="upload_quota_exceeded",
                status=429,
            )
        # Chunks plus the assembled copy need twice the size while the worker runs.
        needed = 2 * total_bytes + config.min_free_bytes()
        if storage.free_bytes() < needed:
            raise UploadError(
                "The server does not have enough free space for this recording right now. Try again later.",
                code="insufficient_storage",
                status=507,
            )
        chunk = config.chunk_bytes()
        upload = U.objects.create(
            owner=user,
            session=session,
            token=token,
            filename=safe_name,
            extension=extension,
            content_type=str(content_type or "")[:100],
            total_bytes=total_bytes,
            chunk_bytes=chunk,
            chunk_count=max(1, math.ceil(total_bytes / chunk)),
            sha256=sha256,
            expires_at=now + timedelta(seconds=config.expiry_seconds()),
        )
    storage.prepare_upload_dir(upload.pk)
    logger.info(
        "RECORDING_UPLOAD_CREATED upload_id=%s session_id=%s bytes=%s chunks=%s via=%s",
        upload.pk,
        session.pk,
        total_bytes,
        upload.chunk_count,
        "token" if token else "console",
    )
    return upload, True


# ---------------------------------------------------------------------- chunks
def get_owned(upload_id, user, *, lock=False):
    queryset = U.objects.select_related("session", "lecture")
    if lock:
        queryset = queryset.select_for_update()
    upload = queryset.filter(pk=upload_id).first()
    if upload is None or (upload.owner_id != user.pk and not (user.is_staff or user.is_superuser)):
        raise UploadError("Upload not found.", code="not_found", status=404)
    return upload


def _require_writable(upload, now):
    if upload.status != U.STATUS_UPLOADING:
        raise UploadError(
            f"This upload is {upload.get_status_display().lower()}; no more chunks are accepted.",
            code="not_uploading",
            status=409,
            extra={"status": upload.status},
        )
    if upload.expires_at <= now:
        raise UploadError("This upload expired. Start it again.", code="upload_expired", status=410)


def put_chunk(*, upload_id, user, index, stream, content_length, declared_sha256=""):
    """Store chunk ``index`` from ``stream``. Idempotent; chunks may arrive in any order.

    Returns ``(upload, duplicate)``. A chunk sent again with the same bytes is
    accepted as a no-op; different bytes for a stored chunk are a 409.
    """
    upload = get_owned(upload_id, user)
    if upload.owner_id != user.pk:
        raise UploadError("Only the person who started this upload can send its chunks.", code="not_owner", status=403)
    now = timezone.now()
    _require_writable(upload, now)
    if index < 0 or index >= upload.chunk_count:
        raise UploadError(
            f"Chunk {index} is out of range (0-{upload.chunk_count - 1}).", code="chunk_out_of_range", status=416
        )
    expected = upload.expected_chunk_size(index)
    if content_length is None:
        raise UploadError("Content-Length is required.", code="length_required", status=411)
    if content_length > config.max_chunk_body_bytes():
        raise UploadError("Chunk is larger than the chunk size.", code="chunk_too_large", status=413)
    if content_length != expected:
        raise UploadError(
            f"Chunk {index} must be exactly {expected} bytes (got {content_length}).",
            code="chunk_size_mismatch",
            extra={"expected_bytes": expected},
        )
    declared_sha256 = _normalise_sha256(declared_sha256, field="X-Chunk-Sha256")
    try:
        temp_path, digest = storage.receive_chunk(stream, upload.pk, index, expected)
    except storage.ChunkBodyError as exc:
        raise UploadError(str(exc), code="chunk_incomplete") from exc
    try:
        if declared_sha256 and declared_sha256 != digest:
            raise UploadError(
                f"Chunk {index} arrived damaged (checksum mismatch). Send it again.",
                code="chunk_checksum_mismatch",
                status=422,
            )
        with transaction.atomic():
            locked = U.objects.select_for_update().get(pk=upload.pk)
            _require_writable(locked, timezone.now())
            if locked.has_chunk(index):
                if str((locked.chunk_sha256 or {}).get(str(index)) or "") != digest:
                    raise UploadError(
                        f"Chunk {index} was already received with different content.",
                        code="chunk_conflict",
                        status=409,
                    )
                return locked, True
            storage.commit_chunk(temp_path, upload.pk, index)
            hashes = dict(locked.chunk_sha256 or {})
            hashes[str(index)] = digest
            locked.chunk_sha256 = hashes
            locked.received_bitmap = locked.with_chunk(index)
            locked.received_count = F("received_count") + 1
            locked.received_bytes = F("received_bytes") + expected
            locked.expires_at = timezone.now() + timedelta(seconds=config.expiry_seconds())
            locked.save(
                update_fields=[
                    "chunk_sha256",
                    "received_bitmap",
                    "received_count",
                    "received_bytes",
                    "expires_at",
                    "updated_at",
                ]
            )
            locked.refresh_from_db()
            return locked, False
    finally:
        Path(temp_path).unlink(missing_ok=True)


# ------------------------------------------------------------------ complete
def request_complete(*, upload_id, user):
    """All chunks are in: queue the worker. Idempotent and safe to race.

    Returns ``(upload, queued_now)``. Two concurrent calls serialise on the row
    lock; the second sees ``queued`` and queues nothing (the outbox event also
    has a dedupe key).
    """
    with transaction.atomic():
        upload = get_owned(upload_id, user, lock=True)
        if upload.status in (U.STATUS_QUEUED, U.STATUS_ASSEMBLING, U.STATUS_COMPLETED):
            return upload, False
        _require_writable(upload, timezone.now())
        if upload.received_count != upload.chunk_count:
            missing = upload.missing_indexes()
            raise UploadError(
                f"{len(missing)} chunk(s) are still missing.",
                code="chunks_missing",
                status=409,
                extra={"missing_chunks": missing[:MISSING_PREVIEW], "missing_count": len(missing)},
            )
        upload.status = U.STATUS_QUEUED
        upload.error = ""
        upload.save(update_fields=["status", "error", "updated_at"])
        publish(ASSEMBLE_EVENT, {"upload_id": str(upload.pk)}, dedupe_key=f"recording-upload-assemble:{upload.pk}")
    logger.info("RECORDING_UPLOAD_COMPLETE_REQUESTED upload_id=%s", upload.pk)
    return upload, True


def abort_upload(*, upload_id, user):
    with transaction.atomic():
        upload = get_owned(upload_id, user, lock=True)
        if upload.status == U.STATUS_ABORTED:
            return upload
        if upload.status not in (U.STATUS_UPLOADING, U.STATUS_QUEUED, U.STATUS_FAILED, U.STATUS_EXPIRED):
            raise UploadError(
                f"This upload is {upload.get_status_display().lower()} and cannot be cancelled.",
                code="cannot_abort",
                status=409,
            )
        upload.status = U.STATUS_ABORTED
        upload.lease_until = None
        upload.save(update_fields=["status", "lease_until", "updated_at"])
        upload_id = upload.pk
        transaction.on_commit(lambda: storage.remove_upload_dir(upload_id))
    logger.info("RECORDING_UPLOAD_ABORTED upload_id=%s", upload.pk)
    return upload


# ------------------------------------------------------------------ worker
def auto_recording_pending(session):
    """The class's server/egress recording is still capturing or finalizing (no lecture yet)."""
    if session is None:
        return False
    return R.objects.filter(
        session=session,
        lecture__isnull=True,
        state__in=R.ACTIVE_STATES,
        source__in=(R.SOURCE_SERVER, R.SOURCE_LIVEKIT_EGRESS, R.SOURCE_BROWSER_FALLBACK),
    ).exists()


def _claim(upload_id):
    now = timezone.now()
    lease = now + timedelta(seconds=config.assemble_lease_seconds())
    claimable = Q(status=U.STATUS_QUEUED) | Q(status=U.STATUS_ASSEMBLING, lease_until__isnull=True) | Q(
        status=U.STATUS_ASSEMBLING, lease_until__lt=now
    )
    return bool(
        U.objects.filter(claimable, pk=upload_id).update(
            status=U.STATUS_ASSEMBLING, lease_until=lease, attempts=F("attempts") + 1, updated_at=now
        )
    )


def _renew_lease(upload):
    U.objects.filter(pk=upload.pk, status=U.STATUS_ASSEMBLING).update(
        lease_until=timezone.now() + timedelta(seconds=config.assemble_lease_seconds())
    )


def _release_lease(upload):
    U.objects.filter(pk=upload.pk, status=U.STATUS_ASSEMBLING).update(lease_until=None, updated_at=timezone.now())


def _fail(upload, message):
    message = str(message or "Processing failed.")[:4000]
    U.objects.filter(pk=upload.pk).update(
        status=U.STATUS_FAILED, error=message, lease_until=None, updated_at=timezone.now()
    )
    storage.remove_upload_dir(upload.pk)
    logger.warning("RECORDING_UPLOAD_FAILED upload_id=%s error=%s", upload.pk, message)


def _defer_for_recording(upload):
    """Re-queue: the class's auto-recording has no lecture yet."""
    now = timezone.now()
    U.objects.filter(pk=upload.pk).update(
        status=U.STATUS_QUEUED,
        lease_until=None,
        waiting_since=upload.waiting_since or now,
        updated_at=now,
    )
    publish(
        ASSEMBLE_EVENT,
        {"upload_id": str(upload.pk)},
        dedupe_key=f"recording-upload-assemble:{upload.pk}:wait:{int(now.timestamp())}",
        delay_seconds=config.wait_poll_seconds(),
    )
    logger.info("RECORDING_UPLOAD_WAITING_FOR_AUTO_RECORDING upload_id=%s", upload.pk)


def _validate_container(upload, path):
    with open(path, "rb") as handle:
        wrapped = File(handle, name=upload.filename)
        try:
            validate_obs_recording_upload(wrapped, "video_file", max_bytes=config.max_file_bytes())
        except ValidationError as exc:
            messages = getattr(exc, "message_dict", {}).get("video_file") or exc.messages
            raise ProcessingFailed(" ".join(str(item) for item in messages)) from exc


def process_upload(upload_id):
    """Worker entry point (outbox ``recording_uploads.assemble``). Idempotent.

    Raises UploadBusy while another worker holds the lease (the outbox
    retries); any unexpected error releases the lease and is re-raised so the
    outbox retries with backoff. Problems with the file itself fail the upload
    with a message for the uploader.
    """
    if not _claim(upload_id):
        upload = U.objects.filter(pk=upload_id).first()
        if upload is not None and upload.status == U.STATUS_ASSEMBLING:
            raise UploadBusy(f"Upload {upload_id} is being processed by another worker.")
        return upload
    upload = U.objects.select_related("session", "owner").get(pk=upload_id)
    runner = config.media_runner()
    try:
        session = upload.session
        if session is None:
            raise ProcessingFailed("The class of this upload was deleted.")
        if auto_recording_pending(session):
            waited = (timezone.now() - upload.waiting_since).total_seconds() if upload.waiting_since else 0
            if waited < config.wait_for_recording_seconds():
                _defer_for_recording(upload)
                upload.refresh_from_db()
                return upload
        assembled = storage.assembled_path(upload.pk, upload.extension)
        if not assembled.is_file() or upload.computed_sha256 == "":
            if storage.free_bytes() < upload.total_bytes + config.min_free_bytes():
                raise RuntimeError("Not enough free space on the staging disk to assemble the upload; retrying.")
            digest, size = storage.assemble(upload, assembled, on_chunk=lambda _index: _renew_lease(upload))
            if size != upload.total_bytes:
                raise ProcessingFailed(f"The assembled file has {size} bytes; {upload.total_bytes} were expected.")
            if upload.sha256 and digest != upload.sha256:
                raise ProcessingFailed(
                    "The file on the server does not match the file on your computer (SHA-256 mismatch). "
                    "Upload it again."
                )
            U.objects.filter(pk=upload.pk).update(computed_sha256=digest)
            upload.computed_sha256 = digest
            storage.remove_chunks(upload.pk)
        _renew_lease(upload)
        _validate_container(upload, assembled)
        probe = runner.probe(assembled)
        if not probe.has_video:
            raise ProcessingFailed("The file has no video track.")
        _renew_lease(upload)
        _publish(upload, assembled, probe, runner)
    except (ProcessingFailed, MediaError, publisher.RecordingPublishError, storage.AssemblyError) as exc:
        _fail(upload, str(exc))
        upload.refresh_from_db()
        return upload
    except Exception:
        _release_lease(upload)
        raise
    upload.refresh_from_db()
    storage.remove_upload_dir(upload.pk)
    return upload


def storage_name_for(upload, module):
    """``lecture_videos/<course>/module_<id>/upload-<id8>-<stamp>.mp4`` (well under 500 chars)."""
    course_slug = (slugify(getattr(module.course, "slug", "") or "course") or "course")[:48].strip("-") or "course"
    stamp = timezone.localtime(timezone.now()).strftime("%Y%m%d-%H%M%S")
    return f"lecture_videos/{course_slug}/module_{module.pk}/upload-{str(upload.pk)[:8]}-{stamp}.mp4"


def _publish(upload, assembled, probe, runner):
    """Remux into MEDIA_ROOT, then swap/create the lecture and record the outcome in one transaction.

    The ClassRecording row is created only in that transaction (straight in
    PROCESSING, like the existing OBS replacement): a FINALIZING row would be
    picked up by the stream recorder's finalize loop while ffmpeg runs here.
    """
    session = upload.session
    target = publisher_target(session)
    draft = R(session=session, source=R.SOURCE_OBS_UPLOAD)
    if target is not None and target.lecture_id:
        module = Lecture.objects.select_related("section__course").get(pk=target.lecture_id).section
    else:
        module = publisher.resolve_module(draft)  # flags draft.needs_review for a derived module
    publisher.ensure_media_disk_space(upload.total_bytes, action="publish the uploaded recording")
    storage_name = storage_name_for(upload, module)
    output = Path(settings.MEDIA_ROOT) / storage_name
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.name + storage.PART_SUFFIX)
    try:
        runner.remux_to_mp4(assembled, partial)
        os.replace(partial, output)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    _renew_lease(upload)
    duration = probe.duration_seconds
    try:
        with transaction.atomic():
            locked = U.objects.select_for_update().get(pk=upload.pk)
            if locked.status != U.STATUS_ASSEMBLING:
                raise ProcessingFailed(f"The upload was {locked.get_status_display().lower()} while processing.")
            previous_name = ""
            if target is not None and target.lecture_id:
                lecture = Lecture.objects.select_for_update().get(pk=target.lecture_id)
                previous_name = str(lecture.video_file.name or "")
                lecture.video_file.name = storage_name
                lecture.stream_status = Lecture.STREAM_UPLOADED
                lecture.stream_priority = publisher.CLASS_RECORDING_STREAM_PRIORITY
                # Students were already told about this class's recording.
                lecture._suppress_upload_notification = True
                lecture.save()
                action = U.ACTION_REPLACED
            else:
                lecture = Lecture(
                    section=module,
                    title=publisher.lecture_title_for(session, session.started_at),
                    description=publisher.lecture_description_for(draft, module),
                    order=publisher.next_lecture_order(module, lock=True),
                    is_published=publisher.initially_published(draft),
                    stream_priority=publisher.CLASS_RECORDING_STREAM_PRIORITY,
                )
                lecture.video_file.name = storage_name
                lecture.save()
                action = U.ACTION_CREATED
            now = timezone.now()
            recording = R.objects.create(
                session=session,
                module=lecture.section,
                lecture=lecture,
                started_by=upload.owner,
                source=R.SOURCE_OBS_UPLOAD,
                state=R.STATE_PROCESSING,
                file_size_bytes=output.stat().st_size,
                duration_seconds=duration,
                needs_review=bool(draft.needs_review) and action == U.ACTION_CREATED,
                review_reason=draft.review_reason if action == U.ACTION_CREATED else "",
                started_at=session.started_at,
                stop_requested_at=now,
                finalized_at=now,
            )
            state.log_transition(
                recording,
                "",
                R.STATE_PROCESSING,
                reason="resumable_upload_replaced_video" if action == U.ACTION_REPLACED else "resumable_upload_created",
                request=None,
            )
            U.objects.filter(pk=upload.pk).update(
                status=U.STATUS_COMPLETED,
                lease_until=None,
                error="",
                recording=recording,
                replaced_recording=target if action == U.ACTION_REPLACED else None,
                lecture=lecture,
                action=action,
                video_name=storage_name,
                previous_video_name=previous_name if previous_name != storage_name else "",
                duration_seconds=duration,
                completed_at=now,
                updated_at=now,
            )
            if lecture.is_published:
                transaction.on_commit(bump_course_list_cache_version)
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    logger.info(
        "RECORDING_UPLOAD_PUBLISHED upload_id=%s session_id=%s lecture_id=%s action=%s recording_id=%s",
        upload.pk,
        session.pk,
        lecture.pk,
        action,
        recording.pk,
    )


# ------------------------------------------------------------------- revert
def switch_video(upload, *, user, restore_upload):
    """Admin: put the replaced video back (``restore_upload=False``) or the upload again.

    The lecture (id, progress, comments) never changes; only its file does,
    and the HLS stream is rebuilt from the file that is now current.
    """
    if upload.status != U.STATUS_COMPLETED or upload.action != U.ACTION_REPLACED or not upload.lecture_id:
        raise UploadError("Only an upload that replaced a lecture video can be switched back.", code="not_revertible", status=409)
    if restore_upload and upload.reverted_at is None:
        raise UploadError("The uploaded video is already the lecture's video.", code="already_current", status=409)
    if not restore_upload and upload.reverted_at is not None:
        raise UploadError("The lecture already shows the previous video.", code="already_reverted", status=409)
    if upload.previous_video_deleted_at is not None or not upload.previous_video_name:
        raise UploadError("The other video file is no longer kept.", code="previous_video_gone", status=410)
    with transaction.atomic():
        locked = U.objects.select_for_update().get(pk=upload.pk)
        lecture = Lecture.objects.select_for_update().get(pk=locked.lecture_id)
        current = str(lecture.video_file.name or "")
        if current != locked.video_name:
            raise UploadError(
                "The lecture's video was changed after this upload; nothing was switched.",
                code="lecture_changed",
                status=409,
            )
        if not default_storage.exists(locked.previous_video_name):
            raise UploadError("The other video file is no longer on the server.", code="previous_video_gone", status=410)
        lecture.video_file.name = locked.previous_video_name
        lecture.stream_status = Lecture.STREAM_UPLOADED
        lecture._suppress_upload_notification = True
        lecture.save()
        locked.video_name, locked.previous_video_name = locked.previous_video_name, locked.video_name
        locked.reverted_at = None if restore_upload else timezone.now()
        locked.reverted_by = user
        locked.save(update_fields=["video_name", "previous_video_name", "reverted_at", "reverted_by", "updated_at"])
    logger.info(
        "RECORDING_UPLOAD_VIDEO_SWITCHED upload_id=%s lecture_id=%s to=%s by=%s",
        upload.pk,
        lecture.pk,
        "upload" if restore_upload else "previous",
        user.pk,
    )
    return locked


# ------------------------------------------------------------------ cleanup
def _referenced_by_a_lecture(name):
    return Lecture.objects.filter(video_file=name).exists()


def cleanup(now=None):
    """Expire stale uploads, remove leftovers, drop replaced videos past retention."""
    now = now or timezone.now()
    stats = {"expired": 0, "dirs_removed": 0, "parts_removed": 0, "previous_deleted": 0}
    for upload_id in U.objects.filter(status=U.STATUS_UPLOADING, expires_at__lte=now).values_list("pk", flat=True):
        if U.objects.filter(pk=upload_id, status=U.STATUS_UPLOADING, expires_at__lte=now).update(
            status=U.STATUS_EXPIRED, updated_at=now
        ):
            storage.remove_upload_dir(upload_id)
            stats["expired"] += 1
    active = set(U.objects.filter(status__in=U.ACTIVE_STATUSES).values_list("pk", flat=True))
    grace = config.orphan_dir_grace_seconds()
    for upload_id, directory in storage.staged_upload_ids():
        if upload_id in active:
            for part in storage.stale_part_files(upload_id, STALE_PART_SECONDS):
                part.unlink(missing_ok=True)
                stats["parts_removed"] += 1
            continue
        known = U.objects.filter(pk=upload_id).exists()
        try:
            age = now.timestamp() - directory.stat().st_mtime
        except OSError:
            continue
        if known or age > grace:
            storage.remove_upload_dir(upload_id)
            stats["dirs_removed"] += 1
    cutoff = now - timedelta(days=config.revert_retention_days())
    keep = U.objects.filter(
        status=U.STATUS_COMPLETED,
        action=U.ACTION_REPLACED,
        previous_video_deleted_at__isnull=True,
        completed_at__lte=cutoff,
    ).exclude(previous_video_name="")
    for upload in keep:
        name = upload.previous_video_name
        if not _referenced_by_a_lecture(name):
            try:
                default_storage.delete(name)
            except Exception:  # noqa: BLE001 - retried on the next run
                logger.exception("RECORDING_UPLOAD_PREVIOUS_DELETE_FAILED upload_id=%s", upload.pk)
                continue
        U.objects.filter(pk=upload.pk).update(previous_video_deleted_at=now)
        stats["previous_deleted"] += 1
    if any(stats.values()):
        logger.info("RECORDING_UPLOAD_CLEANUP %s", " ".join(f"{key}={value}" for key, value in stats.items()))
    return stats


# ------------------------------------------------------------------ output
def upload_payload(upload, *, request=None):
    lecture = upload.lecture if upload.lecture_id else None
    course_id = None
    if lecture is not None:
        course_id = lecture.section.course_id
    session = upload.session if upload.session_id else None
    return {
        "id": str(upload.pk),
        "status": upload.status,
        "status_label": upload.get_status_display(),
        "session_id": upload.session_id,
        "session_title": getattr(session, "title", "") or "",
        "filename": upload.filename,
        "total_bytes": upload.total_bytes,
        "chunk_bytes": upload.chunk_bytes,
        "chunk_count": upload.chunk_count,
        "received_count": upload.received_count,
        "received_bytes": upload.received_bytes,
        "received_chunks": upload.received_indexes(),
        "sha256": upload.sha256,
        "error": upload.error,
        "waiting_for_auto_recording": bool(upload.waiting_since and upload.status in (U.STATUS_QUEUED, U.STATUS_ASSEMBLING)),
        "expires_at": upload.expires_at,
        "created_at": upload.created_at,
        "completed_at": upload.completed_at,
        "via_token": bool(upload.token_id),
        "result": {
            "action": upload.action,
            "lecture_id": upload.lecture_id,
            "lecture_title": getattr(lecture, "title", "") or "",
            "course_id": course_id,
            "recording_id": upload.recording_id,
            "learn_url": f"/learn/{course_id}?lecture={upload.lecture_id}" if course_id and upload.lecture_id else "",
            "reverted": upload.reverted_at is not None,
            "can_switch_back": bool(
                upload.action == U.ACTION_REPLACED
                and upload.previous_video_name
                and upload.previous_video_deleted_at is None
            ),
        }
        if upload.status == U.STATUS_COMPLETED
        else None,
    }
