"""Find class videos that are already on the server and list them for import.

``scan_existing_recordings`` walks the folders recordings have ever been
written to and creates one ``imported`` ClassRecording (no module yet) per
video that no lecture or class recording uses:

* ``MEDIA_ROOT/lecture_videos``       class-recording MP4s whose lecture was deleted
* ``MEDIA_ROOT/realtime_recordings``  browser (fallback) recordings of Host Studio
* ``MEDIA_ROOT/class-recording-uploads`` OBS uploads whose recording row is gone
* ``LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT`` (``/recordings``) LiveKit egress outputs
* ``STREAM_RECORDER_WORK_DIR`` capture folders (``class-recording-<id>``) whose
  recording row was deleted; such a folder becomes one recording (its parts
  are concatenated when it is published)

The scan never changes or deletes a file. It is idempotent: a file is
recognised by path, and its size and mtime are refreshed while it is still
unassigned. Symlinks are never followed (so nothing outside these folders is
reached), hidden/partial/temporary files and files modified within
``min_age_seconds`` (possibly still being written) are skipped, and the walk
streams directory entries instead of building whole listings.
"""

import logging
import os
import shutil
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone as dt_timezone
from pathlib import Path

from django.conf import settings
from django.db import IntegrityError, transaction

from apps.courses.models import Lecture, Section

from ..models import RealtimeSessionRecording
from . import config, ffmpeg
from .models import ClassRecording

logger = logging.getLogger("ops.realtime")
R = ClassRecording

VIDEO_SUFFIXES = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm", ".flv"})
TEMP_SUFFIXES = (".part", ".partial", ".tmp", ".temp", ".crdownload", ".download", ".swp", ".concat.txt")
SKIP_DIR_NAMES = frozenset({"streams", "hls", "lost+found", "__pycache__"})
WORK_DIR_PREFIX = "class-recording-"
DEFAULT_MIN_AGE_SECONDS = 600
MAX_DEPTH = 16
PROBE_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class ScanRoot:
    label: str
    path: Path
    kind: str = "files"  # "files" or "workdirs"
    allow_ts: bool = False


@dataclass
class ScanReport:
    roots: list = field(default_factory=list)  # (label, path, exists)
    files_seen: int = 0
    created: list = field(default_factory=list)  # ClassRecording ids (or paths on a dry run)
    updated: list = field(default_factory=list)
    unchanged: int = 0
    linked: int = 0
    skipped: Counter = field(default_factory=Counter)
    probe_available: bool = False
    truncated: bool = False
    dry_run: bool = False

    def summary(self):
        parts = [
            f"{len(self.created)} new",
            f"{len(self.updated)} updated",
            f"{self.unchanged} already listed",
            f"{self.linked} in use by lectures/recordings",
        ]
        skipped = sum(self.skipped.values())
        if skipped:
            parts.append(f"{skipped} skipped ({', '.join(f'{n} {r}' for r, n in sorted(self.skipped.items()))})")
        text = f"Scanned {self.files_seen} video file(s): " + ", ".join(parts) + "."
        if self.truncated:
            text += " Stopped at the per-run limit; run the scan again to list the rest."
        if not self.probe_available:
            text += " ffprobe is not available here, so durations are blank."
        return text


def _norm(path):
    return os.path.normcase(os.path.abspath(str(path)))


def _resolved(path):
    try:
        return Path(path).expanduser().resolve()
    except (OSError, RuntimeError):
        return Path(os.path.abspath(str(path)))


def media_root():
    return _resolved(settings.MEDIA_ROOT)


def livekit_root():
    raw = str(getattr(settings, "LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT", "") or "/recordings")
    root = Path(raw).expanduser()
    if not root.is_absolute():
        root = Path.cwd() / root
    return _resolved(root)


