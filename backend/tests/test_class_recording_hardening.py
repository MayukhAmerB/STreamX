"""Class recordings: publish-time notifications, disk-space guard, retention
sweep, finalize off the capture loop, visible no-module failures and OBS MKV
uploads (remuxed by the recorder, never on a web worker)."""

import os
import subprocess
import threading
import time
from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.courses.models import Enrollment, Lecture
from apps.notifications.models import Notification
from apps.realtime.management.commands.run_stream_recorder import LEADER_KEY, LeaderLease
from apps.realtime.models import ClassRecording, RealtimeSession, RealtimeSessionRecording
from apps.realtime.recording import config, ffmpeg, publisher, replacement, services
from apps.realtime.recording.recorder import ORPHAN_GRACE_SECONDS, StreamRecorder
from config.upload_validators import validate_obs_recording_upload, validate_video_upload
from tests.test_class_recordings import MP4_BYTES, FakeProcess, RecordingFixtureMixin, fake_ffmpeg_run

R = ClassRecording
MKV_BYTES = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01" + b"matroska" + b"\x00" * 64
FLV_BYTES = b"FLV\x01\x05\x00\x00\x00\x09" + b"\x00" * 64
TS_BYTES = (b"\x47" + b"\x00" * 187) * 3
FFMPEG_RUN = "apps.realtime.recording.ffmpeg.subprocess.run"


def offline_recorder(**kwargs):
    return StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": False}, **kwargs)


def make_old(path, seconds):
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


# --------------------------------------------------------------------------
# 3. Notifications only once the lecture is visible
# --------------------------------------------------------------------------


@patch(FFMPEG_RUN, side_effect=fake_ffmpeg_run)
class PublishTimeNotificationTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        Enrollment.objects.create(
            user=self.student, course=self.course, payment_status=Enrollment.STATUS_PAID,
            access_type=Enrollment.ACCESS_LIFETIME,
        )
        self.recorder = offline_recorder()

    def notes(self, lecture):
        return Notification.objects.filter(lecture=lecture)

    def mark_hls_ready(self, lecture):
        Lecture.objects.filter(pk=lecture.pk).update(
            stream_status=Lecture.STREAM_READY, stream_manifest_key=f"streams/x/{lecture.pk}/master.m3u8"
        )

    def test_unpublished_recording_lecture_does_not_notify(self, _run):
        recording = R.objects.create(
            session=self.session, module=self.module, source=R.SOURCE_SERVER, state=R.STATE_FINALIZING
        )
        lecture = publisher.create_lecture(recording, self.module, storage_name="lecture_videos/x/module_1/rec.mp4")

        self.assertFalse(lecture.is_published)
        self.assertFalse(self.notes(lecture).exists())

    def test_recording_notifies_exactly_once_when_published(self, _run):
        recording = services.ensure_server_recording(self.session, user=self.instructor)
        self.write_parts(recording, b"a" * 10)
        services.request_finalize(self.session, reason="stream_stopped")
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertFalse(self.notes(recording.lecture).exists())

        self.mark_hls_ready(recording.lecture)
        self.recorder.tick()
        self.recorder.tick()

        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PUBLISHED)
        self.assertEqual(self.notes(recording.lecture).count(), 1)
        self.assertIn("is now available", self.notes(recording.lecture).get().body)

    def test_obs_replacement_of_a_published_lecture_does_not_notify_again(self, _run):
        lecture = Lecture.objects.create(
            section=self.module,
            title="Recon Class - 01 Jan 2026",
            video_file=SimpleUploadedFile("server.mp4", MP4_BYTES, content_type="video/mp4"),
            order=4,
            is_published=True,
        )
        self.assertEqual(self.notes(lecture).count(), 1)
        recording = R.objects.create(
            session=self.session, module=self.module, lecture=lecture, source=R.SOURCE_SERVER,
            state=R.STATE_PUBLISHED,
        )
        upload = SimpleUploadedFile("obs.mp4", MP4_BYTES, content_type="video/mp4")

        with self.captureOnCommitCallbacks(execute=True):
            replaced = replacement.replace_with_obs_upload(
                session=self.session, uploaded_file=upload, user=self.instructor, recording=recording
            )
        self.mark_hls_ready(lecture)
        self.recorder.tick()

        replaced.refresh_from_db()
        self.assertEqual(replaced.state, R.STATE_PUBLISHED)
        self.assertEqual(self.notes(lecture).count(), 1)

    def test_obs_upload_that_creates_the_lecture_notifies_at_publish(self, _run):
        fresh = self.make_session(title="Unrecorded", target_module=self.module2)
        upload = SimpleUploadedFile("obs.mp4", MP4_BYTES, content_type="video/mp4")

        created = replacement.replace_with_obs_upload(session=fresh, uploaded_file=upload, user=self.instructor)
        self.assertFalse(self.notes(created.lecture).exists())
        self.mark_hls_ready(created.lecture)
        self.recorder.tick()

        created.refresh_from_db()
        self.assertEqual(created.state, R.STATE_PUBLISHED)
        self.assertEqual(self.notes(created.lecture).count(), 1)

    def test_regular_lecture_uploads_still_notify(self, _run):
        published = Lecture.objects.create(section=self.module2, title="Uploaded", video_key="videos/up.mp4")
        self.assertEqual(self.notes(published).count(), 1)

        draft = Lecture.objects.create(
            section=self.module2, title="Draft", video_key="videos/draft.mp4", is_published=False
        )
        self.assertFalse(self.notes(draft).exists())
        draft.is_published = True
        draft.save()
        self.assertEqual(self.notes(draft).count(), 1)

        published.video_key = "videos/up-v2.mp4"
        published.save()
        self.assertEqual(self.notes(published).count(), 2)


