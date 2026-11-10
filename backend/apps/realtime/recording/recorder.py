"""The long-running recorder loop behind ``manage.py run_stream_recorder``.

One tick:
1. capture  - keep one ffmpeg (stream copy) per RECORDING server recording
               while Owncast reports the feed online; every OBS (re)connect
               becomes a new MPEG-TS part. Disk/size/duration guards apply.
               ffmpeg reads Owncast through the local playlist filter
               (hls_proxy.py), which keeps Owncast's offline clip out of the
               recording and lets a restarted part continue seamlessly.
2. finalize - for FINALIZING rows: stop ffmpeg, concat parts (or take the
               LiveKit egress file, or remux a staged OBS MKV/FLV/TS upload)
               into a faststart MP4 inside the module's media folder, create or
               update the lecture -> PROCESSING. A concat can run for up to
               STREAM_RECORDER_FINALIZE_TIMEOUT_SECONDS, so in the service it
               runs on a separate finalize thread with its own bounded queue:
               the capture loop keeps starting new classes meanwhile.
3. publish  - PROCESSING rows whose lecture HLS is ready -> PUBLISHED.
4. sweep    - hourly: captured parts / staged uploads of FAILED recordings past
               STREAM_RECORDER_FAILED_RETENTION_DAYS, and work dirs or staged
               uploads that no recording row owns any more.

The recorder is a viewer of Owncast's HLS output and never talks to OBS or the
ingest, so a crash here cannot interrupt the live class.
"""

import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.db import close_old_connections, connections
from django.db.models import Q
from django.utils import timezone

from apps.courses.models import Lecture

from .. import services as realtime_services
from . import config, ffmpeg, hls_proxy, publisher, state
from .models import ClassRecording
from .publisher import free_disk_bytes  # noqa: F401 - re-exported for callers/tests
from . import services as recording_services
from .services import is_pending_obs_remux

logger = logging.getLogger("ops.realtime")
R = ClassRecording
PART_GLOB = "part-*.ts"
WORK_DIR_PATTERN = re.compile(r"^class-recording-(\d+)$")
# Leftovers younger than this are never swept: the row that owns a new work dir
# or staged upload may not be visible yet.
ORPHAN_GRACE_SECONDS = 3600


@dataclass
class Capture:
    process: object
    part_path: Path
    started_monotonic: float
    log_handle: object = field(default=None)
    connect_marker: str = ""
    proxy_token: str = ""


def list_parts(work_dir):
    if not work_dir:
        return []
    directory = Path(work_dir)
    if not directory.is_dir():
        return []
    return sorted(path for path in directory.glob(PART_GLOB) if path.is_file() and path.stat().st_size > 0)


def captured_bytes(work_dir):
    return sum(path.stat().st_size for path in list_parts(work_dir))


class FinalizeWorker:
    """One background thread draining a bounded queue of recording ids.

    ``submit`` never blocks the capture loop: a full queue or an id that is
    already queued/running is skipped and offered again on the next tick.
    """

    def __init__(self, handler, *, maxsize, should_run=None, name="class-recording-finalize"):
        self._handler = handler
        self._should_run = should_run or (lambda: True)
        self._queue = queue.Queue(maxsize=maxsize)
        self._pending = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._name = name

    def start(self):
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._stop.clear()
                self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
                self._thread.start()

    def submit(self, recording_id):
        with self._lock:
            if recording_id in self._pending:
                return False
            try:
                self._queue.put_nowait(recording_id)
            except queue.Full:
                return False
            self._pending.add(recording_id)
        self.start()
        return True

    def is_pending(self, recording_id):
        with self._lock:
            return recording_id in self._pending

    def idle(self):
        with self._lock:
            return not self._pending

    def stop(self, timeout=5.0):
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout)

    def _run(self):
        while not self._stop.is_set():
            try:
                recording_id = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                if self._should_run():
                    close_old_connections()
                    self._handler(recording_id)
            except Exception:  # the handler records failures on the row; never kill the thread
                logger.exception("CLASS_RECORDING_FINALIZE_WORKER_CRASH recording_id=%s", recording_id)
            finally:
                with self._lock:
                    self._pending.discard(recording_id)
                connections.close_all()


