"""Lecture HLS transcode queue: single pass, timeout, retry/backoff, priority,
claims, blue/green swap and revision cleanup -- with a fake ffmpeg runner."""

import io
import json
import os
import shutil
import subprocess
import tempfile
import time
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from apps.courses import transcode_queue
from apps.courses.models import Course, Lecture, Section
from apps.courses.services import (
    TranscodeSuperseded,
    VideoTranscodeError,
    build_single_pass_transcode_command,
    resolve_transcode_timeout_seconds,
    transcode_lecture_to_hls,
)
from apps.notifications.models import Notification
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

User = get_user_model()
PROFILES_720 = [
    {"name": "360p", "width": 640, "height": 360, "video_bitrate": "1000k", "maxrate": "1070k",
     "bufsize": "1500k", "audio_bitrate": "96k"},
    {"name": "540p", "width": 960, "height": 540, "video_bitrate": "2200k", "maxrate": "2354k",
     "bufsize": "3300k", "audio_bitrate": "128k"},
    {"name": "720p", "width": 1280, "height": 720, "video_bitrate": "4200k", "maxrate": "4494k",
     "bufsize": "6300k", "audio_bitrate": "160k"},
]


class FakeFfmpeg:
    """subprocess.run stand-in. ffprobe prints metadata; ffmpeg writes every
    variant playlist of ``-var_stream_map`` (or fails / times out on demand)."""

    def __init__(self, *, width=1280, height=720, codec="h264", duration="600.0", fail=None, timeout=False):
        self.width, self.height, self.codec, self.duration = width, height, codec, duration
        self.fail = fail
        self.timeout = timeout
        self.ffmpeg_calls = []
        self.timeouts = []
        self.before_write = None

    def __call__(self, cmd, check=False, capture_output=False, text=False, timeout=None):
        if "ffprobe" in os.path.basename(str(cmd[0])):
            payload = {
                "streams": [
                    {"codec_type": "video", "codec_name": self.codec, "width": self.width, "height": self.height,
                     "avg_frame_rate": "30/1"},
                    {"codec_type": "audio", "codec_name": "aac"},
                ],
                "format": {"duration": self.duration},
            }
            return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload), stderr="")
        self.ffmpeg_calls.append(cmd)
        self.timeouts.append(timeout)
        if self.timeout:
            raise subprocess.TimeoutExpired(cmd, timeout)
        if self.fail:
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr=self.fail)
        if self.before_write:
            self.before_write()
        if "-var_stream_map" not in cmd:  # a concat/remux (patching subprocess.run is process-wide)
            Path(cmd[-1]).parent.mkdir(parents=True, exist_ok=True)
            Path(cmd[-1]).write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        stream_map = cmd[cmd.index("-var_stream_map") + 1]
        output_pattern = cmd[-1]
        for entry in stream_map.split():
            name = dict(item.split(":", 1) for item in entry.split(",") if item.startswith("name:"))["name"]
            playlist = Path(output_pattern.replace("%v", name))
            playlist.parent.mkdir(parents=True, exist_ok=True)
            playlist.write_text("#EXTM3U\n#EXTINF:4.0,\nsegment_000.ts\n#EXT-X-ENDLIST\n", encoding="utf-8")
            (playlist.parent / "segment_000.ts").write_bytes(b"ts")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


class TranscodeFixture:
    def build(self):
        self.media_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media_root, True)
        overrides = override_settings(
            MEDIA_ROOT=self.media_root,
            COURSE_HLS_SINGLE_PASS=True,
            COURSE_HLS_MAX_ATTEMPTS=3,
            COURSE_HLS_RETRY_BACKOFF_SECONDS="60,300",
            COURSE_HLS_REVISION_GRACE_SECONDS=3600,
        )
        overrides.enable()
        self.addCleanup(overrides.disable)
        instructor = User.objects.create_user(email="tq@test.com", password="StrongPass@123", role="instructor")
        self.course = Course.objects.create(
            title="Queue Course", description="d", price=Decimal("1.00"), instructor=instructor
        )
        self.module = Section.objects.create(course=self.course, title="M1", order=1)

    def lecture(self, title="L", priority=0, **extra):
        lecture = Lecture.objects.create(
            section=self.module,
            title=title,
            video_file=SimpleUploadedFile(f"{title}.mp4", b"source", content_type="video/mp4"),
            stream_priority=priority,
            **extra,
        )
        return Lecture.objects.select_related("section__course").get(pk=lecture.pk)