# --------------------------------------------------------------------------
# 5. Finalize never fills the disk; retention sweep
# --------------------------------------------------------------------------


@patch(FFMPEG_RUN, side_effect=fake_ffmpeg_run)
class FinalizeDiskSpaceTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.recorder = offline_recorder()

    def finalizing(self, *parts):
        recording = services.ensure_server_recording(self.session, user=self.instructor)
        self.write_parts(recording, *parts)
        services.request_finalize(self.session, reason="stream_stopped")
        return recording

    @override_settings(STREAM_RECORDER_MIN_FREE_BYTES=100, STREAM_RECORDER_FINALIZE_SPACE_FACTOR=2.0)
    def test_low_disk_fails_retryably_keeps_parts_and_never_starts_ffmpeg(self, mock_run):
        recording = self.finalizing(b"a" * 10, b"b" * 10)  # needs 20 x 2 + 100 = 140 bytes free

        with patch("apps.realtime.recording.publisher.free_disk_bytes", return_value=139):
            self.recorder.tick()

        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FAILED)
        self.assertIn("Not enough free disk space", recording.error)
        self.assertIn("retry", recording.error)
        mock_run.assert_not_called()
        self.assertEqual(len(list(Path(recording.work_dir).glob("part-*.ts"))), 2, "parts are kept")
        self.assertTrue(services.can_retry(recording))

        self.assertTrue(services.retry(recording))
        with patch("apps.realtime.recording.publisher.free_disk_bytes", return_value=140):
            self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PROCESSING)

    @override_settings(STREAM_RECORDER_MIN_FREE_BYTES=0, STREAM_RECORDER_FINALIZE_SPACE_FACTOR=3.0)
    def test_transcode_headroom_factor_is_applied(self, _run):
        recording = self.finalizing(b"a" * 100)

        with patch("apps.realtime.recording.publisher.free_disk_bytes", return_value=299):
            self.recorder.tick()

        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FAILED)
        self.assertIn("x 3", recording.error)


