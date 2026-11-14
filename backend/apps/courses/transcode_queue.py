"""Lecture HLS transcode queue (``transcode_lecture_streams --pending``).

* **Claim**: one short transaction picks the next lecture with
  ``select_for_update(skip_locked=True)`` and stamps a claim lease, so several
  transcoders can run side by side and a crashed one never blocks a lecture
  for longer than the lease (its own restart releases its claims at once).
* **Order**: class recordings first (``stream_priority``), then due retries,
  then the oldest lecture.
* **Retry**: a failure is recorded with exponential backoff
  (COURSE_HLS_RETRY_BACKOFF_SECONDS) up to COURSE_HLS_MAX_ATTEMPTS; after that
  the lecture stays FAILED for good (``transcode_exhausted``) and an alert is
  raised. A failed lecture never re-runs every poll ahead of new work.
* **Blue/green**: ``transcode_lecture_to_hls`` writes ``v<revision>/`` and
  swaps the manifest atomically; ``gc_lecture_stream_revisions`` removes old
  revisions after COURSE_HLS_REVISION_GRACE_SECONDS.

Students are never blocked by this queue: a class recording's MP4 is playable
(and published) before its HLS exists.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import socket
import time
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from .models import Lecture
from .services import TranscodeSuperseded, VideoTranscodeError, lecture_stream_root, transcode_lecture_to_hls

logger = logging.getLogger("ops.realtime")

CLASS_RECORDING_PRIORITY = 10
HEARTBEAT_CACHE_KEY = "courses:transcoder:heartbeat"
REVISION_DIR = re.compile(r"^v\d+$")
LEGACY_RENDITION_DIRS = frozenset({"360p", "540p", "720p", "1080p", "source"})
LEGACY_ARTIFACT_SUFFIXES = frozenset({".m3u8", ".ts", ".m4s", ".mp4"})


def max_attempts():
    return max(1, int(getattr(settings, "COURSE_HLS_MAX_ATTEMPTS", 5) or 5))


def backoff_schedule():
    raw = str(getattr(settings, "COURSE_HLS_RETRY_BACKOFF_SECONDS", "") or "60,300,1800,7200")
    values = []
    for item in raw.split(","):
        try:
            values.append(max(1, int(item.strip())))
        except ValueError:
            continue
    return values or [60, 300, 1800, 7200]


def backoff_seconds(attempts):
    """Wait before attempt ``attempts + 1`` (attempts already made >= 1)."""
    schedule = backoff_schedule()
    return schedule[min(max(1, int(attempts or 1)), len(schedule)) - 1]


def claim_lease_seconds():
    cap = int(getattr(settings, "COURSE_HLS_TRANSCODE_MAX_TIMEOUT_SECONDS", 6 * 3600) or 6 * 3600)
    return max(600, cap) + 600


def revision_grace_seconds():
    return max(0, int(getattr(settings, "COURSE_HLS_REVISION_GRACE_SECONDS", 86400) or 0))


def transcode_retry_pending(lecture):
    """FAILED, but the queue will try again (the MP4 keeps playing meanwhile)."""
    return lecture.stream_status == Lecture.STREAM_FAILED and int(lecture.stream_attempts or 0) < max_attempts()


def transcode_exhausted(lecture):
    return lecture.stream_status == Lecture.STREAM_FAILED and int(lecture.stream_attempts or 0) >= max_attempts()


def worker_identity():
    return f"{socket.gethostname()}:{os.getpid()}"[:128]


def _due(now):
    return Q(stream_next_attempt_at__isnull=True) | Q(stream_next_attempt_at__lte=now)


def pending_queryset(now=None):
    """Lectures a transcoder may claim right now."""
    now = now or timezone.now()
    stale = now - timedelta(seconds=claim_lease_seconds())
    eligible = (
        (Q(stream_status__in=[Lecture.STREAM_PENDING, Lecture.STREAM_UPLOADED]) & _due(now))
        | (Q(stream_status=Lecture.STREAM_FAILED, stream_attempts__lt=max_attempts()) & _due(now))
        | (Q(stream_status=Lecture.STREAM_PROCESSING) & (Q(stream_claimed_at__isnull=True) | Q(stream_claimed_at__lt=stale)))
    )
    return Lecture.objects.filter(video_file__isnull=False).exclude(video_file="").filter(eligible)


def claim_next(*, worker=None, now=None):
    """Claim the next lecture (or None). Safe with any number of transcoders."""
    now = now or timezone.now()
    worker = worker or worker_identity()
    with transaction.atomic():
        row = (
            pending_queryset(now)
            .select_for_update(skip_locked=True)
            .order_by("-stream_priority", F("stream_next_attempt_at").asc(nulls_first=True), "pk")
            .values("pk")
            .first()
        )
        if row is None:
            return None
        Lecture.objects.filter(pk=row["pk"]).update(
            stream_status=Lecture.STREAM_PROCESSING,
            stream_error="",
            stream_claimed_at=now,
            stream_claimed_by=worker,
            stream_attempts=F("stream_attempts") + 1,
        )
    return Lecture.objects.select_related("section__course").get(pk=row["pk"])


def release_own_stale_claims(*, host=None):
    """On start: lectures this host was transcoding when it died go back to the queue."""
    host = host or socket.gethostname()
    released = Lecture.objects.filter(
        stream_status=Lecture.STREAM_PROCESSING, stream_claimed_by__startswith=f"{host}:"
    ).update(stream_status=Lecture.STREAM_UPLOADED, stream_claimed_at=None, stream_claimed_by="")
    if released:
        logger.warning("LECTURE_TRANSCODE_CLAIMS_RELEASED host=%s count=%s", host, released)
    return released


def mark_transcode_failed(lecture, message, *, now=None):
    """Record a failed attempt: FAILED with the next retry time, or for good."""
    now = now or timezone.now()
    current = Lecture.objects.filter(pk=lecture.pk).values("stream_attempts").first()
    attempts = max(1, int((current or {}).get("stream_attempts") or 0))
    exhausted = attempts >= max_attempts()
    next_attempt = None if exhausted else now + timedelta(seconds=backoff_seconds(attempts))
    Lecture.objects.filter(pk=lecture.pk).exclude(stream_status=Lecture.STREAM_READY).update(
        stream_status=Lecture.STREAM_FAILED,
        stream_error=str(message or "Transcode failed.")[:4000],
        stream_attempts=attempts,
        stream_next_attempt_at=next_attempt,
        stream_claimed_at=None,
        stream_claimed_by="",
        updated_at=now,
    )
    # A forced rebuild of a ready lecture keeps its stream; only the claim goes.
    Lecture.objects.filter(pk=lecture.pk, stream_status=Lecture.STREAM_READY).update(
        stream_claimed_at=None, stream_claimed_by=""
    )
    lecture.stream_attempts = attempts
    lecture.stream_next_attempt_at = next_attempt
    log = logger.error if exhausted else logger.warning
    log(
        "LECTURE_TRANSCODE_FAILED lecture_id=%s attempt=%s/%s next_attempt_at=%s error=%s",
        lecture.pk,
        attempts,
        max_attempts(),
        next_attempt.isoformat() if next_attempt else "never",
        str(message or "")[:300],
    )
    if exhausted:
        _alert_exhausted(lecture, message)
    return next_attempt


def _alert_exhausted(lecture, message):
    try:
        from apps.realtime.recording import alerts

        alerts.lecture_transcode_exhausted(lecture, message)
    except Exception:  # alerting must never break the transcoder
        logger.exception("LECTURE_TRANSCODE_ALERT_FAILED lecture_id=%s", lecture.pk)


def requeue(lecture, *, reset_attempts=True):
    """Admin "retry now": back to the front of the queue (a ready stream is kept)."""
    updates = {"stream_next_attempt_at": None, "stream_claimed_at": None, "stream_claimed_by": ""}
    if reset_attempts:
        updates["stream_attempts"] = 0
    Lecture.objects.filter(pk=lecture.pk).update(**updates)
    Lecture.objects.filter(pk=lecture.pk, stream_status=Lecture.STREAM_FAILED).update(
        stream_status=Lecture.STREAM_UPLOADED, stream_error=""
    )


def process_next(*, worker=None, runner=None, now=None):
    """Claim and transcode one lecture. Returns (outcome, lecture_id) or None when idle.

    outcome: "ready" | "failed" | "superseded"
    """
    lecture = claim_next(worker=worker, now=now)
    if lecture is None:
        return None
    started = time.monotonic()
    try:
        transcode_lecture_to_hls(lecture, runner=runner)
    except TranscodeSuperseded:
        Lecture.objects.filter(pk=lecture.pk).update(stream_claimed_at=None, stream_claimed_by="")
        Lecture.objects.filter(pk=lecture.pk, stream_status=Lecture.STREAM_PROCESSING).update(
            stream_status=Lecture.STREAM_UPLOADED
        )
        return "superseded", lecture.pk
    except VideoTranscodeError:
        return "failed", lecture.pk  # recorded (with its retry time) by the transcode itself
    except Exception as exc:  # never kill the loop; the lecture records why
        logger.exception("LECTURE_TRANSCODE_CRASH lecture_id=%s", lecture.pk)
        mark_transcode_failed(lecture, f"Unexpected error: {exc}")
        return "failed", lecture.pk
    logger.info(
        "LECTURE_TRANSCODE_READY lecture_id=%s seconds=%.1f manifest=%s",
        lecture.pk,
        time.monotonic() - started,
        lecture.stream_manifest_key,
    )
    return "ready", lecture.pk


# --------------------------------------------------------------- cleanup


def _age_seconds(path, now):
    try:
        return now - path.stat().st_mtime
    except OSError:
        return 0


def _stale_entries(stream_dir, current_rel, *, grace, now):
    """Entries of a lecture's stream dir that the current manifest does not use."""
    current_parts = Path(current_rel).parts if current_rel else ()
    current_dir = Path(*current_parts[:-1]) if len(current_parts) > 1 else None
    if current_dir is None or not REVISION_DIR.match(current_dir.name):
        return []  # still on the legacy layout (or no stream): nothing is stale yet
    stale = []
    try:
        entries = list(stream_dir.iterdir())
    except OSError:
        return []
    for entry in entries:
        if entry.is_symlink():
            continue
        if entry.name == current_dir.name:
            continue
        old_revision = entry.is_dir() and REVISION_DIR.match(entry.name)
        legacy_dir = entry.is_dir() and entry.name in LEGACY_RENDITION_DIRS
        legacy_file = entry.is_file() and entry.suffix.lower() in LEGACY_ARTIFACT_SUFFIXES
        if not (old_revision or legacy_dir or legacy_file):
            continue
        if _age_seconds(entry, now) < grace:
            continue
        stale.append(entry)
    return stale


