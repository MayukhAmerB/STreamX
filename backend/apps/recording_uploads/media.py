"""ffprobe / ffmpeg for uploaded recordings, behind an injectable runner.

``config.media_runner()`` builds the runner named by
``RECORDING_UPLOAD_MEDIA_RUNNER`` (default ``FFmpegMediaRunner``); tests and
the E2E stack swap in a runner that does not execute any binary.

A runner has two methods:

* ``probe(path) -> ProbeResult``  is this a playable video (and how long)?
* ``remux_to_mp4(source, output)``  stream copy (``-c copy``) into a faststart
  MP4; never a re-encode, so even a 3 GB OBS file takes about a disk copy.
"""

import json
import subprocess
from dataclasses import dataclass

from apps.realtime.recording import config as recording_config
from apps.realtime.recording import ffmpeg


class MediaError(Exception):
    """The file is not a usable recording (shown to the uploader)."""


@dataclass(frozen=True)
class ProbeResult:
    has_video: bool
    duration_seconds: int | None = None
    format_name: str = ""


def parse_ffprobe_json(text):
    try:
        payload = json.loads(text or "{}")
    except json.JSONDecodeError as exc:
        raise MediaError("ffprobe returned output that is not JSON.") from exc
    streams = payload.get("streams") or []
    fmt = payload.get("format") or {}
    has_video = any(str(stream.get("codec_type") or "") == "video" for stream in streams)
    try:
        duration = max(0, int(round(float(fmt.get("duration")))))
    except (TypeError, ValueError):
        duration = None
    return ProbeResult(has_video=has_video, duration_seconds=duration, format_name=str(fmt.get("format_name") or ""))


class FFmpegMediaRunner:
    probe_timeout_seconds = 180

    def probe_command(self, path):
        return [
            recording_config.ffprobe_binary(),
            "-v",
            "error",
            "-show_entries",
            "format=duration,format_name:stream=codec_type",
            "-of",
            "json",
            str(path),
        ]

    def probe(self, path):
        try:
            result = subprocess.run(
                self.probe_command(path),
                check=False,
                capture_output=True,
                text=True,
                timeout=self.probe_timeout_seconds,
            )
        except FileNotFoundError as exc:
            raise MediaError("ffprobe is not installed on the server.") from exc
        except subprocess.TimeoutExpired as exc:
            raise MediaError("Reading the recording timed out.") from exc
        if result.returncode != 0:
            detail = (result.stderr or "").strip()[-500:]
            raise MediaError(f"The file is not a readable video. {detail}".strip())
        return parse_ffprobe_json(result.stdout)

    def remux_to_mp4(self, source, output):
        try:
            ffmpeg.remux_to_mp4(source, output)
        except ffmpeg.FFmpegError as exc:
            raise MediaError(
                f"Could not convert the recording to MP4: {exc} In OBS use File > Remux Recordings and upload "
                "the MP4."
            ) from exc
        return output
