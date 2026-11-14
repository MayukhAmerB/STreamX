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
4. sweep    - hourly: staged OBS uploads of FAILED recordings past
               STREAM_RECORDER_FAILED_RETENTION_DAYS, and work dirs or staged
               uploads that no recording row owns any more. Captured parts of
               a class that never reached a lecture are never swept.

Phase 2 (no-click recordings):
* every broadcast whose stream is live gets a take automatically (no Start
  Recording button; RECORDING_AUTO_ALL_BROADCASTS);
* one take per class: Stop only pauses the take for
  STREAM_RECORDER_STOP_GRACE_SECONDS, and a feed that has been offline for
  STREAM_RECORDER_IDLE_FINALIZE_SECONDS finalizes it (no 6 h wait);
* browser-fallback uploads and the periodic import scan join the same
  finalize path; a nightly canary runs ``verify_recording_pipeline``.

The recorder is a viewer of Owncast's HLS output and never talks to OBS or the
ingest, so a crash here cannot interrupt the live class.
"""

import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.core.cache import cache
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
LAST_TICK_CACHE_KEY = "recording:recorder:last_tick"
CANARY_RESULT_CACHE_KEY = "recording:canary:last_result"
CANARY_MAX_SECONDS = 30 * 60
AUTO_START_INTERVAL_SECONDS = 4


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
        canary_popen=subprocess.Popen,
        service_duties=False,
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
        self._next_import_scan = monotonic() + 300  # let the service settle first
        self._next_auto_start = 0.0
        self._canary_popen = canary_popen
        # The periodic import scan and the nightly canary belong to the
        # long-running service only (run_stream_recorder), never to a one-off
        # tick, the verification command or a test.
        self._service_duties = bool(service_duties)
        self._canary = None  # (process, started_monotonic, day_key, log_path)
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
            if self._service_duties:
                self.import_scan_if_due()
                self.canary_if_due()
            try:
                cache.set(LAST_TICK_CACHE_KEY, time.time(), timeout=3600)
            except Exception:  # metrics only
                pass

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

        if self._recording_ids is None and self._monotonic() >= self._next_auto_start:
            self._next_auto_start = self._monotonic() + AUTO_START_INTERVAL_SECONDS
            try:
                self.ensure_live_broadcasts_recorded()
            except Exception:  # never let the auto-start stop the capture loop
                logger.exception("CLASS_RECORDING_AUTO_START_FAILED")

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

            stop_reason = self._finalize_reason(recording, owncast, capturing=capture is not None)
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
                    if self._start_capture(recording, connect_marker=str(status.get("lastConnectTime") or "")):
                        self._mark_media(recording)
            self._heartbeat(recording, media=recording.pk in self.captures)

    @staticmethod
    def _is_new_obs_connection(capture, status):
        marker = str(status.get("lastConnectTime") or "")
        return bool(status.get("online") and marker and capture.connect_marker and marker != capture.connect_marker)

    def _finalize_reason(self, recording, owncast=None, *, capturing=False):
        session = recording.session
        if session is None or session.status == session.STATUS_ENDED:
            return "session_ended"
        now = timezone.now()
        started_at = recording.started_at or recording.created_at
        if started_at and (now - started_at).total_seconds() > config.max_duration_seconds():
            return "max_duration_reached"
        if recording.stop_requested_at is not None:
            if (now - recording.stop_requested_at).total_seconds() >= config.stop_grace_seconds():
                return "stream_stopped"
            return ""
        if capturing:
            return ""
        # Idle finalize: the feed has been gone long enough that the class is over.
        last_media = recording.last_media_at
        if last_media is None and list_parts(recording.work_dir):
            last_media = recording.recorder_heartbeat_at or started_at
        if last_media is None:
            return ""  # nothing captured yet: wait for the class (or for its end)
        if (now - last_media).total_seconds() < config.idle_finalize_seconds():
            return ""
        status = owncast() if owncast is not None else {}
        if status.get("online"):
            return ""
        return "feed_offline_timeout"

    def _pause_reason(self, recording):
        if recording.stop_requested_at is not None:
            return "stop_requested"
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

    def _heartbeat(self, recording, note=None, *, media=False):
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
        elif recording.error.startswith("Capture paused:"):
            updates["error"] = ""
        if media:
            updates["last_media_at"] = timezone.now()
        R.objects.filter(pk=recording.pk, state=R.STATE_RECORDING).update(**updates)

    def _mark_media(self, recording):
        now = timezone.now()
        recording.last_media_at = now
        R.objects.filter(pk=recording.pk, state=R.STATE_RECORDING).update(last_media_at=now)

    # ------------------------------------------------------ auto start
    def ensure_live_broadcasts_recorded(self):
        """Every broadcast whose stream is live gets a take (no button).

        Owncast carries one feed, so the broadcast that most recently
        entered "live" is recorded (``updated_at``: every stream transition
        writes it), not the one created last. A Host Studio session only
        counts while it really feeds Owncast (an egress id and a fresh host
        heartbeat): a studio tab closed without End can stay "live" in shadow
        mode and must not capture the real class's feed into its own take.
        A capture belonging to another session that is still streaming is
        left alone (ambiguous; the explicit start path or the live
        reconciler decides); one whose session stopped streaming is
        superseded.
        """
        if not config.recorder_enabled():
            return None
        from ..models import RealtimeSession

        live = [
            session
            for session in RealtimeSession.objects.filter(
                session_type=RealtimeSession.TYPE_BROADCASTING,
                stream_status=RealtimeSession.STREAM_LIVE,
            )
            .exclude(status=RealtimeSession.STATUS_ENDED)
            .select_related("target_module", "linked_live_class")
            .order_by("-updated_at", "-pk")[:5]
            if recording_services.is_recordable_broadcast(session) and _feeds_owncast(session)
        ]
        if not live:
            return None
        target = live[0]
        capturing = list(R.objects.filter(source=R.SOURCE_SERVER, state=R.STATE_RECORDING).values_list(
            "session_id", "stop_requested_at"
        ))
        own = [stop for session_id, stop in capturing if session_id == target.pk]
        if own and own[0] is None:
            return None  # already recording this class
        live_ids = {session.pk for session in live}
        if any(session_id != target.pk and session_id in live_ids for session_id, _stop in capturing):
            return None
        recording = recording_services.ensure_server_recording(target)
        if recording is not None and not own:
            logger.info(
                "CLASS_RECORDING_AUTO_STARTED recording_id=%s session_id=%s stream_service=%s",
                recording.pk,
                target.pk,
                target.stream_service,
            )
        return recording

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
            elif recording.source == R.SOURCE_BROWSER_FALLBACK:
                publisher.finalize_browser_fallback(recording)
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

        # Captured parts of a class that never became a lecture are the only
        # copy of that class: they are never swept (an alert asks for action).
        expired = R.objects.filter(state=R.STATE_FAILED, updated_at__lt=cutoff).filter(
            (Q(source=R.SOURCE_SERVER) & Q(lecture__isnull=False))
            | (Q(source=R.SOURCE_OBS_UPLOAD) & ~Q(source_path=""))
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


    # ---------------------------------------------------------- import scan
    def import_scan_if_due(self):
        interval = config.import_scan_interval_seconds()
        if interval <= 0:
            return None
        now = self._monotonic()
        if now < self._next_import_scan:
            return None
        self._next_import_scan = now + interval
        try:
            return self.run_import_scan()
        except Exception:
            logger.exception("CLASS_RECORDING_IMPORT_SCAN_CRASH")
            return None

    def run_import_scan(self):
        """List unlinked videos (as the admin "Scan" does) and publish the safe ones.

        Only files of a class that has no recording lecture at all, linked to
        its LiveKit recording and written within RECORDING_RECONCILE_LOOKBACK
        are published automatically; everything else stays "imported" for an
        admin, so deliberately deleted lectures never come back.
        """
        from . import importer

        report = importer.scan_existing_recordings(probe=True, probe_budget_seconds=30, limit=50)
        published = 0
        if config.import_auto_publish():
            cutoff = timezone.now() - timedelta(seconds=config.reconcile_lookback_seconds())
            rows = R.objects.filter(
                pk__in=[pk for pk in report.created if isinstance(pk, int)],
                state=R.STATE_IMPORTED,
                session__isnull=False,
                livekit_recording__isnull=False,
                started_at__gte=cutoff,
            ).select_related("session")
            for row in rows:
                has_lecture = (
                    R.objects.filter(session_id=row.session_id, lecture__isnull=False).exclude(pk=row.pk).exists()
                )
                if has_lecture:
                    continue
                if state.transition(row, R.STATE_FINALIZING, reason="import_auto_publish"):
                    published += 1
        if report.created or published:
            logger.info(
                "CLASS_RECORDING_IMPORT_SCAN created=%s auto_published=%s summary=%s",
                len(report.created),
                published,
                report.summary(),
            )
        return {"created": len(report.created), "auto_published": published}

    # ---------------------------------------------------------------- canary
    def canary_if_due(self, *, now=None):
        """Nightly ``verify_recording_pipeline`` in a subprocess (own settings,
        own temp dirs, rolled-back rows); alert on failure."""
        if self._canary is not None:
            return self._poll_canary()
        if not config.canary_enabled():
            return None
        local = timezone.localtime(now or timezone.now())
        if local.hour != config.canary_hour():
            return None
        day_key = local.date().isoformat()
        if R.objects.filter(state__in=R.ACTIVE_STATES).exists():
            return None  # a class is being recorded or saved: try again later this hour
        try:
            if not cache.add(f"recording:canary:started:{day_key}", 1, timeout=2 * 86400):
                return None
        except Exception:
            return None
        log_path = config.work_root() / f"canary-{day_key}.log"
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            handle = open(log_path, "wb")  # noqa: SIM115 - closed when the canary ends
            process = self._canary_popen(
                [sys.executable, str(Path(settings.BASE_DIR) / "manage.py"), "verify_recording_pipeline"],
                stdin=subprocess.DEVNULL,
                stdout=handle,
                stderr=subprocess.STDOUT,
                cwd=str(settings.BASE_DIR),
                env=canary_environment(),
            )
        except OSError as exc:
            logger.error("CLASS_RECORDING_CANARY_START_FAILED error=%s", exc)
            return None
        self._canary = (process, self._monotonic(), day_key, log_path, handle)
        logger.info("CLASS_RECORDING_CANARY_STARTED day=%s log=%s", day_key, log_path)
        return "started"

    def _poll_canary(self):
        process, started, day_key, log_path, handle = self._canary
        code = process.poll()
        if code is None:
            if self._monotonic() - started < CANARY_MAX_SECONDS:
                return "running"
            process.kill()
            code = "timeout"
        self._canary = None
        try:
            handle.close()
        except OSError:
            pass
        ok = code == 0
        tail = ""
        try:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-1500:]
        except OSError:
            pass
        try:
            cache.set(CANARY_RESULT_CACHE_KEY, {"ok": ok, "at": time.time(), "day": day_key}, timeout=8 * 86400)
        except Exception:
            pass
        if ok:
            logger.info("CLASS_RECORDING_CANARY_PASSED day=%s", day_key)
            return "passed"
        logger.error("CLASS_RECORDING_CANARY_FAILED day=%s exit=%s", day_key, code)
        from . import alerts

        alerts.canary_failed(f"exit {code}. {tail}", day_key)
        return "failed"


_PGBOUNCER_HOST = re.compile(r"@pgbouncer(:\d+)?/")


def canary_environment(environ=None):
    """Environment for the nightly ``verify_recording_pipeline`` subprocess.

    The canary holds ONE rolled-back transaction across real ffmpeg work for
    minutes. Through PgBouncer (transaction pooling) that pins a pooled server
    connection for the whole run, and the role's statement / idle-in-transaction
    timeouts (infra/hostinger/apply-db-role-timeouts.sh) would cancel it: a false
    "canary failed" every night. Like backend/migrate.sh, it therefore connects
    DIRECTLY to PostgreSQL (RECORDING_CANARY_DATABASE_URL, else
    DATABASE_MIGRATE_URL, else DATABASE_URL with the ``@pgbouncer`` host rewritten
    to ``@postgres:5432``), where the libpq options below override the role
    defaults. ``verification._lift_db_timeouts_for_this_transaction`` also lifts
    them with SET LOCAL, so a URL that still goes through a pooler works too.
    """
    env = dict(os.environ if environ is None else environ)
    url = env.get("RECORDING_CANARY_DATABASE_URL") or env.get("DATABASE_MIGRATE_URL") or env.get("DATABASE_URL") or ""
    direct = _PGBOUNCER_HOST.sub("@postgres:5432/", url)
    if direct:
        env["DATABASE_URL"] = direct
    if "@pgbouncer" not in direct:
        env["DATABASE_BEHIND_POOLER"] = "0"
    env["DATABASE_STATEMENT_TIMEOUT_MS"] = "0"
    env["DATABASE_IDLE_IN_TX_TIMEOUT_MS"] = "0"
    # The connection lives for one run; never keep it for reuse.
    env["DATABASE_CONN_MAX_AGE"] = "0"
    return env


def _feeds_owncast(session):
    """Could this live broadcast be the feed Owncast is carrying right now?

    OBS publishes to Owncast directly. A Host Studio broadcast reaches it only
    through its LiveKit egress while the host's studio is open.
    """
    if session.stream_service == session.STREAM_SERVICE_OBS:
        return True
    if not str(session.livekit_egress_id or "").strip():
        return False
    from .. import lifecycle

    return lifecycle.read_host_heartbeat(session.pk) is not None


def _norm(path):
    return os.path.normcase(os.path.abspath(str(path)))


def _mtime(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return time.time()
