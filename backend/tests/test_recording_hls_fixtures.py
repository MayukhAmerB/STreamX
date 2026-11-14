"""The capture -> finalize path driven by fixture HLS playlists and a fake ffmpeg.

No real ffmpeg runs here (``verify_recording_pipeline`` covers that on the
server). Instead:

* ``tests/fixtures/hls/*.m3u8`` are snapshots of what Owncast serves: a
  sliding live window, the offline tail Owncast appends when OBS disconnects
  (``#EXT-X-DISCONTINUITY`` + ``offline-v2.ts`` + ``#EXT-X-ENDLIST``), and a
  reconnect with fresh segment names;
* ``FixtureCapture`` plays the role of ``ffmpeg -c copy`` reading through the
  recorder's playlist filter (the real ``hls_proxy.filter_media_playlist``):
  it appends every segment the filter hands out to the part file;
* the fake ffmpeg concat reads the real concat list the recorder writes and
  joins the inputs byte-for-byte (MPEG-TS parts can be concatenated that way).

The final MP4 must therefore contain exactly the live segments, in order, once
each (offline windows and the offline clip removed, parts merged).
"""

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

from apps.courses.models import Lecture, Section
from apps.realtime.models import ClassRecording, RealtimeSession
from apps.realtime.recording import hls_proxy, services
from apps.realtime.recording.recorder import StreamRecorder, list_parts
from django.test import TestCase, override_settings

from tests.test_class_recordings import RecordingFixtureMixin

R = ClassRecording
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "hls"