class StreamRecorder:
    def __init__(
        self,
        *,
        popen=subprocess.Popen,
        monotonic=time.monotonic,
        owncast_status=None,
        background_finalize=False,
        should_finalize=None,
        hls_filter=None,
        recording_ids=None,
    ):
        """``recording_ids`` limits every query of this recorder to those rows
        (the ``verify_recording_pipeline`` check drives a recorder that must
        never see, capture or finalize a real class)."""
        self._popen = popen
        self.hls_filter = hls_filter
        self._recording_ids = None if recording_ids is None else frozenset(recording_ids)
        self._monotonic = monotonic
        self._owncast_status = owncast_status or realtime_services.get_owncast_public_status
        self.captures = {}
        self._next_start = {}
        self._last_heartbeat = {}
        self._next_sweep = 0.0
        self.finalizer = (
            FinalizeWorker(
                self.finalize_recording,
                maxsize=config.finalize_queue_size(),
                should_run=should_finalize,
            )
            if background_finalize
            else None
        )

    # ------------------------------------------------------------------ loop
    def tick(self):
        close_old_connections()
        self.capture_active()
        self.finalize_pending()
        self.publish_processing()
        self.process_file_deletions()
        self._stop_orphan_captures()
        if self._recording_ids is None:
            self.sweep_if_due()

    def shutdown(self):
        for recording_id in list(self.captures):
            self._stop_capture(recording_id, reason="recorder_shutdown")
        if self.finalizer is not None:
            # A finalize cut short stays FINALIZING and is redone (idempotently)
            # by the next recorder.
            self.finalizer.stop(timeout=5.0)
        if self.hls_filter is not None:
            self.hls_filter.stop()

    def _scoped(self, queryset):
        if self._recording_ids is None:
            return queryset
        return queryset.filter(pk__in=self._recording_ids)

    # --------------------------------------------------------------- capture
    def capture_active(self):
        status_cache = {}

        def owncast():
            if "value" not in status_cache:
                status_cache["value"] = self._owncast_status(force_refresh=True) or {}
            return status_cache["value"]

        recordings = self._scoped(
            R.objects.filter(source=R.SOURCE_SERVER, state=R.STATE_RECORDING).select_related("session")
        )
        for recording in recordings:
            capture = self.captures.get(recording.pk)
            if capture is not None and capture.process.poll() is not None:
                self._close_capture(recording.pk, capture, reason="ffmpeg_exited")
                capture = None
            if capture is not None and self._is_new_obs_connection(capture, owncast()):
                # OBS reconnected: Owncast restarted its playlist, so cut a new part.
                self._stop_capture(recording.pk, reason="obs_reconnected")
                self._next_start.pop(recording.pk, None)
                capture = None

            stop_reason = self._finalize_reason(recording)
            if stop_reason:
                self._stop_capture(recording.pk, reason=stop_reason)
                self._forget_filter_state(recording.pk)
                state.transition(
                    recording, R.STATE_FINALIZING, reason=stop_reason, stop_requested_at=timezone.now()
                )
                continue

            pause_reason = self._pause_reason(recording)
            if pause_reason:
                if capture is not None:
                    logger.warning(
                        "CLASS_RECORDING_PAUSED recording_id=%s reason=%s", recording.pk, pause_reason
                    )
                    self._stop_capture(recording.pk, reason=pause_reason)
                self._heartbeat(recording, note=f"Capture paused: {pause_reason}")
                continue

            if capture is None and self._monotonic() >= self._next_start.get(recording.pk, 0):
                status = owncast()
                if status.get("online"):
                    self._start_capture(recording, connect_marker=str(status.get("lastConnectTime") or ""))
            self._heartbeat(recording)

    @staticmethod
    def _is_new_obs_connection(capture, status):
        marker = str(status.get("lastConnectTime") or "")
        return bool(status.get("online") and marker and capture.connect_marker and marker != capture.connect_marker)

    def _finalize_reason(self, recording):
        session = recording.session
        if session is None or session.status == session.STATUS_ENDED:
            return "session_ended"
        started_at = recording.started_at or recording.created_at
        if started_at and (timezone.now() - started_at).total_seconds() > config.max_duration_seconds():
            return "max_duration_reached"
        return ""

    def _pause_reason(self, recording):
        if captured_bytes(recording.work_dir) >= config.max_capture_bytes():
            return "size_cap_reached"
        free = publisher.free_disk_bytes(recording.work_dir or config.work_root())
        if free is not None and free < config.min_free_bytes():
            return "low_disk_space"
        return ""

    def _capture_input(self, recording, connect_marker=""):
        """(url, proxy token) for ffmpeg's ``-i``; a token means "via the filter".

        Through the playlist filter when enabled (the default); straight from
        Owncast if it is disabled or cannot start (logged; a recording with a
        possible offline clip beats no recording).
        """
        source = config.source_url()
        if not config.hls_filter_enabled():
            return source, ""
        try:
            if self.hls_filter is None:
                self.hls_filter = hls_proxy.HlsFilterProxy()
            token, url = self.hls_filter.register(source, key=recording.pk, epoch=connect_marker)
        except (OSError, ValueError) as exc:
            logger.error(
                "CLASS_RECORDING_HLS_FILTER_UNAVAILABLE recording_id=%s error=%s (capturing Owncast directly)",
                recording.pk,
                exc,
            )
            return source, ""
        return url, token

    def _forget_filter_state(self, recording_id):
        if self.hls_filter is not None:
            self.hls_filter.forget(recording_id)

    def _start_capture(self, recording, connect_marker=""):
        work_dir = Path(recording.work_dir or (config.work_root() / f"class-recording-{recording.pk}"))
        work_dir.mkdir(parents=True, exist_ok=True)
        part_number = len(list(work_dir.glob(PART_GLOB))) + 1
        part_path = work_dir / f"part-{part_number:04d}.ts"
        source, token = self._capture_input(recording, connect_marker)
        log_handle = open(work_dir / f"part-{part_number:04d}.log", "ab")  # noqa: SIM115 - closed in _close_capture
        try:
            process = self._popen(
                ffmpeg.build_capture_command(source, part_path, via_filter=bool(token)),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=log_handle,
            )
        except OSError as exc:
            log_handle.close()
            if token and self.hls_filter is not None:
                self.hls_filter.release(token)
            self._next_start[recording.pk] = self._monotonic() + config.restart_backoff_seconds()
            logger.error("CLASS_RECORDING_CAPTURE_START_FAILED recording_id=%s error=%s", recording.pk, exc)
            return None
        self.captures[recording.pk] = Capture(
            process, part_path, self._monotonic(), log_handle, connect_marker, proxy_token=token
        )
        self._next_start[recording.pk] = self._monotonic() + config.restart_backoff_seconds()
        logger.info("CLASS_RECORDING_PART_STARTED recording_id=%s part=%s", recording.pk, part_path.name)
        return part_path

    def _close_capture(self, recording_id, capture, *, reason):
        self.captures.pop(recording_id, None)
        if capture.proxy_token and self.hls_filter is not None:
            self.hls_filter.release(capture.proxy_token)
        if capture.log_handle is not None:
            try:
                capture.log_handle.close()
            except OSError:
                pass
        logger.info(
            "CLASS_RECORDING_PART_CLOSED recording_id=%s part=%s exit=%s reason=%s",
            recording_id,
            capture.part_path.name,
            capture.process.poll(),
            reason,
        )

    def _stop_capture(self, recording_id, *, reason):
        capture = self.captures.get(recording_id)
        if capture is None:
            return
        process = capture.process
        if process.poll() is None:
            process.terminate()  # SIGTERM: ffmpeg flushes and closes the part
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        self._close_capture(recording_id, capture, reason=reason)

    def _stop_orphan_captures(self):
        if not self.captures:
            return
        still_recording = set(
            R.objects.filter(pk__in=list(self.captures), state=R.STATE_RECORDING).values_list("pk", flat=True)
        )
        for recording_id in list(self.captures):
            if recording_id not in still_recording:
                self._stop_capture(recording_id, reason="no_longer_recording")
                self._forget_filter_state(recording_id)

    def _heartbeat(self, recording, note=None):
        now = self._monotonic()
        if now - self._last_heartbeat.get(recording.pk, -1e9) < config.heartbeat_seconds():
            return
        self._last_heartbeat[recording.pk] = now
        parts = list_parts(recording.work_dir)
        updates = {
            "part_count": len(parts),
            "captured_bytes": sum(part.stat().st_size for part in parts),
            "recorder_heartbeat_at": timezone.now(),
            "updated_at": timezone.now(),
        }
        if note is not None:
            updates["error"] = note
        R.objects.filter(pk=recording.pk, state=R.STATE_RECORDING).update(**updates)

    # -------------------------------------------------------------- finalize
    def finalize_pending(self):
        """Hand FINALIZING rows to the finalizer (or finalize inline without one).

        Captures belong to this (main) thread, so they are stopped here before
        the finalize itself runs anywhere else.
        """
        for recording_id in self._scoped(R.objects.filter(state=R.STATE_FINALIZING)).values_list("pk", flat=True):
            self._stop_capture(recording_id, reason="finalizing")
            self._forget_filter_state(recording_id)
            if self.finalizer is None:
                self.finalize_recording(recording_id)
            else:
                self.finalizer.submit(recording_id)

    def finalize_recording(self, recording_id):
        recording = (
            R.objects.select_related("session", "session__target_module", "module", "module__course")
            .filter(pk=recording_id, state=R.STATE_FINALIZING)
            .first()
        )
        if recording is None:
            return
        try:
            if recording.source == R.SOURCE_SERVER:
                self._finalize_server(recording)
            elif recording.source == R.SOURCE_LIVEKIT_EGRESS:
                self._finalize_egress(recording)
            elif recording.source == R.SOURCE_IMPORTED:
                publisher.finalize_import(recording)
            elif is_pending_obs_remux(recording):
                publisher.finalize_obs_upload(recording)
            else:
                state.transition(
                    recording, R.STATE_PROCESSING if recording.lecture_id else R.STATE_FAILED,
                    error="" if recording.lecture_id else "Upload recording has no lecture.",
                    reason="upload_finalize",
                )
        except publisher.RecordingPublishError as exc:
            state.transition(recording, R.STATE_FAILED, error=str(exc), reason="finalize_failed")
        except Exception as exc:  # keep the loop alive; the row records why
            logger.exception("CLASS_RECORDING_FINALIZE_CRASH recording_id=%s", recording.pk)
            state.transition(recording, R.STATE_FAILED, error=f"Unexpected error: {exc}", reason="finalize_crash")

    def _finalize_server(self, recording):
        parts = list_parts(recording.work_dir)
        if not parts and not recording.lecture_id:
            state.transition(
                recording,
                R.STATE_FAILED,
                error="No video was captured. Was OBS streaming while the class was live? "
                "Upload the OBS recording instead.",
                reason="no_parts",
            )
            return
        work_dir = Path(recording.work_dir)
        publisher.finalize_into_lecture(recording, parts, list_path=work_dir / "concat.txt")
        if recording.state == R.STATE_PROCESSING:
            shutil.rmtree(work_dir, ignore_errors=True)

    def _finalize_egress(self, recording):
        if recording.lecture_id:
            publisher.finalize_into_lecture(recording, [], list_path=None)
            return
        source = realtime_services.resolve_recording_local_path(recording.source_path)
        if source is None or not self._file_settled(source):
            waited = (timezone.now() - (recording.stop_requested_at or recording.updated_at)).total_seconds()
            if waited > config.egress_wait_seconds():
                raise publisher.RecordingPublishError(
                    f"LiveKit egress output was not available after {int(waited)}s: {recording.source_path}"
                )
            return
        work_dir = config.work_root() / f"class-recording-{recording.pk}"
        work_dir.mkdir(parents=True, exist_ok=True)
        publisher.finalize_into_lecture(recording, [source], list_path=work_dir / "concat.txt")
        shutil.rmtree(work_dir, ignore_errors=True)

    def _file_settled(self, path):
        try:
            stat = Path(path).stat()
        except OSError:
            return False
        return stat.st_size > 0 and (time.time() - stat.st_mtime) >= config.file_settle_seconds()

    # --------------------------------------------------------------- publish
    def publish_processing(self):
        for recording in self._scoped(R.objects.filter(state=R.STATE_PROCESSING).exclude(lecture__isnull=True)):
            publisher.publish_if_ready(recording)
        # Self-heal: the transcoder retries failed lectures on its own. An OBS
        # upload still waiting for its remux points at the lecture it will
        # replace, whose *old* video may be ready: it is not healed.
        healed = self._scoped(
            R.objects.filter(
                state=R.STATE_FAILED,
                lecture__isnull=False,
                lecture__stream_status=Lecture.STREAM_READY,
            )
            .exclude(Q(source=R.SOURCE_OBS_UPLOAD) & ~Q(source_path=""))
        )
        for recording in healed:
            if state.transition(recording, R.STATE_PROCESSING, reason="transcode_recovered"):
                publisher.publish_if_ready(recording)

    # ------------------------------------------------------- admin deletes
    def process_file_deletions(self):
        """Delete files an admin asked to delete that the web tier cannot write."""
        pending = self._scoped(R.objects.filter(delete_requested_at__isnull=False)).select_related("lecture")
        for recording in pending:
            kinds = [kind for kind in recording.delete_requested_kinds.split(",") if kind]
            try:
                recording_services.delete_recording_files(
                    recording, kinds=kinds, confirm_published=True, allow_defer=False
                )
            except Exception as exc:  # recorded in the log; the request is not retried forever
                logger.error("CLASS_RECORDING_DELETE_FAILED recording_id=%s error=%s", recording.pk, exc)
            # Only this request is cleared; one queued meanwhile is handled next tick.
            R.objects.filter(pk=recording.pk, delete_requested_at=recording.delete_requested_at).update(
                delete_requested_kinds="", delete_requested_at=None
            )

    # ----------------------------------------------------------------- sweep
    def sweep_if_due(self):
        now = self._monotonic()
        if now < self._next_sweep:
            return
        self._next_sweep = now + config.sweep_interval_seconds()
        try:
            self.sweep_stale_files()
        except Exception:
            logger.exception("CLASS_RECORDING_SWEEP_CRASH")

    def sweep_stale_files(self):
        """Free disk held by recordings nobody can use any more.

        * FAILED recordings untouched for STREAM_RECORDER_FAILED_RETENTION_DAYS:
          their captured parts (server) or staged OBS upload are deleted. Within
          the window they are kept so a retry still works.
        * work dirs / staged uploads that no recording row owns (deleted rows),
          and work dirs of recordings whose parts were already turned into a
          lecture, once older than ORPHAN_GRACE_SECONDS.
        RECORDING / FINALIZING recordings are never touched.
        """
        retention_seconds = config.failed_retention_seconds()
        cutoff = timezone.now() - timedelta(seconds=retention_seconds)
        retention_days = retention_seconds // 86400
        swept = {"failed": 0, "orphan_dirs": 0, "orphan_uploads": 0}

        expired = R.objects.filter(state=R.STATE_FAILED, updated_at__lt=cutoff).filter(
            Q(source=R.SOURCE_SERVER) | (Q(source=R.SOURCE_OBS_UPLOAD) & ~Q(source_path=""))
        )
        for recording in expired:
            note = ""
            updates = {}
            if recording.source == R.SOURCE_SERVER:
                work_dir = Path(recording.work_dir) if recording.work_dir else None
                if work_dir is None or not work_dir.exists():
                    continue
                shutil.rmtree(work_dir, ignore_errors=True)
                note = f"Captured video deleted after {retention_days} days; upload the OBS recording instead."
            else:
                try:
                    publisher.staged_upload_path(recording).unlink(missing_ok=True)
                except Exception:
                    logger.warning("CLASS_RECORDING_SWEEP_UPLOAD_DELETE_FAILED recording_id=%s", recording.pk)
                # Nothing is left to swap in: detach it from the lecture it
                # would have replaced so it can never be retried or healed.
                updates.update(source_path="", lecture=None)
                note = f"Uploaded OBS file deleted after {retention_days} days; upload it again."
            error = f"{recording.error} {note}".strip() if note not in recording.error else recording.error
            # updated_at is left alone: the row keeps its age.
            R.objects.filter(pk=recording.pk, state=R.STATE_FAILED).update(error=error[:4000], **updates)
            swept["failed"] += 1
            logger.info("CLASS_RECORDING_SWEPT recording_id=%s source=%s", recording.pk, recording.source)

        grace_cutoff = time.time() - ORPHAN_GRACE_SECONDS
        work_root = config.work_root()
        if work_root.is_dir():
            candidates = {}
            for child in work_root.iterdir():
                match = WORK_DIR_PATTERN.match(child.name)
                if match and child.is_dir():
                    candidates[int(match.group(1))] = child
            if candidates:
                states = dict(R.objects.filter(pk__in=list(candidates)).values_list("pk", "state"))
                imported_dirs = {
                    _norm(path)
                    for path in R.objects.filter(source=R.SOURCE_IMPORTED)
                    .exclude(work_dir="")
                    .values_list("work_dir", flat=True)
                }
                for recording_id, directory in candidates.items():
                    if _norm(directory) in imported_dirs:
                        continue  # an imported recording owns these parts now
                    owner_state = states.get(recording_id)
                    if owner_state is not None and owner_state not in (R.STATE_PROCESSING, R.STATE_PUBLISHED):
                        continue  # live, finalizing, or failed within retention
                    if _mtime(directory) > grace_cutoff:
                        continue
                    shutil.rmtree(directory, ignore_errors=True)
                    swept["orphan_dirs"] += 1
                    logger.info("CLASS_RECORDING_WORK_DIR_SWEPT dir=%s owner_state=%s", directory, owner_state)

        staging_root = Path(settings.MEDIA_ROOT) / config.OBS_UPLOAD_STAGING_DIR
        if staging_root.is_dir():
            referenced = {
                Path(name).name
                for name in R.objects.filter(source__in=(R.SOURCE_OBS_UPLOAD, R.SOURCE_IMPORTED))
                .exclude(source_path="")
                .values_list("source_path", flat=True)
            }
            for item in staging_root.iterdir():
                if not item.is_file() or item.name in referenced or _mtime(item) > grace_cutoff:
                    continue
                item.unlink(missing_ok=True)
                swept["orphan_uploads"] += 1
                logger.info("CLASS_RECORDING_STAGED_UPLOAD_SWEPT file=%s", item.name)
        return swept


def _norm(path):
    return os.path.normcase(os.path.abspath(str(path)))


def _mtime(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return time.time()
