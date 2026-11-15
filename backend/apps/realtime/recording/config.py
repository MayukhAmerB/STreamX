"""Recorder settings with safe defaults (all overridable via environment)."""

from pathlib import Path

from django.conf import settings

GIB = 1024 * 1024 * 1024


def _int(name, default, minimum=0):
    try:
        value = int(getattr(settings, name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


def recorder_enabled():
    return bool(getattr(settings, "STREAM_RECORDER_ENABLED", False))


def source_url():
    return str(getattr(settings, "STREAM_RECORDER_SOURCE_URL", "") or "http://owncast:8080/hls/stream.m3u8").strip()


def work_root():
    return Path(str(getattr(settings, "STREAM_RECORDER_WORK_DIR", "") or "/recordings/class-recordings"))


def max_capture_bytes():
    return _int("STREAM_RECORDER_MAX_BYTES", 30 * GIB, minimum=1)


def min_free_bytes():
    return _int("STREAM_RECORDER_MIN_FREE_BYTES", 5 * GIB)


def max_duration_seconds():
    return _int("STREAM_RECORDER_MAX_DURATION_SECONDS", 6 * 3600, minimum=60)


def restart_backoff_seconds():
    return _int("STREAM_RECORDER_RESTART_BACKOFF_SECONDS", 5, minimum=1)


def heartbeat_seconds():
    return _int("STREAM_RECORDER_HEARTBEAT_SECONDS", 10, minimum=1)


def nice_level():
    return _int("STREAM_RECORDER_NICE", 10)


def egress_wait_seconds():
    return _int("STREAM_RECORDER_EGRESS_WAIT_SECONDS", 1800, minimum=60)


def file_settle_seconds():
    return _int("STREAM_RECORDER_FILE_SETTLE_SECONDS", 10)


def finalize_timeout_seconds():
    return _int("STREAM_RECORDER_FINALIZE_TIMEOUT_SECONDS", 3600, minimum=60)


def finalize_space_factor():
    """Free space needed on the media disk per byte of input before a finalize.

    The concat/remux output is about the size of the input (stream copy), and
    the HLS transcode that follows writes its renditions next to it; 2.0 covers
    both. The global STREAM_RECORDER_MIN_FREE_BYTES floor is added on top.
    """
    try:
        value = float(getattr(settings, "STREAM_RECORDER_FINALIZE_SPACE_FACTOR", 2.0))
    except (TypeError, ValueError):
        value = 2.0
    return max(1.0, value)


def failed_retention_seconds():
    """How long a failed recording's captured parts are kept for a retry."""
    return _int("STREAM_RECORDER_FAILED_RETENTION_DAYS", 7, minimum=1) * 86400


def sweep_interval_seconds():
    return _int("STREAM_RECORDER_SWEEP_INTERVAL_SECONDS", 3600, minimum=60)


def finalize_queue_size():
    return _int("STREAM_RECORDER_FINALIZE_QUEUE_SIZE", 32, minimum=1)


# OBS uploads that need a remux (MKV/FLV/TS) wait here, under MEDIA_ROOT (the
# web tier can write it; the recorder converts and removes them).
OBS_UPLOAD_STAGING_DIR = "class-recording-uploads"


def ffmpeg_binary():
    return str(getattr(settings, "FFMPEG_BINARY", "ffmpeg") or "ffmpeg")


def ffprobe_binary():
    return str(getattr(settings, "FFPROBE_BINARY", "ffprobe") or "ffprobe")


def hls_filter_enabled():
    """Capture through the local playlist filter (hls_proxy.py). Default on."""
    return bool(getattr(settings, "STREAM_RECORDER_HLS_FILTER", True))
