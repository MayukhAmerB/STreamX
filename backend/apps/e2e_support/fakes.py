"""Test doubles used only by the end-to-end stack.

* ``FakeCapture`` stands in for ``ffmpeg -i <owncast hls> -c copy part.ts``.
  It really reads the (stubbed) Owncast playlist and copies its segments into
  the part file, then "runs" until the recorder terminates it.
* ``fake_ffmpeg_run`` stands in for the ffmpeg concat/remux and ffprobe calls
  of ``apps.realtime.recording.ffmpeg`` (stream copy: join the input bytes;
  ffprobe prints a duration). It is swapped in only for the duration of an
  E2E recorder tick, on that module alone (``patched_recording_ffmpeg``).
* ``install_youtube_fixture`` makes the YouTube feed read a fixture file
  instead of youtube.com, through the real Atom parser.

No external binary is downloaded or executed.
"""

from __future__ import annotations

import contextlib
import logging
import re
import shlex
import subprocess
import types
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

from django.conf import settings

logger = logging.getLogger("apps.e2e_support")

FAKE_DURATION_SECONDS = 42


# --------------------------------------------------------------------- capture
class FakeCapture:
    """A Popen-like object; ``cmd[-1]`` is the part path, ``-i`` the source URL."""

    _next_pid = 40000

    def __init__(self, cmd, **_kwargs):
        FakeCapture._next_pid += 1
        self.pid = FakeCapture._next_pid
        self.args = list(cmd)
        self.returncode = None
        output = Path(self.args[-1])
        source = self.args[self.args.index("-i") + 1] if "-i" in self.args else ""
        output.parent.mkdir(parents=True, exist_ok=True)
        data = _read_hls(source)
        with open(output, "ab") as handle:
            handle.write(data or b"E2E-FAKE-TS-PART\n")

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode

    def terminate(self):
        if self.returncode is None:
            self.returncode = 255  # ffmpeg's exit code on SIGTERM

    def kill(self):
        self.terminate()

    def send_signal(self, _sig):
        self.terminate()


def _read_hls(url: str, *, limit_bytes: int = 2 * 1024 * 1024) -> bytes:
    """Fetch the media playlist and its segments (master playlists are followed)."""
    if not url.startswith("http"):
        return b""
    try:
        playlist = urllib.request.urlopen(url, timeout=5).read().decode("utf-8", "replace")  # noqa: S310 - local stub
        lines = [line.strip() for line in playlist.splitlines() if line.strip()]
        if any(line.startswith("#EXT-X-STREAM-INF") for line in lines):
            variant = next(line for line in lines if not line.startswith("#"))
            return _read_hls(urljoin(url, variant), limit_bytes=limit_bytes)
        data = b""
        for line in lines:
            if line.startswith("#"):
                continue
            data += urllib.request.urlopen(urljoin(url, line), timeout=5).read()  # noqa: S310 - local stub
            if len(data) >= limit_bytes:
                break
        return data
    except Exception as exc:  # noqa: BLE001 - a missing feed is an empty part, like ffmpeg
        logger.warning("e2e fake capture could not read %s: %s", url, exc)
        return b""


# ---------------------------------------------------------------- ffmpeg runs
_CONCAT_LINE = re.compile(r"^file '(.*)'$")


def _strip_nice(cmd):
    cmd = list(cmd)
    if cmd and Path(str(cmd[0])).name.lower().startswith("nice"):
        cmd = cmd[3:]
    return cmd


def _concat_inputs(list_path: Path):
    inputs = []
    for line in list_path.read_text(encoding="utf-8").splitlines():
        match = _CONCAT_LINE.match(line.strip())
        if match:
            inputs.append(Path(match.group(1).replace("'\\''", "'")))
    return inputs


def fake_ffmpeg_run(cmd, *args, **kwargs):
    cmd = [str(part) for part in _strip_nice(cmd)]
    binary = Path(cmd[0]).name.lower() if cmd else ""
    if "ffprobe" in binary:
        return subprocess.CompletedProcess(cmd, 0, stdout=f"{FAKE_DURATION_SECONDS}.0\n", stderr="")
    output = Path(cmd[-1])
    source = Path(cmd[cmd.index("-i") + 1]) if "-i" in cmd else None
    try:
        if "concat" in cmd and source is not None:
            inputs = _concat_inputs(source)
        else:
            inputs = [source] if source is not None else []
        output.parent.mkdir(parents=True, exist_ok=True)
        with open(output, "wb") as handle:
            for item in inputs:
                handle.write(Path(item).read_bytes())
    except OSError as exc:
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr=f"fake ffmpeg: {exc}")
    if output.stat().st_size == 0:
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="fake ffmpeg: no input bytes")
    logger.info("e2e fake ffmpeg: %s", shlex.join(cmd[:4] + ["...", cmd[-1]]))
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


@contextlib.contextmanager
def patched_recording_ffmpeg():
    """Swap ``subprocess.run`` for the fake inside the recording ffmpeg module only."""
    from apps.realtime.recording import ffmpeg as recording_ffmpeg

    original = recording_ffmpeg.subprocess
    shim = types.SimpleNamespace(**{name: getattr(subprocess, name) for name in dir(subprocess) if not name.startswith("__")})
    shim.run = fake_ffmpeg_run
    recording_ffmpeg.subprocess = shim
    try:
        yield
    finally:
        recording_ffmpeg.subprocess = original


# ------------------------------------------------------ resumable uploads
class FakeUploadMediaRunner:
    """``RECORDING_UPLOAD_MEDIA_RUNNER`` of the E2E stack (apps.recording_uploads.media).

    probe: a file that starts with a known video container signature has a
    video track and lasts FAKE_DURATION_SECONDS. remux: stream copy (the bytes
    are copied unchanged). No binary is executed.
    """

    SIGNATURES = (b"\x1a\x45\xdf\xa3", b"ftyp", b"FLV\x01", b"\x47")

    def probe(self, path):
        from apps.recording_uploads.media import MediaError, ProbeResult

        with open(path, "rb") as handle:
            head = handle.read(16)
        if not head:
            raise MediaError("The file is not a readable video.")
        has_video = head.startswith(self.SIGNATURES[0]) or head[4:8] == self.SIGNATURES[1] or head.startswith(
            self.SIGNATURES[2]
        ) or head.startswith(self.SIGNATURES[3])
        return ProbeResult(has_video=has_video, duration_seconds=FAKE_DURATION_SECONDS, format_name="e2e")

    def remux_to_mp4(self, source, output):
        import shutil

        Path(output).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, output)
        logger.info("e2e fake upload remux: %s -> %s", source, output)
        return output


# -------------------------------------------------------------------- youtube
def _fixture_path(name: str) -> Path:
    return Path(getattr(settings, "E2E_FIXTURES_DIR", "")) / name


def install_youtube_fixture():
    """youtube.com is never called: the feed comes from e2e/fixtures/youtube-feed.xml."""
    from apps.site_media import youtube

    def fetch_feed(channel_id: str) -> dict:
        feed = youtube.parse_feed(_fixture_path("youtube-feed.xml").read_bytes())
        feed["fetched_at"] = "2026-11-01T00:00:00Z"
        return feed

    def fetch_live_status(channel_id: str):
        return youtube.LiveStatus()

    def fetch_oembed_title(video_id: str) -> str:
        return "E2E featured video"

    youtube.fetch_feed = fetch_feed
    youtube.fetch_live_status = fetch_live_status
    youtube.fetch_oembed_title = fetch_oembed_title