@override_settings(STREAM_RECORDER_FAILED_RETENTION_DAYS=7)
class RetentionSweepTests(RecordingFixtureMixin, TestCase):
    def setUp(self):
        self.build_fixture()
        self.recorder = offline_recorder()

    def failed_with_parts(self, *, age_days):
        recording = R.objects.create(
            session=self.session, module=self.module, source=R.SOURCE_SERVER, state=R.STATE_FAILED, error="x"
        )
        R.objects.filter(pk=recording.pk).update(
            work_dir=str(Path(self.work_root) / f"class-recording-{recording.pk}"),
            updated_at=timezone.now() - timedelta(days=age_days),
        )
        recording.refresh_from_db()
        self.write_parts(recording, b"part")
        return recording

    def test_failed_parts_are_kept_within_retention_and_swept_after(self):
        fresh = self.failed_with_parts(age_days=6)
        expired = self.failed_with_parts(age_days=8)

        self.recorder.sweep_stale_files()

        self.assertTrue(Path(fresh.work_dir).exists(), "retryable within retention")
        self.assertFalse(Path(expired.work_dir).exists())
        expired.refresh_from_db()
        self.assertEqual(expired.state, R.STATE_FAILED)
        self.assertIn("deleted after 7 days", expired.error)
        self.assertLess(expired.updated_at, timezone.now() - timedelta(days=7), "sweeping keeps the row's age")

    def test_orphaned_work_dirs_are_swept_but_live_ones_never(self):
        orphan = Path(self.work_root) / "class-recording-999999"
        orphan.mkdir()
        (orphan / "part-0001.ts").write_bytes(b"x")
        make_old(orphan, ORPHAN_GRACE_SECONDS + 60)
        young_orphan = Path(self.work_root) / "class-recording-999998"
        young_orphan.mkdir()
        live = services.ensure_server_recording(self.session)
        self.write_parts(live, b"live")
        make_old(Path(live.work_dir), 30 * 86400)
        unrelated = Path(self.work_root) / "broadcasting"
        unrelated.mkdir()
        make_old(unrelated, 30 * 86400)

        self.recorder.sweep_stale_files()

        self.assertFalse(orphan.exists())
        self.assertTrue(young_orphan.exists(), "grace period for brand-new dirs")
        self.assertTrue(Path(live.work_dir).exists(), "a recording in progress is never touched")
        self.assertTrue(unrelated.exists(), "only class-recording-<id> dirs are managed")

    def test_leftover_dir_of_a_published_recording_is_swept(self):
        done = R.objects.create(session=self.session, source=R.SOURCE_SERVER, state=R.STATE_PUBLISHED)
        leftover = Path(self.work_root) / f"class-recording-{done.pk}"
        leftover.mkdir()
        make_old(leftover, ORPHAN_GRACE_SECONDS + 60)

        self.recorder.sweep_stale_files()

        self.assertFalse(leftover.exists())

    def test_staged_obs_uploads_are_swept_when_expired_or_orphaned(self):
        staging = Path(self.media_root) / config.OBS_UPLOAD_STAGING_DIR
        staging.mkdir(parents=True)
        expired_file = staging / "expired.mkv"
        expired_file.write_bytes(MKV_BYTES)
        orphan_file = staging / "orphan.mkv"
        orphan_file.write_bytes(MKV_BYTES)
        make_old(orphan_file, ORPHAN_GRACE_SECONDS + 60)
        kept_file = staging / "kept.mkv"
        kept_file.write_bytes(MKV_BYTES)
        make_old(kept_file, ORPHAN_GRACE_SECONDS + 60)
        target = Lecture.objects.create(section=self.module, title="Target", video_key="videos/t.mp4")
        expired = R.objects.create(
            session=self.session, module=self.module, lecture=target, source=R.SOURCE_OBS_UPLOAD,
            state=R.STATE_FAILED, source_path=f"{config.OBS_UPLOAD_STAGING_DIR}/expired.mkv", error="remux failed",
        )
        R.objects.filter(pk=expired.pk).update(updated_at=timezone.now() - timedelta(days=8))
        kept = R.objects.create(
            session=self.session, module=self.module, lecture=target, source=R.SOURCE_OBS_UPLOAD,
            state=R.STATE_FAILED, source_path=f"{config.OBS_UPLOAD_STAGING_DIR}/kept.mkv", error="remux failed",
        )

        self.recorder.sweep_stale_files()

        self.assertFalse(expired_file.exists())
        self.assertFalse(orphan_file.exists())
        self.assertTrue(kept_file.exists(), "retryable within retention")
        expired.refresh_from_db()
        self.assertEqual(expired.source_path, "")
        self.assertIsNone(expired.lecture_id)
        self.assertFalse(services.can_retry(expired))
        kept.refresh_from_db()
        self.assertTrue(services.can_retry(kept))

    def test_tick_runs_the_sweep_at_most_once_per_interval(self):
        with patch.object(StreamRecorder, "sweep_stale_files") as sweep:
            self.recorder.tick()
            self.recorder.tick()
        self.assertEqual(sweep.call_count, 1)


