"""Settings for resumable recording uploads, with safe defaults (all env-overridable)."""

import os
from pathlib import Path

from django.conf import settings
from django.utils.module_loading import import_string

MIB = 1024 * 1024
GIB = 1024 * MIB

# Read/write block for streaming request bodies and assembling chunks: memory
# use per request is one block, whatever the chunk or file size.
IO_BLOCK_BYTES = 1 * MIB


def _int(name, default, minimum=0):
    try:
        value = int(getattr(settings, name, default))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


def chunk_bytes():
    """Chunk size handed to clients (32 MiB): well under Cloudflare's 100 MB body limit."""
    return _int("RECORDING_UPLOAD_CHUNK_BYTES", 32 * MIB, minimum=1)


def max_file_bytes():
    return _int("RECORDING_UPLOAD_MAX_BYTES", 8 * GIB, minimum=1)


def max_chunk_body_bytes():
    """Hard ceiling for one chunk request; nginx allows 64m on the chunk route."""
    return chunk_bytes()


def staging_root():
    """Private staging directory for chunks (never under MEDIA_ROOT, never served).

    On the VPS it lives inside the noexec,nosuid,nodev private volume
    (/srv/streamx/reports -> /app/private_media/.recording-uploads).
    """
    configured = str(getattr(settings, "RECORDING_UPLOAD_STAGING_ROOT", "") or "").strip()
    if configured:
        return Path(configured)
    private_root = str(getattr(settings, "REPORTS_PRIVATE_ROOT", "") or "").strip()
    base = Path(private_root) if private_root else Path(settings.BASE_DIR) / "private_media"
    return base / ".recording-uploads"


def expiry_seconds():
    """An unfinished upload is kept this long after its last chunk."""
    return _int("RECORDING_UPLOAD_EXPIRY_HOURS", 48, minimum=1) * 3600


def max_active_per_user():
    return _int("RECORDING_UPLOAD_MAX_ACTIVE_PER_USER", 3, minimum=1)


def max_active_bytes_per_user():
    return _int("RECORDING_UPLOAD_MAX_ACTIVE_BYTES_PER_USER", 24 * GIB, minimum=1)


def min_free_bytes():
    """Free space kept on the staging disk on top of what an upload needs."""
    return _int("RECORDING_UPLOAD_MIN_FREE_BYTES", 2 * GIB)


def revert_retention_days():
    """The replaced video file is kept this long so an admin can switch back."""
    return _int("RECORDING_UPLOAD_REVERT_RETENTION_DAYS", 14, minimum=1)


def assemble_lease_seconds():
    """A worker holding an assembly renews this lease; a dead worker's lease expires."""
    return _int("RECORDING_UPLOAD_ASSEMBLE_LEASE_SECONDS", 900, minimum=60)


def wait_for_recording_seconds():
    """How long a finished upload waits for the class's auto-recording to get its lecture."""
    return _int("RECORDING_UPLOAD_WAIT_FOR_RECORDING_SECONDS", 3 * 3600, minimum=0)


def wait_poll_seconds():
    return _int("RECORDING_UPLOAD_WAIT_POLL_SECONDS", 60, minimum=1)


def cleanup_interval_seconds():
    return _int("RECORDING_UPLOAD_CLEANUP_INTERVAL_SECONDS", 900, minimum=60)


def orphan_dir_grace_seconds():
    """A staging directory without an upload row is removed after this long."""
    return _int("RECORDING_UPLOAD_ORPHAN_GRACE_SECONDS", 24 * 3600, minimum=60)


def target_lookback_days():
    """Classes offered in the "pick the class" list (and to the desktop uploader)."""
    return _int("RECORDING_UPLOAD_TARGET_LOOKBACK_DAYS", 30, minimum=1)


DEFAULT_MEDIA_RUNNER = "apps.recording_uploads.media.FFmpegMediaRunner"


def media_runner():
    """The ffprobe/ffmpeg runner (injectable: RECORDING_UPLOAD_MEDIA_RUNNER)."""
    dotted = str(getattr(settings, "RECORDING_UPLOAD_MEDIA_RUNNER", "") or DEFAULT_MEDIA_RUNNER)
    return import_string(dotted)()


def staging_file_mode():
    return 0o600


def staging_dir_mode():
    return 0o700


def is_inside(child, parent):
    try:
        child_path = os.path.realpath(str(child))
        parent_path = os.path.realpath(str(parent))
    except (OSError, ValueError):
        return False
    return child_path == parent_path or child_path.startswith(parent_path.rstrip(os.sep) + os.sep)