class SinglePassCommandTests(TestCase):
    def build(self, **kwargs):
        return build_single_pass_transcode_command(
            ffmpeg_binary="ffmpeg", source_path="/in.mp4", profiles=PROFILES_720, output_dir="/out",
            frame_rate=30.0, has_audio=True, **kwargs,
        )

    def test_one_process_decodes_once_and_splits_per_rendition(self):
        cmd = self.build(preset="veryfast", crf=23)
        self.assertEqual(cmd.count("-i"), 1)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertTrue(graph.startswith("[0:v]split=3[s0][s1][s2]"), graph)
        self.assertIn("[s2]scale=1280:720", graph)
        self.assertEqual(cmd[cmd.index("-var_stream_map") + 1],
                         "v:0,a:0,name:360p v:1,a:1,name:540p v:2,a:2,name:720p")
        self.assertEqual(cmd[cmd.index("-preset:v:1") + 1], "veryfast")
        self.assertEqual(cmd[cmd.index("-crf:v:2") + 1], "23")
        self.assertEqual(cmd[cmd.index("-maxrate:v:0") + 1], "1070k", "capped CRF")
        self.assertEqual(cmd[cmd.index("-g:v:0") + 1], "120")
        self.assertEqual(cmd[cmd.index("-b:a:2") + 1], "160k")
        self.assertEqual(cmd[cmd.index("-hls_playlist_type") + 1], "vod")
        self.assertTrue(cmd[-1].replace("\\", "/").endswith("/out/%v/index.m3u8"))
        self.assertEqual(cmd.count("-map"), 6, "a video and an audio stream per rendition")

    def test_top_rendition_can_be_a_stream_copy(self):
        cmd = self.build(copy_top=True)
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertTrue(graph.startswith("[0:v]split=2[s0][s1]"), graph)
        self.assertEqual(cmd[cmd.index("-c:v:2") + 1], "copy")
        self.assertNotIn("-crf:v:2", cmd, "no encoder option reaches the copied stream")
        self.assertIn("0:v:0", cmd)

    def test_without_audio(self):
        cmd = build_single_pass_transcode_command(
            ffmpeg_binary="ffmpeg", source_path="/in.mp4", profiles=PROFILES_720[:1], output_dir="/out",
            frame_rate=25.0, has_audio=False,
        )
        self.assertEqual(cmd[cmd.index("-var_stream_map") + 1], "v:0,name:360p")
        self.assertNotIn("-c:a", cmd)
        self.assertNotIn("split", cmd[cmd.index("-filter_complex") + 1])

    @override_settings(COURSE_HLS_TRANSCODE_TIMEOUT_BASE_SECONDS=600, COURSE_HLS_TRANSCODE_TIMEOUT_FACTOR=3,
                       COURSE_HLS_TRANSCODE_MAX_TIMEOUT_SECONDS=7200)
    def test_timeout_scales_with_duration_and_is_capped(self):
        self.assertEqual(resolve_transcode_timeout_seconds(600), 600 + 1800)
        self.assertEqual(resolve_transcode_timeout_seconds(4 * 3600), 7200)
        self.assertEqual(resolve_transcode_timeout_seconds(None), 7200)