# --------------------------------------------------------------------------
# b. Finalize runs off the capture loop; the leader lease renews on its own
# --------------------------------------------------------------------------


class BackgroundFinalizeTests(RecordingFixtureMixin, TransactionTestCase):
    def setUp(self):
        self.build_fixture()
        self.processes = []

        def popen(cmd, **kwargs):
            Path(cmd[-1]).write_bytes(b"ts")
            process = FakeProcess()
            process.cmd = cmd
            self.processes.append(process)
            return process

        self.recorder = StreamRecorder(
            popen=popen, owncast_status=lambda **_: {"online": True}, background_finalize=True
        )
        self.addCleanup(self.recorder.shutdown)

    def wait_for(self, condition, timeout=10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return True
            time.sleep(0.02)
        return False

    def test_a_new_class_starts_capturing_while_a_long_finalize_runs(self):
        first = services.ensure_server_recording(self.session, user=self.instructor)
        self.write_parts(first, b"a" * 10)
        services.request_finalize(self.session, reason="stream_stopped")
        concat_started = threading.Event()
        release_concat = threading.Event()

        def slow_concat(cmd, *args, **kwargs):
            if "concat" in cmd:
                concat_started.set()
                release_concat.wait(15)
            return fake_ffmpeg_run(cmd, *args, **kwargs)

        with patch(FFMPEG_RUN, side_effect=slow_concat):
            self.recorder.tick()
            self.assertTrue(concat_started.wait(10), "finalize runs on the finalize thread")

            second_session = self.make_session(title="Next Class")
            second = services.ensure_server_recording(second_session, user=self.instructor)
            started = time.monotonic()
            self.recorder.tick()
            self.assertLess(time.monotonic() - started, 5, "the tick does not wait for the concat")

            self.assertEqual(len(self.processes), 1, "the next class is captured during the finalize")
            self.assertEqual(self.processes[0].cmd[-1], str(Path(second.work_dir) / "part-0001.ts"))
            first.refresh_from_db()
            self.assertEqual(first.state, R.STATE_FINALIZING)
            self.assertTrue(self.recorder.finalizer.is_pending(first.pk))

            release_concat.set()
            self.assertTrue(self.wait_for(self.recorder.finalizer.idle))
        first.refresh_from_db()
        self.assertEqual(first.state, R.STATE_PROCESSING)

    def test_finalizer_skips_work_when_leadership_is_lost(self):
        handler = MagicMock()
        recorder = StreamRecorder(popen=MagicMock(), background_finalize=True, should_finalize=lambda: False)
        self.addCleanup(recorder.shutdown)
        recorder.finalizer._handler = handler

        self.assertTrue(recorder.finalizer.submit(123))
        self.assertTrue(self.wait_for(recorder.finalizer.idle))
        handler.assert_not_called()


class LeaderLeaseTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    def test_lease_is_renewed_while_the_loop_is_blocked(self):
        lease = LeaderLease("recorder-a", ttl=1)
        self.assertTrue(lease.try_hold())
        lease.start_renewing(interval=0.2)
        self.addCleanup(lease.release)

        time.sleep(1.6)  # the main loop is stuck for longer than the TTL

        self.assertEqual(cache.get(LEADER_KEY), "recorder-a")
        self.assertTrue(lease.held)
        self.assertFalse(LeaderLease("recorder-b", ttl=1).try_hold())

    def test_lease_is_dropped_when_another_recorder_owns_the_key(self):
        lease = LeaderLease("recorder-a", ttl=30)
        self.assertTrue(lease.try_hold())
        cache.set(LEADER_KEY, "recorder-b", timeout=30)

        self.assertFalse(lease.renew())
        self.assertFalse(lease.held)
        lease.release()
        self.assertEqual(cache.get(LEADER_KEY), "recorder-b", "release never deletes another recorder's key")


# --------------------------------------------------------------------------
# d. Host Studio recording without a module is visible and retryable
# --------------------------------------------------------------------------


@patch(FFMPEG_RUN, side_effect=fake_ffmpeg_run)
class EgressWithoutModuleTests(RecordingFixtureMixin, APITestCase):
    def setUp(self):
        self.build_fixture()
        self.studio = self.make_session(
            title="Studio Class", stream_service=RealtimeSession.STREAM_SERVICE_ALSYED, target_module=None
        )
        egress_file = Path(self.work_root) / "broadcasting" / "studio.mp4"
        egress_file.parent.mkdir(parents=True)
        egress_file.write_bytes(MP4_BYTES)
        make_old(egress_file, 60)
        self.egress = RealtimeSessionRecording.objects.create(
            session=self.studio,
            status=RealtimeSessionRecording.STATUS_COMPLETED,
            output_file_path="/recordings/broadcasting/studio.mp4",
            started_at=timezone.now(),
        )
        self.recorder = offline_recorder()

    def test_missing_module_is_a_visible_failure_that_retries_after_tagging(self, _run):
        recording = services.enqueue_egress_publish(self.egress)

        self.assertIsNotNone(recording)
        self.assertEqual(recording.state, R.STATE_FAILED)
        self.assertEqual(recording.error, services.NO_MODULE_SELECTED_ERROR)
        self.assertEqual(services.enqueue_egress_publish(self.egress).pk, recording.pk, "idempotent")
        self.client.force_authenticate(self.instructor)
        listed = self.client.get(reverse("realtime-session-class-recordings", kwargs={"pk": self.studio.id}))
        self.assertEqual(listed.data["data"][0]["state"], R.STATE_FAILED)
        self.assertIn("No module selected", listed.data["data"][0]["error"])
        self.assertTrue(listed.data["data"][0]["can_retry"])

        patched = self.client.patch(
            reverse("realtime-session-detail", kwargs={"pk": self.studio.id}),
            {"target_module_id": self.module2.id},
            format="json",
        )
        self.assertEqual(patched.status_code, 200)
        retried = self.client.post(reverse("realtime-class-recording-retry", kwargs={"recording_id": recording.id}))
        self.assertEqual(retried.status_code, 200, retried.data)
        self.recorder.tick()

        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PROCESSING)
        self.assertEqual(recording.module_id, self.module2.id)
        self.assertEqual(recording.lecture.section_id, self.module2.id)


