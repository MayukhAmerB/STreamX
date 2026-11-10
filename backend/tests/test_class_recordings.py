import io
import os
import shutil
import subprocess
import tempfile
import time
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.courses.engagement.models import LectureComment, LectureLike, LectureView
from apps.courses.models import Course, Lecture, LiveClass, Section
from apps.realtime.models import ClassRecording, RealtimeSession, RealtimeSessionRecording
from apps.realtime.recording import publisher, services, state
from apps.realtime.recording.recorder import StreamRecorder

User = get_user_model()
MP4_BYTES = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
R = ClassRecording


def fake_ffmpeg_run(cmd, *args, **kwargs):
    """Stand-in for subprocess.run: ffmpeg writes its output, ffprobe prints a duration."""
    if "ffprobe" in str(cmd[0]):
        return subprocess.CompletedProcess(cmd, 0, stdout="3600.4\n", stderr="")
    Path(cmd[-1]).parent.mkdir(parents=True, exist_ok=True)
    Path(cmd[-1]).write_bytes(MP4_BYTES)
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


class FakeProcess:
    def __init__(self):
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


class RecordingFixtureMixin:
    def build_fixture(self):
        cache.clear()
        self.media_root = tempfile.mkdtemp()
        self.work_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media_root, True)
        self.addCleanup(shutil.rmtree, self.work_root, True)
        overrides = override_settings(
            MEDIA_ROOT=self.media_root,
            STREAM_RECORDER_ENABLED=True,
            STREAM_RECORDER_WORK_DIR=self.work_root,
            STREAM_RECORDER_MIN_FREE_BYTES=0,
            STREAM_RECORDER_NICE=0,
            STREAM_RECORDER_FILE_SETTLE_SECONDS=0,
            LIVEKIT_RECORDING_LOCAL_OUTPUT_ROOT=self.work_root,
            OWNCAST_ADMIN_PASSWORD="",
        )
        overrides.enable()
        self.addCleanup(overrides.disable)

        self.admin = User.objects.create_superuser(email="rec-admin@test.com", password="StrongPass@123")
        self.instructor = User.objects.create_user(
            email="rec-instructor@test.com", password="StrongPass@123", full_name="Instructor", role="instructor"
        )
        self.other_instructor = User.objects.create_user(
            email="rec-other@test.com", password="StrongPass@123", full_name="Other", role="instructor"
        )
        self.student = User.objects.create_user(email="rec-student@test.com", password="StrongPass@123")
        self.course = Course.objects.create(
            title="OSINT Batch", description="d", price=Decimal("1.00"), instructor=self.instructor, is_published=True
        )
        self.other_course = Course.objects.create(
            title="Other", description="d", price=Decimal("1.00"), instructor=self.other_instructor
        )
        self.module = Section.objects.create(
            course=self.course, title="Recon", description="Reconnaissance module notes.", order=1
        )
        self.module2 = Section.objects.create(course=self.course, title="Dorking", order=2)
        self.foreign_module = Section.objects.create(course=self.other_course, title="Foreign", order=1)
        Lecture.objects.create(section=self.module, title="Existing", video_key="videos/x.mp4", order=3)
        self.live_class = LiveClass.objects.create(
            title="Friday Live", description="Live", price=Decimal("0.00"), linked_course=self.course
        )
        self.session = self.make_session()

    def make_session(self, **overrides):
        values = dict(
            title="Recon Class",
            host=self.instructor,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            status=RealtimeSession.STATUS_LIVE,
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            linked_live_class=self.live_class,
            target_module=self.module,
            started_at=timezone.now(),
        )
        values.update(overrides)
        return RealtimeSession.objects.create(**values)

    def write_parts(self, recording, *payloads):
        work_dir = Path(recording.work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        for index, payload in enumerate(payloads, start=1):
            (work_dir / f"part-{index:04d}.ts").write_bytes(payload)
        return work_dir


class ModuleTaggingTests(RecordingFixtureMixin, APITestCase):
    def setUp(self):
        self.build_fixture()

    def test_model_rejects_module_of_another_course(self):
        self.session.target_module = self.foreign_module
        with self.assertRaises(ValidationError) as ctx:
            self.session.clean()
        self.assertIn("target_module", ctx.exception.message_dict)
        self.session.target_module = self.module2
        self.session.clean()

    def _create(self, **extra):
        payload = {
            "title": "Tagged",
            "session_type": "broadcasting",
            "stream_service": "alsyed_stream",
            "linked_live_class_id": self.live_class.id,
            **extra,
        }
        self.client.force_authenticate(self.instructor)
        return self.client.post(reverse("realtime-session-list-create"), payload, format="json")

    def test_create_api_validates_and_exposes_module(self):
        bad = self._create(target_module_id=self.foreign_module.id)
        self.assertEqual(bad.status_code, 400)
        self.assertIn("target_module_id", bad.data["errors"])
        good = self._create(target_module_id=self.module2.id)
        self.assertEqual(good.status_code, 201)
        self.assertEqual(good.data["data"]["target_module"], {"id": self.module2.id, "title": "Dorking", "course_id": self.course.id})

    def test_module_can_be_required_for_broadcasts(self):
        self.assertEqual(self._create().status_code, 201)
        with override_settings(REALTIME_BROADCAST_REQUIRE_TARGET_MODULE=True):
            response = self._create()
        self.assertEqual(response.status_code, 400)
        self.assertIn("target_module_id", response.data["errors"])

    def test_patch_updates_module_with_validation_and_permissions(self):
        url = reverse("realtime-session-detail", kwargs={"pk": self.session.id})
        self.client.force_authenticate(self.student)
        self.assertEqual(self.client.patch(url, {"target_module_id": self.module2.id}, format="json").status_code, 403)
        self.client.force_authenticate(self.instructor)
        self.assertEqual(
            self.client.patch(url, {"target_module_id": self.foreign_module.id}, format="json").status_code, 400
        )
        ok = self.client.patch(url, {"target_module_id": self.module2.id}, format="json")
        self.assertEqual(ok.status_code, 200)
        self.session.refresh_from_db()
        self.assertEqual(self.session.target_module_id, self.module2.id)

    def test_module_options_for_picker(self):
        url = reverse("realtime-module-options")
        self.client.force_authenticate(self.instructor)
        response = self.client.get(url, {"live_class_id": self.live_class.id})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["id"] for row in response.data["data"]["modules"]], [self.module.id, self.module2.id])
        self.assertEqual(response.data["data"]["modules"][0]["lecture_count"], 1)
        self.client.force_authenticate(self.other_instructor)
        self.assertEqual(self.client.get(url, {"course_id": self.course.id}).status_code, 403)
        self.client.force_authenticate(self.admin)
        self.assertEqual(self.client.get(url, {"course_id": self.course.id}).status_code, 200)
        self.assertEqual(self.client.get(url).status_code, 400)


class RecordingStateMachineTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()

    def test_transitions_are_compare_and_set(self):
        recording = services.ensure_server_recording(self.session, user=self.instructor)
        self.assertTrue(state.transition(recording, R.STATE_FINALIZING, reason="t"))
        self.assertFalse(state.transition(recording, R.STATE_FINALIZING, reason="t"))
        self.assertTrue(state.transition(recording, R.STATE_PROCESSING, reason="t"))
        stale = R.objects.get(pk=recording.pk)
        stale.state = R.STATE_RECORDING  # an outdated in-memory copy (e.g. a double-click)
        self.assertFalse(state.transition(stale, R.STATE_FINALIZING, reason="double_click"))
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PROCESSING)
        self.assertTrue(state.transition(recording, R.STATE_PUBLISHED, reason="t"))
        self.assertFalse(state.transition(recording, R.STATE_FAILED, error="late failure"))
        self.assertFalse(state.can_transition(R.STATE_PUBLISHED, R.STATE_FAILED))
        self.assertFalse(state.can_transition(R.STATE_PROCESSING, R.STATE_RECORDING))

    def test_ensure_server_recording_is_idempotent(self):
        first = services.ensure_server_recording(self.session, user=self.instructor)
        second = services.ensure_server_recording(self.session, user=self.instructor)
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(R.objects.count(), 1)
        self.assertEqual(first.module_id, self.module.id)
        self.assertTrue(first.work_dir.startswith(self.work_root))

    def test_recording_requires_enabled_recorder_and_obs_session(self):
        with override_settings(STREAM_RECORDER_ENABLED=False):
            self.assertIsNone(services.ensure_server_recording(self.session))
        studio = self.make_session(title="Studio", stream_service=RealtimeSession.STREAM_SERVICE_ALSYED)
        self.assertIsNone(services.ensure_server_recording(studio))

    def test_new_session_supersedes_capture_of_previous_one(self):
        first = services.ensure_server_recording(self.session)
        services.ensure_server_recording(self.make_session(title="Next class"))
        first.refresh_from_db()
        self.assertEqual(first.state, R.STATE_FINALIZING)

    def test_restart_while_previous_take_finalizes_starts_new_take(self):
        first = services.ensure_server_recording(self.session)
        services.request_finalize(self.session, reason="stream_stopped")
        second = services.ensure_server_recording(self.session)
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual(services.ensure_server_recording(self.session).pk, second.pk)

    def test_request_finalize_is_idempotent(self):
        recording = services.ensure_server_recording(self.session)
        services.request_finalize(self.session, reason="stream_stopped")
        services.request_finalize(self.session, reason="stream_stopped")
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FINALIZING)
        self.assertIsNotNone(recording.stop_requested_at)