def fixture(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def segment_bytes(name):
    return f"<{name}>".encode()


class FixtureCapture:
    """What ffmpeg does with the filtered playlist: append each handed-out segment."""

    def __init__(self, part_path):
        self.part_path = Path(part_path)
        self.delivered = set()
        self.ended = False
        self.offline_dropped = 0

    def poll_playlist(self, text):
        filtered, info = hls_proxy.filter_media_playlist(text, delivered=frozenset(self.delivered))
        self.offline_dropped += info["offline_dropped"]
        segments = [line for line in filtered.splitlines() if line and not line.startswith("#")]
        with self.part_path.open("ab") as handle:
            for uri in segments:
                handle.write(segment_bytes(uri))
                self.delivered.add(uri)
        if info["ended"]:
            self.ended = True
        return segments


def fake_concat_run(cmd, *args, **kwargs):
    """ffmpeg concat stand-in: join the files of the concat list; ffprobe prints a duration."""
    if "ffprobe" in str(cmd[0]):
        return subprocess.CompletedProcess(cmd, 0, stdout="22.0\n", stderr="")
    list_path = Path(cmd[cmd.index("-i") + 1])
    output = Path(cmd[-1])
    output.parent.mkdir(parents=True, exist_ok=True)
    data = b""
    for line in list_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("file '"):
            path = line[len("file '"):-1].replace("'\\''", "'")
            data += Path(path).read_bytes()
    output.write_bytes(data)
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


LIVE_A = [f"stream-a-{index:03d}.ts" for index in range(6)]
LIVE_B = [f"stream-b-{index:03d}.ts" for index in range(3)]


@patch("apps.realtime.recording.ffmpeg.subprocess.run", side_effect=fake_concat_run)
class FixtureHlsPipelineTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.recorder = StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": False})
        self.recording = services.ensure_server_recording(self.session, user=self.instructor)
        self.work_dir = Path(self.recording.work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)

    def capture_connection(self, part_number, playlists):
        capture = FixtureCapture(self.work_dir / f"part-{part_number:04d}.ts")
        for name in playlists:
            capture.poll_playlist(fixture(name))
            if capture.ended:
                break
        return capture

    def test_master_playlist_keeps_only_the_best_variant(self, _run):
        text, info = hls_proxy.select_best_variant(fixture("master.m3u8"))
        self.assertEqual(info["variants"], 2)
        self.assertIn("0/stream.m3u8", text)
        self.assertNotIn("1/stream.m3u8", text, "the 256x144 variant is never read")

    def test_offline_tail_is_stripped_and_endlist_ends_the_part(self, _run):
        capture = self.capture_connection(1, ["live-window-1.m3u8", "live-window-2.m3u8", "offline-tail.m3u8"])
        self.assertTrue(capture.ended, "the ENDLIST after the offline clip ends the capture")
        self.assertEqual(capture.offline_dropped, 1)
        self.assertNotIn("offline-v2.ts", capture.delivered)
        self.assertEqual(capture.part_path.read_bytes(), b"".join(segment_bytes(name) for name in LIVE_A))

    def test_sliding_windows_never_duplicate_a_segment(self, _run):
        capture = FixtureCapture(self.work_dir / "part-0001.ts")
        first = capture.poll_playlist(fixture("live-window-1.m3u8"))
        second = capture.poll_playlist(fixture("live-window-2.m3u8"))
        again = capture.poll_playlist(fixture("live-window-2.m3u8"))
        self.assertEqual(first, LIVE_A[:3])
        self.assertEqual(second, LIVE_A[3:5], "overlap with the previous window is trimmed")
        self.assertEqual(again, [], "a reload with nothing new hands out nothing")

    def test_offline_window_reconnect_and_finalize_merge_parts_into_one_take(self, _run):
        self.capture_connection(1, ["live-window-1.m3u8", "live-window-2.m3u8", "offline-tail.m3u8"])
        self.capture_connection(2, ["reconnect-window-1.m3u8", "reconnect-offline-tail.m3u8"])
        self.assertEqual([part.name for part in list_parts(self.work_dir)], ["part-0001.ts", "part-0002.ts"])

        services.request_finalize(self.session, reason="session_ended")
        self.recorder.tick()
        self.recording.refresh_from_db()

        self.assertEqual(self.recording.state, R.STATE_PROCESSING)
        video = Path(self.recording.lecture.video_file.path)
        expected = b"".join(segment_bytes(name) for name in LIVE_A + LIVE_B)
        self.assertEqual(video.read_bytes(), expected, "live content only, in order, both parts merged")
        self.assertNotIn(b"offline", video.read_bytes())
        self.assertEqual(R.objects.filter(session=self.session).count(), 1, "one take for the class")
        self.assertFalse(self.work_dir.exists(), "parts are removed once the MP4 exists")

    def test_finalize_is_idempotent(self, run):
        self.capture_connection(1, ["live-window-1.m3u8", "offline-tail.m3u8"])
        services.request_finalize(self.session, reason="session_ended")
        self.recorder.tick()
        self.recorder.tick()
        self.recorder.finalize_recording(self.recording.pk)  # a duplicate submit is a no-op
        self.recording.refresh_from_db()
        lectures = Lecture.objects.filter(section=self.module, class_recordings=self.recording)
        self.assertEqual(lectures.count(), 1)
        concat_calls = [call for call in run.call_args_list if "concat" in call.args[0]]
        self.assertEqual(len(concat_calls), 1)

    def test_missing_module_publishes_into_class_recordings(self, _run):
        RealtimeSession.objects.filter(pk=self.session.pk).update(target_module=None)
        R.objects.filter(pk=self.recording.pk).update(module=None)
        self.capture_connection(1, ["live-window-1.m3u8", "offline-tail.m3u8"])
        services.request_finalize(self.session, reason="session_ended")
        self.recorder.tick()
        self.recording.refresh_from_db()
        self.assertEqual(self.recording.state, R.STATE_PROCESSING)
        self.assertEqual(self.recording.lecture.section.title, "Class recordings")
        self.assertTrue(self.recording.needs_review)
        self.assertEqual(Section.objects.filter(course=self.course, title="Class recordings").count(), 1)

    @override_settings(RECORDING_INSTANT_PUBLISH=True)
    def test_mp4_is_published_at_finalize(self, _run):
        self.capture_connection(1, ["live-window-1.m3u8", "offline-tail.m3u8"])
        services.request_finalize(self.session, reason="session_ended")
        self.recorder.tick()
        self.recording.refresh_from_db()
        lecture = self.recording.lecture
        self.assertTrue(lecture.is_published, "students can watch the MP4 right away")
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED, "HLS still to be built")
        self.assertEqual(lecture.stream_priority, 10, "class recordings go first in the transcode queue")