class BlueGreenTranscodeTests(TranscodeFixture, TestCase):
    def setUp(self):
        self.build()

    def test_transcode_writes_a_revision_and_swaps_the_manifest(self):
        lecture = self.lecture()
        runner = FakeFfmpeg()
        transcode_lecture_to_hls(lecture, runner=runner)
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_status, Lecture.STREAM_READY)
        self.assertEqual(lecture.stream_revision, 1)
        self.assertTrue(lecture.stream_manifest_key.endswith(f"lecture_{lecture.pk}/v1/master.m3u8"))
        master = (Path(self.media_root) / lecture.stream_manifest_key).read_text(encoding="utf-8")
        for name in ("360p", "540p", "720p"):
            self.assertIn(f"{name}/index.m3u8", master)
        self.assertNotIn("1080p", master)
        self.assertEqual(len(runner.ffmpeg_calls), 1, "a single ffmpeg process for every rendition")
        self.assertEqual(lecture.stream_duration_seconds, 600)
        self.assertEqual(runner.timeouts, [resolve_transcode_timeout_seconds(600)])

    def test_rebuild_keeps_the_old_revision_until_the_grace_period_ends(self):
        lecture = self.lecture()
        transcode_lecture_to_hls(lecture, runner=FakeFfmpeg())
        lecture.refresh_from_db()
        old_dir = (Path(self.media_root) / lecture.stream_manifest_key).parent
        transcode_lecture_to_hls(lecture, runner=FakeFfmpeg())
        lecture.refresh_from_db()
        self.assertTrue(lecture.stream_manifest_key.endswith("/v2/master.m3u8"))
        self.assertTrue(old_dir.is_dir(), "viewers mid-playback keep their segments")
        self.assertEqual(transcode_queue.gc_lecture_stream_revisions(lecture), 0)
        self.assertEqual(transcode_queue.gc_lecture_stream_revisions(lecture, now=time.time() + 7200), 1)
        self.assertFalse(old_dir.exists())
        self.assertTrue((Path(self.media_root) / lecture.stream_manifest_key).is_file())

    def test_legacy_layout_files_are_cleaned_after_the_first_revision(self):
        lecture = self.lecture()
        legacy = Path(self.media_root) / "streams" / self.course.slug / f"lecture_{lecture.pk}"
        (legacy / "360p").mkdir(parents=True)
        (legacy / "360p" / "index.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
        (legacy / "master.m3u8").write_text("#EXTM3U\n", encoding="utf-8")
        Lecture.objects.filter(pk=lecture.pk).update(
            stream_manifest_key=f"streams/{self.course.slug}/lecture_{lecture.pk}/master.m3u8",
            stream_status=Lecture.STREAM_READY,
        )
        lecture.refresh_from_db()
        transcode_lecture_to_hls(lecture, runner=FakeFfmpeg())  # e.g. --force
        lecture.refresh_from_db()
        transcode_queue.gc_lecture_stream_revisions(lecture, now=time.time() + 7200)
        self.assertFalse((legacy / "master.m3u8").exists())
        self.assertFalse((legacy / "360p").exists())
        self.assertTrue((legacy / "v1" / "master.m3u8").is_file())

    def test_ready_lecture_keeps_serving_while_a_forced_rebuild_fails(self):
        lecture = self.lecture()
        transcode_lecture_to_hls(lecture, runner=FakeFfmpeg())
        lecture.refresh_from_db()
        manifest = lecture.stream_manifest_key
        with self.assertRaises(VideoTranscodeError):
            transcode_lecture_to_hls(lecture, runner=FakeFfmpeg(fail="boom"))
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_status, Lecture.STREAM_READY)
        self.assertEqual(lecture.stream_manifest_key, manifest)
        self.assertTrue((Path(self.media_root) / manifest).is_file())

    def test_video_replaced_during_the_transcode_discards_the_output(self):
        lecture = self.lecture()
        runner = FakeFfmpeg()

        def replace_video():
            fresh = Lecture.objects.get(pk=lecture.pk)
            fresh.video_file = SimpleUploadedFile("new.mp4", b"new", content_type="video/mp4")
            fresh.save()

        runner.before_write = replace_video
        with self.assertRaises(TranscodeSuperseded):
            transcode_lecture_to_hls(lecture, runner=runner)
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_manifest_key, "")
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED, "the new video is queued")