@patch("apps.realtime.views.sync_owncast_stream_key", return_value={"success": True})
@patch("apps.realtime.views.refresh_obs_session_stream_health", return_value={})
class StreamEndpointHookTests(RecordingFixtureMixin, APITestCase):
    def setUp(self):
        self.build_fixture()
        self.client.force_authenticate(self.instructor)

    @override_settings(OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key")
    def test_start_stop_and_double_click_create_one_recording(self, _refresh, _sync):
        start = reverse("realtime-session-stream-start", kwargs={"pk": self.session.id})
        stop = reverse("realtime-session-stream-stop", kwargs={"pk": self.session.id})
        self.assertEqual(self.client.post(start).status_code, 200)
        self.assertEqual(self.client.post(start).status_code, 200)
        self.assertEqual(R.objects.filter(session=self.session).count(), 1)
        self.assertEqual(self.client.post(stop).status_code, 200)
        self.assertEqual(self.client.post(stop).status_code, 200)
        recording = R.objects.get(session=self.session)
        self.assertEqual(recording.state, R.STATE_FINALIZING)

    def test_end_session_requests_finalize(self, _refresh, _sync):
        recording = services.ensure_server_recording(self.session)
        response = self.client.post(reverse("realtime-session-end", kwargs={"pk": self.session.id}))
        self.assertEqual(response.status_code, 200)
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FINALIZING)

    def test_recording_failure_never_breaks_stream_stop(self, _refresh, _sync):
        services.ensure_server_recording(self.session)
        with patch("apps.realtime.recording.services.request_finalize", side_effect=RuntimeError("db down")):
            response = self.client.post(reverse("realtime-session-stream-stop", kwargs={"pk": self.session.id}))
        self.assertEqual(response.status_code, 200)