def scan_roots():
    media = media_root()
    roots = [
        ScanRoot("Lecture videos", media / "lecture_videos"),
        ScanRoot("Host Studio browser recordings", media / "realtime_recordings"),
        ScanRoot("Staged OBS uploads", media / config.OBS_UPLOAD_STAGING_DIR, allow_ts=True),
        ScanRoot("LiveKit egress outputs", livekit_root()),
        ScanRoot("Recorder work folders", _resolved(config.work_root()), kind="workdirs"),
    ]
    unique, seen = [], set()
    for root in roots:
        key = (_norm(root.path), root.kind)
        if key not in seen:
            seen.add(key)
            unique.append(root)
    return unique


def is_within_import_roots(path):
    """True if ``path`` is inside one of the folders the scan may import from."""
    target = _norm(_resolved(path))
    for root in scan_roots():
        base = _norm(root.path)
        if target == base or target.startswith(base.rstrip(os.sep) + os.sep):
            return True
    return False


def _skip_reason(name, stat, *, now, min_age_seconds):
    lower = name.lower()
    if name.startswith(".") or name.endswith("~") or lower.endswith(TEMP_SUFFIXES):
        return "temporary/partial"
    if stat.st_size <= 0:
        return "empty"
    if now - stat.st_mtime < min_age_seconds:
        return "recently modified"
    return ""


def _walk_files(root, *, skip_dirs, work_dir_parents=frozenset()):
    """Yield (path, stat) for regular files under ``root``; symlinks are never followed.

    ``skip_dirs`` (other scan roots) and ``class-recording-*`` folders directly
    under ``work_dir_parents`` (scanned as whole recordings) are not entered.
    """
    stack = [(root, 0)]
    while stack:
        directory, depth = stack.pop()
        try:
            iterator = os.scandir(directory)
        except OSError:
            continue
        with iterator:
            for entry in iterator:
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        if entry.name.startswith(".") or entry.name in SKIP_DIR_NAMES or depth >= MAX_DEPTH:
                            continue
                        child = Path(entry.path)
                        if _norm(child) in skip_dirs:
                            continue
                        if entry.name.startswith(WORK_DIR_PREFIX) and _norm(directory) in work_dir_parents:
                            continue
                        stack.append((child, depth + 1))
                    elif entry.is_file(follow_symlinks=False):
                        yield Path(entry.path), entry.stat(follow_symlinks=False)
                except OSError:
                    continue


def _work_dir_parts(directory):
    parts = []
    try:
        iterator = os.scandir(directory)
    except OSError:
        return parts
    with iterator:
        for entry in iterator:
            try:
                if (
                    entry.name.startswith("part-")
                    and entry.name.endswith(".ts")
                    and not entry.is_symlink()
                    and entry.is_file(follow_symlinks=False)
                ):
                    stat = entry.stat(follow_symlinks=False)
                    if stat.st_size > 0:
                        parts.append((Path(entry.path), stat))
            except OSError:
                continue
    return sorted(parts)


class _Index:
    """Everything the database already knows about files on disk."""

    def __init__(self):
        media = media_root()
        live = livekit_root()
        self.linked_files = set()
        self.linked_dirs = set()
        self.imported_files = {}
        self.imported_dirs = {}
        self.recording_ids = set()
        for name, key in Lecture.objects.values_list("video_file", "video_key").iterator():
            if name:
                self.linked_files.add(_norm(media / name))
            if key and not str(key).startswith(("http://", "https://")):
                self.linked_files.add(_norm(media / str(key).lstrip("/")))
        rows = R.objects.values_list("pk", "source", "source_path", "work_dir").iterator()
        for pk, source, source_path, work_dir in rows:
            self.recording_ids.add(pk)
            if source_path:
                path = Path(source_path)
                candidates = [path] if path.is_absolute() else [media / source_path, live / source_path]
                for candidate in candidates:
                    self.linked_files.add(_norm(candidate))
                    if source == R.SOURCE_IMPORTED:
                        self.imported_files[_norm(candidate)] = pk
            if work_dir:
                self.linked_dirs.add(_norm(work_dir))
                if source == R.SOURCE_IMPORTED:
                    self.imported_dirs[_norm(work_dir)] = pk
        self.egress = {}
        prefix = str(getattr(settings, "LIVEKIT_RECORDING_FILEPATH_PREFIX", "/recordings") or "/recordings").rstrip("/")
        claimed = set(R.objects.exclude(livekit_recording__isnull=True).values_list("livekit_recording_id", flat=True))
        for recording in RealtimeSessionRecording.objects.only(
            "pk", "session_id", "video_file", "output_file_path", "started_at"
        ).iterator():
            info = (recording.pk, recording.session_id, recording.started_at, recording.pk not in claimed)
            if recording.video_file:
                self.egress[_norm(media / recording.video_file.name)] = info
            output = str(recording.output_file_path or "").replace("\\", "/")
            if output:
                if prefix and output.startswith(prefix + "/"):
                    self.egress[_norm(live / output[len(prefix) + 1 :])] = info
                path = Path(output)
                self.egress[_norm(path if path.is_absolute() else live / output)] = info


