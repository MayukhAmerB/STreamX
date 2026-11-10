"""ffmpeg/ffprobe command builders and runners (stream copy only, no re-encode)."""

import shutil
import subprocess
from pathlib import Path

from . import config


class FFmpegError(Exception):
    pass


def _niced(cmd):
    level = config.nice_level()
    nice_binary = shutil.which("nice") if level > 0 else None
    if nice_binary:
        return [nice_binary, "-n", str(level), *cmd]
    return list(cmd)


def build_capture_command(source_url, output_path):
    """Pull the live HLS feed and copy it into an MPEG-TS part.

    MPEG-TS survives an abrupt stop (OBS drop, container restart) without a
    trailer, unlike MP4. Without ``-map`` ffmpeg picks the highest-resolution
    video and best audio rendition of a master playlist; the other renditions
    are discarded and not downloaded.
    """
    return _niced(
        [
            config.ffmpeg_binary(),
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "warning",
            "-rw_timeout",
            "15000000",
            # Exit ~30-60s after the playlist stops growing (OBS gone) instead of
            # polling for an hour; the next OBS connection starts a new part.
            "-m3u8_hold_counters",
            "15",
            "-i",
            str(source_url),
            "-c",
            "copy",
            "-f",
            "mpegts",
            "-y",
            str(output_path),
        ]
    )


def write_concat_list(inputs, list_path):
    lines = []
    for item in inputs:
        escaped = str(Path(item).resolve()).replace("\\", "/").replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    Path(list_path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return Path(list_path)


def build_concat_command(list_path, output_path):
    return _niced(
        [
            config.ffmpeg_binary(),
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )


def concat_to_mp4(inputs, output_path, *, list_path):
    """Concatenate parts into a faststart MP4 (copy codec). Raises FFmpegError."""
    if not inputs:
        raise FFmpegError("No input files to concatenate.")
    write_concat_list(inputs, list_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            build_concat_command(list_path, output_path),
            check=False,
            capture_output=True,
            text=True,
            timeout=config.finalize_timeout_seconds(),
        )
    except FileNotFoundError as exc:
        raise FFmpegError("ffmpeg is not installed or not on PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError("ffmpeg concat timed out.") from exc
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
        detail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise FFmpegError(f"ffmpeg concat failed (exit {result.returncode}). {detail}".strip())
    return output_path


def build_remux_command(input_path, output_path):
    """OBS MKV/FLV/TS -> faststart MP4 without re-encoding (argv list, no shell)."""
    return _niced(
        [
            config.ffmpeg_binary(),
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )


def remux_to_mp4(input_path, output_path):
    """Stream-copy ``input_path`` into a faststart MP4. Raises FFmpegError."""
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            build_remux_command(input_path, output_path),
            check=False,
            capture_output=True,
            text=True,
            timeout=config.finalize_timeout_seconds(),
        )
    except FileNotFoundError as exc:
        raise FFmpegError("ffmpeg is not installed or not on PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        output_path.unlink(missing_ok=True)
        raise FFmpegError("ffmpeg remux timed out.") from exc
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
        output_path.unlink(missing_ok=True)
        detail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise FFmpegError(f"ffmpeg remux failed (exit {result.returncode}). {detail}".strip())
    return output_path


def probe_duration_seconds(path):
    """Best-effort media duration in whole seconds (None when unknown)."""
    try:
        result = subprocess.run(
            [
                config.ffprobe_binary(),
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    try:
        return max(0, int(round(float((result.stdout or "").strip()))))
    except (TypeError, ValueError):
        return None