def _remove(entry):
    if entry.is_dir():
        shutil.rmtree(entry, ignore_errors=True)
    else:
        entry.unlink(missing_ok=True)


def gc_lecture_stream_revisions(lecture, *, grace=None, now=None):
    """Delete this lecture's HLS revisions older than the grace period."""
    grace = revision_grace_seconds() if grace is None else grace
    now = now or time.time()
    stream_dir = Path(settings.MEDIA_ROOT) / lecture_stream_root(lecture)
    if not stream_dir.is_dir():
        return 0
    removed = 0
    for entry in _stale_entries(stream_dir, lecture.stream_manifest_key, grace=grace, now=now):
        _remove(entry)
        removed += 1
    return removed


def gc_stale_stream_revisions(*, grace=None, now=None, limit=500):
    """Periodic sweep over ready lectures on the blue/green layout."""
    removed = 0
    queryset = (
        Lecture.objects.filter(stream_status=Lecture.STREAM_READY, stream_revision__gt=0)
        .select_related("section__course")
        .only("pk", "stream_manifest_key", "section__course__slug")
        .order_by("pk")[:limit]
    )
    for lecture in queryset:
        try:
            removed += gc_lecture_stream_revisions(lecture, grace=grace, now=now)
        except Exception:  # one bad directory must not stop the sweep
            logger.exception("LECTURE_STREAM_GC_FAILED lecture_id=%s", lecture.pk)
    if removed:
        logger.info("LECTURE_STREAM_GC removed=%s", removed)
    return removed


def touch_heartbeat():
    now = time.time()
    try:
        cache.set(HEARTBEAT_CACHE_KEY, now, timeout=3600)
    except Exception:
        pass
    path = str(getattr(settings, "TRANSCODER_HEARTBEAT_FILE", "") or "").strip()
    if path:
        try:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(str(int(now)), encoding="utf-8")
        except OSError:
            pass
    return now