# --------------------------------------------------------------------------
# a. OBS's default MKV (and FLV/TS) uploads are remuxed by the recorder
# --------------------------------------------------------------------------


class ObsRecordingValidatorTests(TestCase):
    def upload(self, name, payload, content_type="application/octet-stream"):
        return SimpleUploadedFile(name, payload, content_type=content_type)

    def test_obs_containers_are_accepted_for_class_recordings_only(self):
        for name, payload in (("obs.mkv", MKV_BYTES), ("obs.flv", FLV_BYTES), ("obs.ts", TS_BYTES)):
            with self.subTest(name=name):
                validate_obs_recording_upload(self.upload(name, payload), "video_file")
                with self.assertRaises(ValidationError):
                    validate_video_upload(self.upload(name, payload), "video_file")
        validate_obs_recording_upload(self.upload("obs.mkv", MKV_BYTES, "video/x-matroska"), "video_file")
        validate_obs_recording_upload(self.upload("obs.mp4", MP4_BYTES, "video/mp4"), "video_file")

    def test_obs_container_content_is_verified(self):
        for name in ("obs.mkv", "obs.flv", "obs.ts"):
            with self.subTest(name=name), self.assertRaises(ValidationError):
                validate_obs_recording_upload(self.upload(name, MP4_BYTES), "video_file")
        with self.assertRaises(ValidationError):
            validate_obs_recording_upload(self.upload("obs.avi", MP4_BYTES), "video_file")
        with self.assertRaises(ValidationError):
            validate_obs_recording_upload(self.upload("obs.mkv", MKV_BYTES, "text/html"), "video_file")

    def test_remux_command_is_a_stream_copy_argv_with_faststart(self):
        cmd = ffmpeg.build_remux_command("/m/in.mkv", "/m/out.mp4")
        self.assertIsInstance(cmd, list)
        self.assertEqual(cmd[cmd.index("-c") + 1], "copy")
        self.assertEqual(cmd[cmd.index("-movflags") + 1], "+faststart")
        self.assertEqual(cmd[cmd.index("-i") + 1], "/m/in.mkv")
        self.assertEqual(cmd[-1], "/m/out.mp4")