def _module_hint(path):
    """``.../module_<id>/...`` in a lecture_videos path -> that module, if it exists."""
    for part in Path(path).parts:
        if part.startswith("module_") and part[7:].isdigit():
            return Section.objects.filter(pk=int(part[7:])).first()
    return None


class _Prober:
    def __init__(self, enabled, deadline):
        self.available = bool(enabled) and shutil.which(config.ffprobe_binary()) is not None
        self._deadline = deadline

    def duration(self, paths):
        if not self.available or (self._deadline is not None and time.monotonic() > self._deadline):
            return None
        total = 0
        for path in paths:
            value = ffmpeg.probe_duration_seconds(path, timeout=PROBE_TIMEOUT_SECONDS)
            if value is None:
                return None
            total += value
        return total


def scan_existing_recordings(
    *,
    probe=True,
    min_age_seconds=DEFAULT_MIN_AGE_SECONDS,
    limit=None,
    probe_budget_seconds=None,
    dry_run=False,
    roots=None,
):
    """List unlinked videos as imported recordings. Returns a ScanReport."""
    report = ScanReport(dry_run=dry_run)
    roots = list(roots) if roots is not None else scan_roots()
    index = _Index()
    deadline = time.monotonic() + probe_budget_seconds if probe_budget_seconds else None
    prober = _Prober(probe, deadline)
    report.probe_available = prober.available
    now = time.time()
    root_keys = {_norm(root.path) for root in roots}
    work_dir_parents = frozenset(_norm(root.path) for root in roots if root.kind == "workdirs")

    def budget_left():
        if limit is not None and len(report.created) >= limit:
            report.truncated = True
            return False
        return True

    for root in roots:
        exists = root.path.is_dir() and not root.path.is_symlink()
        report.roots.append((root.label, str(root.path), exists))
        if not exists:
            continue
        if root.kind == "workdirs":
            _scan_work_dirs(root, index, prober, report, now=now, min_age_seconds=min_age_seconds,
                            dry_run=dry_run, budget_left=budget_left)
            continue
        skip_dirs = root_keys - {_norm(root.path)}
        for path, stat in _walk_files(root.path, skip_dirs=skip_dirs, work_dir_parents=work_dir_parents):
            suffix = path.suffix.lower()
            video_suffixes = VIDEO_SUFFIXES | ({".ts"} if root.allow_ts else set())
            partial_video = path.name.lower().endswith(TEMP_SUFFIXES) and any(
                item.lower() in video_suffixes for item in path.suffixes[:-1]
            )
            if suffix not in video_suffixes and not partial_video:
                continue
            report.files_seen += 1
            key = _norm(path)
            reason = _skip_reason(path.name, stat, now=now, min_age_seconds=min_age_seconds)
            if key in index.imported_files:
                _refresh(index.imported_files[key], [path], stat.st_size, stat.st_mtime, prober, report, dry_run)
                continue
            if key in index.linked_files:
                report.linked += 1
                continue
            if reason:
                report.skipped[reason] += 1
                continue
            if not budget_left():
                return report
            egress = index.egress.get(key)
            _create(
                report,
                dry_run=dry_run,
                source_path=str(path),
                size=stat.st_size,
                mtime=stat.st_mtime,
                duration=prober.duration([path]),
                egress=egress,
                module=_module_hint(path) if "lecture_videos" in path.parts else None,
            )
    return report