@patch("apps.realtime.recording.ffmpeg.subprocess.run", side_effect=fake_ffmpeg_run)
class FinalizeIntoModuleTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.recorder = StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": False})

    def _finalizing_recording(self, *parts):
        recording = services.ensure_server_recording(self.session, user=self.instructor)
        self.write_parts(recording, *parts)
        services.request_finalize(self.session, reason="stream_stopped")
        return recording

    def test_stop_creates_lecture_at_end_of_tagged_module(self, mock_run):
        recording = self._finalizing_recording(b"a" * 10, b"b" * 10)
        work_dir = Path(recording.work_dir)
        self.recorder.tick()

        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PROCESSING)
        lecture = recording.lecture
        self.assertEqual(lecture.section_id, self.module.id)
        self.assertEqual(lecture.order, 4)
        self.assertTrue(lecture.title.startswith("Recon Class - "))
        self.assertEqual(lecture.description, "Reconnaissance module notes.")
        self.assertFalse(lecture.is_published)
        self.assertEqual(lecture.stream_status, Lecture.STREAM_UPLOADED)
        self.assertTrue(lecture.video_file.name.startswith(f"lecture_videos/osint-batch/module_{self.module.id}/"))
        self.assertTrue(Path(lecture.video_file.path).exists())
        self.assertEqual(recording.file_size_bytes, len(MP4_BYTES))
        self.assertEqual(recording.duration_seconds, 3600)
        self.assertFalse(work_dir.exists(), "parts are deleted once the MP4 exists")

        concat_cmd = mock_run.call_args_list[0].args[0]
        self.assertIn("concat", concat_cmd)
        self.assertEqual(concat_cmd[concat_cmd.index("-c") + 1], "copy")
        self.assertIn("+faststart", concat_cmd)

    def test_finalize_is_idempotent(self, _run):
        recording = self._finalizing_recording(b"a" * 10)
        self.recorder.tick()
        self.recorder.tick()
        recording.refresh_from_db()
        publisher.create_lecture(recording, self.module, storage_name="lecture_videos/dup.mp4")
        publisher.finalize_into_lecture(recording, [], list_path=None)
        self.assertEqual(Lecture.objects.filter(section=self.module).count(), 2)  # existing + one recording

    def test_missing_module_fails_and_retry_publishes_after_tagging(self, _run):
        self.session.target_module = None
        self.session.save()
        recording = self._finalizing_recording(b"a" * 10)
        R.objects.filter(pk=recording.pk).update(module=None)
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FAILED)
        self.assertIn("No target module", recording.error)
        self.assertTrue(Path(recording.work_dir).exists(), "parts are kept for retry")

        self.session.target_module = self.module2
        self.session.save()
        self.assertTrue(services.retry(recording))
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PROCESSING)
        self.assertEqual(recording.lecture.section_id, self.module2.id)
        self.assertEqual(recording.attempts, 1)

    def test_second_take_becomes_part_two(self, _run):
        first = self._finalizing_recording(b"a")
        self.recorder.tick()
        second = self._finalizing_recording(b"b")
        self.assertNotEqual(first.pk, second.pk)
        self.recorder.tick()
        second.refresh_from_db()
        self.assertTrue(second.lecture.title.endswith("(part 2)"))
        self.assertEqual(second.lecture.order, 5)

    def test_no_captured_parts_fails_cleanly(self, _run):
        recording = self._finalizing_recording()
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FAILED)
        self.assertFalse(Lecture.objects.filter(section=self.module, title__startswith="Recon Class").exists())

    def test_publish_when_hls_ready_and_self_heal_after_transcode_failure(self, _run):
        recording = self._finalizing_recording(b"a")
        self.recorder.tick()
        recording.refresh_from_db()
        lecture = recording.lecture

        Lecture.objects.filter(pk=lecture.pk).update(stream_status=Lecture.STREAM_FAILED, stream_error="bad codec")
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FAILED)
        self.assertIn("bad codec", recording.error)

        Lecture.objects.filter(pk=lecture.pk).update(
            stream_status=Lecture.STREAM_READY, stream_manifest_key="streams/x/master.m3u8", stream_error=""
        )
        self.recorder.tick()
        recording.refresh_from_db()
        lecture.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PUBLISHED)
        self.assertIsNotNone(recording.published_at)
        self.assertTrue(lecture.is_published)

    def test_livekit_egress_output_is_published_into_module(self, _run):
        studio = self.make_session(title="Studio Class", stream_service=RealtimeSession.STREAM_SERVICE_ALSYED)
        egress_file = Path(self.work_root) / "broadcasting" / "studio.mp4"
        egress_file.parent.mkdir(parents=True)
        egress_file.write_bytes(MP4_BYTES)
        os.utime(egress_file, (time.time() - 60, time.time() - 60))
        egress = RealtimeSessionRecording.objects.create(
            session=studio,
            status=RealtimeSessionRecording.STATUS_COMPLETED,
            output_file_path="/recordings/broadcasting/studio.mp4",
            started_at=timezone.now(),
        )
        first = services.enqueue_egress_publish(egress)
        self.assertEqual(services.enqueue_egress_publish(egress).pk, first.pk)
        self.recorder.tick()
        first.refresh_from_db()
        self.assertEqual(first.state, R.STATE_PROCESSING)
        self.assertEqual(first.source, R.SOURCE_LIVEKIT_EGRESS)
        self.assertEqual(first.lecture.section_id, self.module.id)
        self.assertTrue(egress_file.exists(), "the LiveKit original is left in place")


class CaptureLoopTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.clock = [100.0]
        self.processes = []

        def popen(cmd, **kwargs):
            Path(cmd[-1]).write_bytes(b"ts")
            process = FakeProcess()
            process.cmd = cmd
            self.processes.append(process)
            return process

        self.online = {"online": True}
        self.recorder = StreamRecorder(
            popen=popen, monotonic=lambda: self.clock[0], owncast_status=lambda **_: self.online
        )
        self.addCleanup(self.recorder.shutdown)
        self.recording = services.ensure_server_recording(self.session)

    def test_one_copy_capture_per_connection_and_new_part_after_reconnect(self):
        self.recorder.capture_active()
        self.recorder.capture_active()
        self.assertEqual(len(self.processes), 1)
        cmd = self.processes[0].cmd
        self.assertEqual(cmd[cmd.index("-c") + 1], "copy")
        # ffmpeg reads Owncast through the recorder's local playlist filter.
        source = cmd[cmd.index("-i") + 1]
        self.assertTrue(source.startswith("http://127.0.0.1:"), source)
        self.assertTrue(source.endswith("/hls/stream.m3u8"), source)
        self.assertEqual(cmd[cmd.index("-live_start_index") + 1], "0")
        self.assertTrue(cmd[-1].endswith("part-0001.ts"))

        self.processes[0].returncode = 1  # OBS dropped; ffmpeg exits
        self.clock[0] += 10
        self.recorder.capture_active()
        self.assertEqual(len(self.processes), 2)
        self.assertTrue(self.processes[1].cmd[-1].endswith("part-0002.ts"))

    def test_obs_reconnect_cuts_a_new_part(self):
        self.online = {"online": True, "lastConnectTime": "2026-11-10T10:00:00Z"}
        self.recorder.capture_active()
        self.online = {"online": True, "lastConnectTime": "2026-11-10T10:05:00Z"}
        self.recorder.capture_active()
        self.assertTrue(self.processes[0].terminated)
        self.assertEqual(len(self.processes), 2)
        self.assertTrue(self.processes[1].cmd[-1].endswith("part-0002.ts"))

    def test_waits_while_owncast_is_offline(self):
        self.online = {"online": False}
        self.recorder.capture_active()
        self.assertEqual(self.processes, [])

    def test_stop_terminates_capture(self):
        self.recorder.capture_active()
        services.request_finalize(self.session, reason="stream_stopped")
        with patch("apps.realtime.recording.ffmpeg.subprocess.run", side_effect=fake_ffmpeg_run):
            self.recorder.tick()
        self.assertTrue(self.processes[0].terminated)
        self.recording.refresh_from_db()
        self.assertEqual(self.recording.state, R.STATE_PROCESSING)

    def test_ended_session_is_finalized_by_recorder(self):
        self.recorder.capture_active()
        RealtimeSession.objects.filter(pk=self.session.pk).update(status=RealtimeSession.STATUS_ENDED)
        self.recorder.capture_active()
        self.recording.refresh_from_db()
        self.assertEqual(self.recording.state, R.STATE_FINALIZING)
        self.assertTrue(self.processes[0].terminated)

    def test_management_command_runs_a_single_tick(self):
        services.request_finalize(self.session, reason="stream_stopped")
        with patch("apps.realtime.services.get_owncast_public_status", return_value={"online": False}):
            call_command("run_stream_recorder", "--once", stdout=io.StringIO())
        self.recording.refresh_from_db()
        self.assertEqual(self.recording.state, R.STATE_FAILED)  # nothing was captured

    @override_settings(STREAM_RECORDER_MAX_BYTES=4)
    def test_size_cap_pauses_capture(self):
        self.write_parts(self.recording, b"12345")
        self.recorder.capture_active()
        self.assertEqual(self.processes, [])
        self.recording.refresh_from_db()
        self.assertIn("size_cap_reached", self.recording.error)
        self.assertEqual(self.recording.state, R.STATE_RECORDING)