class ObsMkvUploadTests(RecordingFixtureMixin, APITestCase):
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
            session=self.session, module=self.module, lecture=self.lecture, source=R.SOURCE_SERVER,
            state=R.STATE_PUBLISHED,
        )
        self.recorder = offline_recorder()

    def upload_mkv(self, url=None, name="obs.mkv", payload=MKV_BYTES):
        url = url or reverse("realtime-class-recording-obs-upload", kwargs={"recording_id": self.recording.id})
        self.client.force_authenticate(self.instructor)
        upload = SimpleUploadedFile(name, payload, content_type="video/x-matroska")
        with patch(FFMPEG_RUN) as request_ffmpeg:
            response = self.client.post(url, {"video_file": upload}, format="multipart")
        request_ffmpeg.assert_not_called()  # never remuxed on the web worker
        return response

    def test_mkv_is_queued_then_remuxed_and_swapped_by_the_recorder(self):
        old_name = self.lecture.video_file.name
        response = self.upload_mkv()

        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["data"]["state"], R.STATE_FINALIZING)
        self.assertEqual(response.data["data"]["lecture"]["id"], self.lecture.id)
        self.assertIn("converted to MP4", response.data["message"])
        queued = R.objects.get(pk=response.data["data"]["id"])
        staged = Path(self.media_root) / queued.source_path
        self.assertTrue(staged.is_file())
        self.lecture.refresh_from_db()
        self.assertEqual(self.lecture.video_file.name, old_name, "nothing is swapped before the remux")
        self.assertEqual(self.lecture.stream_status, Lecture.STREAM_READY)

        with patch(FFMPEG_RUN, side_effect=fake_ffmpeg_run) as mock_run, self.captureOnCommitCallbacks(execute=True):
            self.recorder.tick()

        remux_cmd = mock_run.call_args_list[0].args[0]
        self.assertEqual(remux_cmd[remux_cmd.index("-i") + 1], str(staged))
        self.assertEqual(remux_cmd[remux_cmd.index("-c") + 1], "copy")
        self.assertIn("+faststart", remux_cmd)
        queued.refresh_from_db()
        self.assertEqual(queued.state, R.STATE_PROCESSING)
        self.assertEqual(queued.source_path, "")
        self.assertEqual(queued.lecture_id, self.lecture.id)
        self.lecture.refresh_from_db()
        self.assertTrue(self.lecture.video_file.name.endswith(".mp4"))
        self.assertNotEqual(self.lecture.video_file.name, old_name)
        self.assertEqual(self.lecture.stream_status, Lecture.STREAM_UPLOADED)
        self.assertEqual(self.lecture.stream_manifest_key, "")
        self.assertTrue(self.lecture.is_published)
        self.assertTrue((Path(self.media_root) / self.lecture.video_file.name).exists())
        self.assertFalse(staged.exists(), "the staged MKV is removed after the swap")
        self.assertFalse((Path(self.media_root) / old_name).exists())

    def test_failed_remux_is_a_clear_retryable_failure_and_keeps_the_old_video(self):
        old_name = self.lecture.video_file.name
        queued = R.objects.get(pk=self.upload_mkv().data["data"]["id"])

        def broken_remux(cmd, *args, **kwargs):
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Invalid data found when processing input")

        with patch(FFMPEG_RUN, side_effect=broken_remux):
            self.recorder.tick()
            self.recorder.tick()  # the self-heal must not "publish" the untouched old video

        queued.refresh_from_db()
        self.assertEqual(queued.state, R.STATE_FAILED)
        self.assertIn("Could not convert the OBS MKV recording to MP4", queued.error)
        self.assertIn("Invalid data found", queued.error)
        self.assertTrue((Path(self.media_root) / queued.source_path).is_file(), "kept for the retry")
        self.assertTrue(services.can_retry(queued))
        self.lecture.refresh_from_db()
        self.assertEqual(self.lecture.video_file.name, old_name)

        retried = self.client.post(reverse("realtime-class-recording-retry", kwargs={"recording_id": queued.id}))
        self.assertEqual(retried.status_code, 200, retried.data)
        with patch(FFMPEG_RUN, side_effect=fake_ffmpeg_run):
            self.recorder.tick()
        queued.refresh_from_db()
        self.assertEqual(queued.state, R.STATE_PROCESSING)
        self.assertEqual(queued.attempts, 1)

    def test_mkv_for_a_session_without_a_recording_creates_the_lecture_after_remux(self):
        fresh = self.make_session(title="Unrecorded", target_module=self.module2)
        response = self.upload_mkv(
            url=reverse("realtime-session-class-recording-obs-upload", kwargs={"pk": fresh.id}), name="obs.ts",
            payload=TS_BYTES,
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertIsNone(response.data["data"]["lecture"])

        with patch(FFMPEG_RUN, side_effect=fake_ffmpeg_run):
            self.recorder.tick()

        queued = R.objects.get(pk=response.data["data"]["id"])
        self.assertEqual(queued.state, R.STATE_PROCESSING)
        self.assertEqual(queued.lecture.section_id, self.module2.id)
        self.assertFalse(queued.lecture.is_published)

    @override_settings(STREAM_RECORDER_MIN_FREE_BYTES=10**12)
    def test_remux_is_refused_when_the_media_disk_is_short(self):
        queued = R.objects.get(pk=self.upload_mkv().data["data"]["id"])

        with patch(FFMPEG_RUN) as mock_run:
            self.recorder.tick()

        mock_run.assert_not_called()
        queued.refresh_from_db()
        self.assertEqual(queued.state, R.STATE_FAILED)
        self.assertIn("Not enough free disk space to convert the OBS recording", queued.error)

    def test_admin_replace_page_accepts_mkv(self):
        self.client.force_login(self.admin)
        url = reverse("admin:realtime_classrecording_obs_upload", args=[self.recording.id])
        upload = SimpleUploadedFile("obs.mkv", MKV_BYTES, content_type="video/x-matroska")

        response = self.client.post(url, {"video_file": upload})

        self.assertEqual(response.status_code, 302)
        queued = R.objects.get(source=R.SOURCE_OBS_UPLOAD)
        self.assertEqual(queued.state, R.STATE_FINALIZING)
        self.assertEqual(queued.lecture_id, self.lecture.id)