class QueueTests(TranscodeFixture, TestCase):
    def setUp(self):
        self.build()

    def test_class_recordings_first_then_oldest(self):
        older = self.lecture("older")
        recording = self.lecture("recording", priority=10)
        claimed = transcode_queue.claim_next(worker="host:1")
        self.assertEqual(claimed.pk, recording.pk)
        self.assertEqual(claimed.stream_status, Lecture.STREAM_PROCESSING)
        self.assertEqual(claimed.stream_attempts, 1)
        self.assertEqual(claimed.stream_claimed_by, "host:1")
        self.assertEqual(transcode_queue.claim_next(worker="host:2").pk, older.pk, "a claimed lecture is skipped")
        self.assertIsNone(transcode_queue.claim_next(worker="host:2"))

    def test_failure_backs_off_then_gives_up_and_alerts(self):
        lecture = self.lecture()
        User.objects.create_user(email="ops@test.com", password="StrongPass@123", is_staff=True)
        now = timezone.now()
        runner = FakeFfmpeg(fail="Invalid data found when processing input")
        self.assertEqual(transcode_queue.process_next(runner=runner, now=now), ("failed", lecture.pk))
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_status, Lecture.STREAM_FAILED)
        self.assertEqual(lecture.stream_attempts, 1)
        self.assertIn("Invalid data", lecture.stream_error)
        self.assertAlmostEqual((lecture.stream_next_attempt_at - now).total_seconds(), 60, delta=5)
        self.assertTrue(transcode_queue.transcode_retry_pending(lecture))
        self.assertIsNone(transcode_queue.process_next(runner=runner, now=now), "not due yet: no hot loop")

        later = now + timedelta(seconds=61)
        self.assertEqual(transcode_queue.process_next(runner=runner, now=later)[0], "failed")
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_attempts, 2)
        self.assertGreater(lecture.stream_next_attempt_at, timezone.now() + timedelta(seconds=250), "300 s next")

        transcode_queue.process_next(runner=runner, now=later + timedelta(seconds=400))
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_attempts, 3)
        self.assertIsNone(lecture.stream_next_attempt_at)
        self.assertTrue(transcode_queue.transcode_exhausted(lecture))
        self.assertIsNone(transcode_queue.process_next(runner=runner, now=later + timedelta(days=1)))
        alert = Notification.objects.filter(event_key__contains=f"lecture-{lecture.pk}:transcode-exhausted").first()
        self.assertIsNotNone(alert, "admins are told once retries are exhausted")

    def test_timeout_is_a_retryable_failure(self):
        lecture = self.lecture()
        runner = FakeFfmpeg(timeout=True)
        self.assertEqual(transcode_queue.process_next(runner=runner), ("failed", lecture.pk))
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_status, Lecture.STREAM_FAILED)
        self.assertIn("timed out", lecture.stream_error)
        self.assertIsNotNone(lecture.stream_next_attempt_at)
        stream_dir = Path(self.media_root) / "streams" / self.course.slug / f"lecture_{lecture.pk}"
        self.assertFalse((stream_dir / "v1").exists(), "partial output is removed")

    def test_retry_succeeds_and_resets_attempts(self):
        lecture = self.lecture()
        now = timezone.now()
        transcode_queue.process_next(runner=FakeFfmpeg(fail="flaky"), now=now)
        self.assertEqual(
            transcode_queue.process_next(runner=FakeFfmpeg(), now=now + timedelta(seconds=120)),
            ("ready", lecture.pk),
        )
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_status, Lecture.STREAM_READY)
        self.assertEqual(lecture.stream_attempts, 0)
        self.assertIsNone(lecture.stream_claimed_at)

    def test_stale_claims_are_reclaimed(self):
        lecture = self.lecture()
        transcode_queue.claim_next(worker="dead-host:7")
        self.assertIsNone(transcode_queue.claim_next(worker="other:1"))
        future = timezone.now() + timedelta(seconds=transcode_queue.claim_lease_seconds() + 60)
        self.assertEqual(transcode_queue.claim_next(worker="other:1", now=future).pk, lecture.pk)

    def test_restart_releases_this_hosts_claims_at_once(self):
        lecture = self.lecture()
        transcode_queue.claim_next(worker="transcoder-a:42")
        self.assertEqual(transcode_queue.release_own_stale_claims(host="transcoder-a"), 1)
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED)
        self.assertEqual(transcode_queue.claim_next(worker="transcoder-a:43").pk, lecture.pk)

    def test_requeue_resets_an_exhausted_lecture(self):
        lecture = self.lecture()
        Lecture.objects.filter(pk=lecture.pk).update(stream_status=Lecture.STREAM_FAILED, stream_attempts=99)
        lecture.refresh_from_db()
        transcode_queue.requeue(lecture)
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED)
        self.assertEqual(lecture.stream_attempts, 0)

    def test_new_video_gets_a_fresh_retry_budget(self):
        lecture = self.lecture()
        Lecture.objects.filter(pk=lecture.pk).update(stream_status=Lecture.STREAM_FAILED, stream_attempts=3)
        lecture.refresh_from_db()
        lecture.video_file = SimpleUploadedFile("better.mp4", b"better", content_type="video/mp4")
        lecture.save()
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_attempts, 0)
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED)

    def test_pending_command_works_the_queue(self):
        lecture = self.lecture()
        with patch("apps.courses.services.subprocess.run", new=FakeFfmpeg()):
            call_command("transcode_lecture_streams", "--pending", stdout=io.StringIO(), stderr=io.StringIO())
        lecture.refresh_from_db()
        self.assertEqual(lecture.stream_status, Lecture.STREAM_READY)
        self.assertIn("/v1/", lecture.stream_manifest_key)