class ObsReplacementTests(RecordingFixtureMixin, APITestCase):
    def setUp(self):
        self.build_fixture()
        self.lecture = Lecture.objects.create(
            section=self.module,
            title="Recon Class - 01 Jan 2026",
            video_file=SimpleUploadedFile("server.mp4", MP4_BYTES, content_type="video/mp4"),
            stream_manifest_key="streams/osint-batch/lecture_9/master.m3u8",
            order=4,
        )
        self.recording = R.objects.create(
            session=self.session,
            module=self.module,
            lecture=self.lecture,
            source=R.SOURCE_SERVER,
            state=R.STATE_PUBLISHED,
        )
        LectureLike.objects.create(lecture=self.lecture, user=self.student)
        LectureComment.objects.create(lecture=self.lecture, user=self.student, body="nice")
        LectureView.objects.create(lecture=self.lecture, viewer_key="u:1", view_date=timezone.localdate())

    def _upload(self, url, user, name="obs.mp4", payload=MP4_BYTES):
        self.client.force_authenticate(user)
        upload = SimpleUploadedFile(name, payload, content_type="video/mp4")
        return self.client.post(url, {"video_file": upload}, format="multipart")

    def test_replacement_keeps_lecture_identity_and_engagement(self):
        old_name = self.lecture.video_file.name
        url = reverse("realtime-class-recording-obs-upload", kwargs={"recording_id": self.recording.id})
        with self.captureOnCommitCallbacks(execute=True):
            response = self._upload(url, self.instructor)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["data"]["source"], "obs_upload")
        self.assertEqual(response.data["data"]["lecture"]["id"], self.lecture.id)

        self.lecture.refresh_from_db()
        self.assertNotEqual(self.lecture.video_file.name, old_name)
        self.assertEqual(self.lecture.stream_status, Lecture.STREAM_UPLOADED)
        self.assertEqual(self.lecture.stream_manifest_key, "")
        self.assertTrue(self.lecture.is_published)
        self.assertEqual(Lecture.objects.filter(section=self.module).count(), 2)
        self.assertEqual(self.lecture.likes.count(), 1)
        self.assertEqual(self.lecture.comments.count(), 1)
        self.assertEqual(self.lecture.engagement_views.count(), 1)
        self.assertFalse((Path(self.media_root) / old_name).exists())

    def test_session_upload_creates_lecture_when_no_recording_exists(self):
        fresh = self.make_session(title="Unrecorded", target_module=self.module2)
        response = self._upload(
            reverse("realtime-session-class-recording-obs-upload", kwargs={"pk": fresh.id}), self.instructor
        )
        self.assertEqual(response.status_code, 201)
        lecture = Lecture.objects.get(pk=response.data["data"]["lecture"]["id"])
        self.assertEqual(lecture.section_id, self.module2.id)
        self.assertFalse(lecture.is_published)

    def test_permissions_and_file_validation(self):
        url = reverse("realtime-class-recording-obs-upload", kwargs={"recording_id": self.recording.id})
        self.assertEqual(self._upload(url, self.student).status_code, 403)
        self.assertEqual(self._upload(url, self.instructor, name="obs.mkv").status_code, 400)
        self.assertEqual(self._upload(url, self.instructor, payload=b"not a video at all").status_code, 400)
        self.assertEqual(R.objects.filter(source=R.SOURCE_OBS_UPLOAD).count(), 0)

    def test_session_recording_list_for_managers(self):
        url = reverse("realtime-session-class-recordings", kwargs={"pk": self.session.id})
        self.client.force_authenticate(self.student)
        self.assertEqual(self.client.get(url).status_code, 403)
        self.client.force_authenticate(self.instructor)
        data = self.client.get(url).data["data"]
        self.assertEqual(data[0]["id"], self.recording.id)
        self.assertTrue(data[0]["can_replace"])


class ClassRecordingAdminTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.client.force_login(self.admin)

    def test_changelist_and_retry_action(self):
        failed = R.objects.create(
            session=self.session, module=self.module, source=R.SOURCE_SERVER, state=R.STATE_FAILED, error="x"
        )
        published = R.objects.create(session=self.session, source=R.SOURCE_SERVER, state=R.STATE_PUBLISHED)
        url = reverse("admin:realtime_classrecording_changelist")
        self.assertEqual(self.client.get(url).status_code, 200)
        self.client.post(url, {"action": "retry_selected", "_selected_action": [failed.id, published.id]})
        failed.refresh_from_db()
        published.refresh_from_db()
        self.assertEqual(failed.state, R.STATE_FINALIZING)
        self.assertEqual(published.state, R.STATE_PUBLISHED)

    def test_admin_obs_upload_view(self):
        recording = R.objects.create(session=self.session, module=self.module, source=R.SOURCE_SERVER, state=R.STATE_FAILED)
        url = reverse("admin:realtime_classrecording_obs_upload", args=[recording.id])
        self.assertEqual(self.client.get(url).status_code, 200)
        upload = SimpleUploadedFile("obs.mp4", MP4_BYTES, content_type="video/mp4")
        response = self.client.post(url, {"video_file": upload})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(R.objects.filter(source=R.SOURCE_OBS_UPLOAD, lecture__section=self.module).exists())

    def test_session_admin_filters_modules_to_course(self):
        response = self.client.get(reverse("admin:realtime_realtimesession_change", args=[self.session.id]))
        self.assertEqual(response.status_code, 200)
        queryset = response.context["adminform"].form.fields["target_module"].queryset
        self.assertEqual(set(queryset.values_list("id", flat=True)), {self.module.id, self.module2.id})