def _scan_work_dirs(root, index, prober, report, *, now, min_age_seconds, dry_run, budget_left):
    try:
        iterator = os.scandir(root.path)
    except OSError:
        return
    with iterator:
        entries = [entry for entry in iterator if entry.name.startswith(WORK_DIR_PREFIX)]
    for entry in sorted(entries, key=lambda item: item.name):
        try:
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
        except OSError:
            continue
        directory = Path(entry.path)
        parts = _work_dir_parts(directory)
        if not parts:
            continue
        report.files_seen += 1
        key = _norm(directory)
        size = sum(stat.st_size for _path, stat in parts)
        mtime = max(stat.st_mtime for _path, stat in parts)
        if key in index.imported_dirs:
            _refresh(index.imported_dirs[key], [p for p, _s in parts], size, mtime, prober, report, dry_run)
            continue
        suffix = entry.name[len(WORK_DIR_PREFIX):]
        owner = int(suffix) if suffix.isdigit() else None
        if key in index.linked_dirs or (owner is not None and owner in index.recording_ids):
            report.linked += 1
            continue
        if now - mtime < min_age_seconds:
            report.skipped["recently modified"] += 1
            continue
        if not budget_left():
            return
        _create(
            report,
            dry_run=dry_run,
            work_dir=str(directory),
            size=size,
            mtime=mtime,
            duration=prober.duration([p for p, _s in parts]),
            part_count=len(parts),
        )


def _refresh(recording_id, paths, size, mtime, prober, report, dry_run):
    row = R.objects.filter(pk=recording_id).only("pk", "state", "source_size_bytes", "source_mtime").first()
    if row is None or row.state != R.STATE_IMPORTED:
        report.linked += 1
        return
    if row.source_size_bytes == size and row.source_mtime is not None and abs(row.source_mtime - mtime) < 1e-3:
        report.unchanged += 1
        return
    if not dry_run:
        R.objects.filter(pk=recording_id, state=R.STATE_IMPORTED).update(
            source_size_bytes=size,
            source_mtime=mtime,
            file_size_bytes=size,
            duration_seconds=prober.duration(paths),
        )
    report.updated.append(recording_id)


def _create(report, *, dry_run, size, mtime, duration, source_path="", work_dir="", egress=None, module=None,
            part_count=0):
    if dry_run:
        report.created.append(source_path or work_dir)
        return
    started_at = datetime.fromtimestamp(mtime, tz=dt_timezone.utc)
    values = dict(
        source=R.SOURCE_IMPORTED,
        state=R.STATE_IMPORTED,
        source_path=source_path,
        work_dir=work_dir,
        source_size_bytes=size,
        source_mtime=mtime,
        file_size_bytes=size,
        captured_bytes=size if work_dir else 0,
        part_count=part_count,
        duration_seconds=duration,
        started_at=started_at,
        module=module,
    )
    if egress is not None:
        livekit_id, session_id, egress_started_at, unclaimed = egress
        values["session_id"] = session_id
        values["started_at"] = egress_started_at or started_at
        if unclaimed:
            values["livekit_recording_id"] = livekit_id
    try:
        with transaction.atomic():
            row = R.objects.create(**values)
    except IntegrityError:
        # The LiveKit recording was claimed meanwhile: list the file without the link.
        values.pop("livekit_recording_id", None)
        row = R.objects.create(**values)
    logger.info(
        "CLASS_RECORDING_IMPORTED recording_id=%s path=%s size=%s duration=%s",
        row.pk,
        source_path or work_dir,
        size,
        duration,
    )
    report.created.append(row.pk)
