"""ffmpeg/ffprobe command builders and runners (stream copy only, no re-encode)."""

import os
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


def build_capture_command(source_url, output_path, *, via_filter=False):
    """Pull the live HLS feed and copy it into an MPEG-TS part.

    MPEG-TS survives an abrupt stop (OBS drop, container restart) without a
    trailer, unlike MP4. Without ``-map`` ffmpeg picks the highest-resolution
    video and best audio of the playlist; the recorder's playlist filter
    (hls_proxy.py) hands ffmpeg a master playlist with only the best variant,
    so video and audio always come from the same rendition.

    Options (all valid on ffmpeg 5.1 and 7.x, the Debian builds the image uses):
    * ``-rw_timeout`` (microseconds) is copied by the HLS demuxer to every
      playlist and segment request, so a stalled Owncast cannot hang ffmpeg.
      The http ``-reconnect*`` options are deliberately not used: the HLS
      demuxer does not pass them on to segment requests, so they would only
      cover the first playlist fetch; a lost connection ends the part and the
      recorder starts the next one instead.
    * ``-m3u8_hold_counters`` makes ffmpeg exit ~30-60s after the playlist
      stops growing (Owncast gone without an ENDLIST) instead of polling for
      an hour; the next OBS connection starts a new part.
    * Behind the playlist filter (``via_filter``), which only lists segments
      this recording has not captured yet: ``-live_start_index 0`` starts at
      the first of them, and ``-http_multiple 0`` stops ffmpeg from
      prefetching the next segment while reading the current one, so every
      segment the filter has handed out has really been read by the time
      ffmpeg reloads the playlist. Straight against Owncast, ffmpeg's
      defaults (start 3 segments from the live edge) are kept.
    """
    command = [
        config.ffmpeg_binary(),
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "warning",
        "-rw_timeout",
        "15000000",
        "-m3u8_hold_counters",
        "15",
    ]
    if via_filter:
        command += ["-live_start_index", "0", "-http_multiple", "0"]
    command += [
        "-i",
        str(source_url),
        "-c",
        "copy",
        "-f",
        "mpegts",
        "-y",
        str(output_path),
    ]
    return _niced(command)


def concat_list_entry(path):
    r"""One ``file '...'`` line of an ffmpeg concat-demuxer list.

    Inside single quotes everything is literal except the quote itself, which
    is written as ``'\''`` (close quote, escaped quote, reopen). Backslashes
    are legal file-name characters on Linux and are kept; only on Windows are
    they turned into the forward slashes ffmpeg also accepts there. Line
    breaks cannot be expressed in the list format at all.
    """
    text = str(Path(path).resolve())
    if os.sep == "\\":
        text = text.replace("\\", "/")
    if "\n" in text or "\r" in text:
        raise FFmpegError(f"Cannot concatenate a file whose path contains a line break: {text!r}")
    return "file '" + text.replace("'", "'\\''") + "'"


def write_concat_list(inputs, list_path):
    lines = [concat_list_entry(item) for item in inputs]
    Path(list_path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return Path(list_path)


# Large enough for the audio/video interleaving gap at a part boundary; the
# default (128 packets on older builds) can abort a stream copy with "Too many
# packets buffered for output stream".
MUXING_QUEUE_PACKETS = "4096"


def build_concat_command(list_path, output_path):
    """Parts (MPEG-TS) or one egress file -> faststart MP4, stream copy.

    * ``-safe 0``: the list holds absolute paths.
    * ``0:V?``/``0:a?``: every audio stream and the real video streams, never
      cover-art/thumbnail "video" streams (MP4 cannot always carry those).
      The concat demuxer takes its streams from the first file.
    * No explicit ``-bsf:a aac_adtstoasc``: the MP4 muxer inserts it on its
      own for ADTS AAC (the MPEG-TS parts) and leaves raw AAC (MP4 egress
      files) alone. Forcing it fails outright on any non-AAC audio.
    * ``-f mp4 -movflags +faststart``: moov is moved to the front in a second
      pass, so players can start before the whole file is downloaded.
    """
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
            "0:V?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-max_muxing_queue_size",
            MUXING_QUEUE_PACKETS,
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
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
    """OBS MKV/FLV/TS -> faststart MP4 without re-encoding (argv list, no shell).

    Same stream selection and muxer options as the concat; every audio track
    of a multi-track OBS recording is kept.
    """
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
            "0:V?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-max_muxing_queue_size",
            MUXING_QUEUE_PACKETS,
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
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


def probe_duration_seconds(path, *, timeout=120):
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
            timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    try:
        return max(0, int(round(float((result.stdout or "").strip()))))
    except (TypeError, ValueError):
        return None
