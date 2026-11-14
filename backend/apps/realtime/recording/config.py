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


# --------------------------------------------------------------------------
# Phase 2: no-click recordings
# --------------------------------------------------------------------------


def _bool(name, default):
    return bool(getattr(settings, name, default))


def _seconds_list(name, default):
    raw = str(getattr(settings, name, "") or default)
    values = []
    for item in raw.split(","):
        try:
            values.append(max(1, int(item.strip())))
        except (TypeError, ValueError):
            continue
    return values or [int(item) for item in default.split(",")]


def auto_all_broadcasts():
    """Record every broadcast (OBS and Host Studio), not only OBS sessions."""
    return _bool("RECORDING_AUTO_ALL_BROADCASTS", True)


def auto_meetings():
    """Auto-record meetings (students' cameras/mics). Off unless enabled."""
    return _bool("RECORDING_AUTO_MEETINGS", False)


def instant_publish():
    return _bool("RECORDING_INSTANT_PUBLISH", True)


def auto_module_title():
    return str(getattr(settings, "RECORDING_AUTO_MODULE_TITLE", "") or "Class recordings").strip()[:255]


def idle_finalize_seconds():
    return _int("STREAM_RECORDER_IDLE_FINALIZE_SECONDS", 900, minimum=60)


def stop_grace_seconds():
    return _int("STREAM_RECORDER_STOP_GRACE_SECONDS", 600)


def reconcile_interval_seconds():
    return _int("RECORDING_RECONCILE_INTERVAL_SECONDS", 30, minimum=10)


def reconcile_lookback_seconds():
    return _int("RECORDING_RECONCILE_LOOKBACK_HOURS", 24, minimum=1) * 3600


def auto_retry_max():
    return _int("RECORDING_AUTO_RETRY_MAX", 3)


def auto_retry_backoff_seconds():
    return _seconds_list("RECORDING_AUTO_RETRY_BACKOFF_SECONDS", "300,1800,7200")


def import_scan_interval_seconds():
    return _int("RECORDING_IMPORT_SCAN_INTERVAL_SECONDS", 3600)


def import_auto_publish():
    return _bool("RECORDING_IMPORT_AUTO_PUBLISH", True)


def alerts_enabled():
    return _bool("RECORDING_ALERTS_ENABLED", True)


def processing_alert_seconds():
    return _int("RECORDING_PROCESSING_ALERT_SECONDS", 6 * 3600, minimum=600)


def finalizing_alert_seconds():
    return _int("RECORDING_FINALIZING_ALERT_SECONDS", 3600, minimum=300)


def heartbeat_alert_seconds():
    return _int("RECORDING_HEARTBEAT_ALERT_SECONDS", 180, minimum=60)


def canary_enabled():
    return _bool("RECORDING_CANARY_ENABLED", True)


def canary_hour():
    return min(23, _int("RECORDING_CANARY_HOUR", 3))


def recorder_heartbeat_file():
    return str(getattr(settings, "STREAM_RECORDER_HEARTBEAT_FILE", "") or "").strip()
