"""Phase 2: no-click automatic recordings.

Module derivation (never failed for a missing module), instant MP4 publish,
one take per class (stop grace, idle finalize), automatic start for every
broadcast, recording.reconcile (meeting auto-egress, egress/browser-fallback
publish, auto-retry, alerts), the module-picker / re-run-finalize API, the
periodic import scan, the nightly canary, metrics and the recorder lease.
"""

import os
import time
from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock, patch

from apps.core.outbox import OutboxEvent
from apps.courses.models import Enrollment, Lecture, LiveClass, Section
from apps.notifications.models import Notification
from apps.realtime import lifecycle
from apps.realtime.management.commands.run_stream_recorder import LeaderLease
from apps.realtime.models import ClassRecording, RealtimeSession, RealtimeSessionRecording
from apps.realtime.recording import alerts, metrics, modules, reconcile, services, state
from apps.realtime.recording.recorder import CANARY_RESULT_CACHE_KEY, StreamRecorder
from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from tests.test_class_recordings import MP4_BYTES, FakeProcess, RecordingFixtureMixin, fake_ffmpeg_run

R = ClassRecording
EG = RealtimeSessionRecording
NEW_DEFAULTS = dict(STREAM_RECORDER_STOP_GRACE_SECONDS=600, RECORDING_INSTANT_PUBLISH=True)


def offline_recorder(**kwargs):
    return StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": False}, **kwargs)


class Phase2Fixture(RecordingFixtureMixin):
    def build_phase2(self):
        self.build_fixture()
        overrides = override_settings(**NEW_DEFAULTS)
        overrides.enable()
        self.addCleanup(overrides.disable)

    def capturing(self, session=None, *parts):
        recording = services.ensure_server_recording(session or self.session, user=self.instructor)
        if parts:
            self.write_parts(recording, *parts)
        return recording


# --------------------------------------------------------------------------
# Module derivation
# --------------------------------------------------------------------------


class ModuleDerivationTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        self.recorder = offline_recorder()

    def finalize(self, recording):
        state.transition(recording, R.STATE_FINALIZING, reason="t")
        with patch("apps.realtime.recording.ffmpeg.subprocess.run", side_effect=fake_ffmpeg_run):
            self.recorder.finalize_recording(recording.pk)
        recording.refresh_from_db()
        return recording

    def test_precedence_recording_then_session_then_live_class_default(self):
        LiveClass.objects.filter(pk=self.live_class.pk).update(default_module=self.module2)
        recording = self.capturing(None, b"a")
        R.objects.filter(pk=recording.pk).update(module=self.module2)  # an explicit override
        recording.refresh_from_db()
        self.assertEqual(modules.derive_module(recording).origin, "recording")
        R.objects.filter(pk=recording.pk).update(module=None)
        recording.refresh_from_db()
        self.assertEqual(modules.derive_module(recording).module, self.module)  # session.target_module
        RealtimeSession.objects.filter(pk=self.session.pk).update(target_module=None)
        recording = R.objects.select_related("session__linked_live_class__default_module").get(pk=recording.pk)
        choice = modules.derive_module(recording)
        self.assertEqual((choice.module, choice.origin, choice.needs_review), (self.module2, "live_class", False))
        recording = self.finalize(recording)
        self.assertEqual(recording.lecture.section_id, self.module2.pk)
        self.assertFalse(recording.needs_review)

    def test_module_chosen_for_the_session_during_the_class_applies(self):
        recording = self.capturing(None, b"a")
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(self.instructor)
        response = client.patch(
            reverse("realtime-session-detail", kwargs={"pk": self.session.pk}),
            {"target_module_id": self.module2.pk},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.content[:300])
        recording = self.finalize(R.objects.get(pk=recording.pk))
        self.assertEqual(recording.lecture.section_id, self.module2.pk)

    def test_auto_section_is_created_once_per_course_and_flagged(self):
        RealtimeSession.objects.filter(pk=self.session.pk).update(target_module=None)
        first = self.capturing(None, b"a")
        R.objects.filter(pk=first.pk).update(module=None)
        first = self.finalize(R.objects.get(pk=first.pk))
        second_session = self.make_session(title="Second", target_module=None)
        second = self.capturing(second_session, b"b")
        second = self.finalize(R.objects.get(pk=second.pk))
        auto = Section.objects.filter(course=self.course, title="Class recordings")
        self.assertEqual(auto.count(), 1)
        self.assertEqual(auto.get().order, 3, "appended after the existing modules")
        self.assertEqual({first.lecture.section_id, second.lecture.section_id}, {auto.get().pk})
        self.assertTrue(first.needs_review and second.needs_review)
        self.assertEqual(first.state, R.STATE_PROCESSING)
        self.assertTrue(first.lecture.is_published, "published immediately, flagged for review")

    def test_module_of_another_course_is_skipped_not_failed(self):
        recording = self.capturing(None, b"a")
        R.objects.filter(pk=recording.pk).update(module=self.foreign_module)
        RealtimeSession.objects.filter(pk=self.session.pk).update(target_module=None)
        recording = self.finalize(R.objects.get(pk=recording.pk))
        self.assertEqual(recording.state, R.STATE_PROCESSING)
        self.assertEqual(recording.lecture.section.title, "Class recordings")
        self.assertIn("another course", recording.review_reason)

    def test_class_without_any_course_is_the_only_failure(self):
        orphan_class = LiveClass.objects.create(title="No course", description="x", price=0)
        session = self.make_session(title="Orphan", linked_live_class=orphan_class, target_module=None)
        RealtimeSession.objects.filter(pk=session.pk).update(linked_course=None)
        recording = self.capturing(RealtimeSession.objects.get(pk=session.pk), b"a")
        R.objects.filter(pk=recording.pk).update(module=None)
        recording = self.finalize(R.objects.get(pk=recording.pk))
        self.assertEqual(recording.state, R.STATE_FAILED)
        self.assertIn("not linked to a course", recording.error)
        self.assertTrue(Path(recording.work_dir).exists(), "the captured class is kept")

    def test_live_class_default_module_must_belong_to_its_course(self):
        self.live_class.default_module = self.foreign_module
        with self.assertRaises(ValidationError):
            self.live_class.full_clean()

    def test_concurrent_finalizes_get_distinct_lecture_orders(self):
        a = self.capturing(None, b"a")
        self.finalize(a)
        b = self.capturing(self.make_session(title="Parallel"), b"b")
        b = self.finalize(R.objects.get(pk=b.pk))
        orders = list(Lecture.objects.filter(section=self.module).order_by("order").values_list("order", flat=True))
        self.assertEqual(len(orders), len(set(orders)))


# --------------------------------------------------------------------------
# One take per class: stop grace and idle finalize
# --------------------------------------------------------------------------


class SingleTakeTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        self.clock = [100.0]
        self.processes = []
        self.online = {"online": True}

        def popen(cmd, **kwargs):
            Path(cmd[-1]).write_bytes(b"ts")
            process = FakeProcess()
            process.cmd = cmd
            self.processes.append(process)
            return process

        self.recorder = StreamRecorder(popen=popen, monotonic=lambda: self.clock[0], owncast_status=lambda **_: self.online)
        self.addCleanup(self.recorder.shutdown)

    def test_stop_pauses_and_a_restart_continues_the_same_take(self):
        recording = self.capturing()
        self.recorder.capture_active()
        services.request_finalize(self.session, reason="stream_stopped")
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_RECORDING)
        self.assertIsNotNone(recording.stop_requested_at)
        self.recorder.capture_active()
        self.assertTrue(self.processes[0].terminated, "capture pauses while stopped")

        resumed = services.ensure_server_recording(self.session)
        self.assertEqual(resumed.pk, recording.pk)
        self.assertIsNone(resumed.stop_requested_at)
        self.clock[0] += 10
        self.recorder.capture_active()
        self.assertTrue(self.processes[-1].cmd[-1].endswith("part-0002.ts"), "next part of the same take")
        self.assertEqual(R.objects.filter(session=self.session).count(), 1)

    def test_stop_grace_expiry_finalizes(self):
        recording = self.capturing()
        services.request_finalize(self.session, reason="stream_stopped")
        R.objects.filter(pk=recording.pk).update(stop_requested_at=timezone.now() - timedelta(seconds=601))
        self.recorder.capture_active()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FINALIZING)

    def test_end_finalizes_at_once(self):
        recording = self.capturing()
        services.on_session_ended(self.session)
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FINALIZING)

    def test_feed_offline_past_the_idle_window_finalizes(self):
        recording = self.capturing()
        self.recorder.capture_active()
        recording.refresh_from_db()
        self.assertIsNotNone(recording.last_media_at)
        self.processes[0].returncode = 0  # OBS gone; ffmpeg ended the part
        self.online = {"online": False}
        R.objects.filter(pk=recording.pk).update(last_media_at=timezone.now() - timedelta(seconds=300))
        self.clock[0] += 10
        self.recorder.capture_active()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_RECORDING, "a short drop keeps the take open")
        R.objects.filter(pk=recording.pk).update(last_media_at=timezone.now() - timedelta(seconds=901))
        self.recorder.capture_active()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_FINALIZING)

    def test_idle_needs_the_feed_to_be_offline_and_something_captured(self):
        recording = self.capturing()
        R.objects.filter(pk=recording.pk).update(started_at=timezone.now() - timedelta(hours=1))
        self.online = {"online": False}
        self.recorder.capture_active()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_RECORDING, "nothing captured yet: wait for the class")
        self.online = {"online": True}
        R.objects.filter(pk=recording.pk).update(last_media_at=timezone.now() - timedelta(hours=1))
        self.recorder.capture_active()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_RECORDING, "the feed is live: never idle")


# --------------------------------------------------------------------------
# Automatic start for every broadcast
# --------------------------------------------------------------------------


class AutoStartTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        self.processes = []

        def popen(cmd, **kwargs):
            Path(cmd[-1]).write_bytes(b"ts")
            process = FakeProcess()
            process.cmd = cmd
            self.processes.append(process)
            return process

        self.recorder = StreamRecorder(popen=popen, owncast_status=lambda **_: {"online": True})
        self.addCleanup(self.recorder.shutdown)
        RealtimeSession.objects.filter(pk=self.session.pk).update(status=RealtimeSession.STATUS_ENDED)
        # A Host Studio broadcast that really feeds Owncast: its egress runs
        # and the host's studio is open (fresh heartbeat).
        self.studio = self.make_session(
            title="Studio", stream_service=RealtimeSession.STREAM_SERVICE_ALSYED, livekit_egress_id="EG_studio"
        )
        lifecycle.record_host_heartbeat(self.studio.pk, state=lifecycle.HOST_PUBLISHING)

    def go_live(self, session, at=None):
        # Like every real stream transition, entering "live" writes updated_at.
        RealtimeSession.objects.filter(pk=session.pk).update(
            stream_status=RealtimeSession.STREAM_LIVE, updated_at=at or timezone.now()
        )
        self.recorder._next_auto_start = 0  # skip the 4 s auto-start throttle

    def test_live_host_studio_broadcast_is_recorded_without_a_button(self):
        self.recorder.capture_active()
        self.assertFalse(R.objects.exists(), "not streaming yet")
        self.go_live(self.studio)
        self.recorder.capture_active()
        recording = R.objects.get(session=self.studio)
        self.assertEqual((recording.source, recording.state), (R.SOURCE_SERVER, R.STATE_RECORDING))
        self.assertEqual(len(self.processes), 1, "capture started in the same tick")
        self.recorder._next_auto_start = 0
        self.recorder.capture_active()
        self.assertEqual(R.objects.filter(session=self.studio).count(), 1)

    def test_rollback_flag_records_obs_only(self):
        self.go_live(self.studio)
        with override_settings(RECORDING_AUTO_ALL_BROADCASTS=False):
            self.recorder.capture_active()
        self.assertFalse(R.objects.exists())

    def test_capture_of_another_streaming_class_is_not_superseded(self):
        other = self.make_session(title="Other live")
        self.go_live(other)
        services.ensure_server_recording(other)
        self.go_live(self.studio)
        RealtimeSession.objects.filter(pk=self.studio.pk).update(started_at=timezone.now() + timedelta(minutes=1))
        self.recorder.capture_active()
        self.assertFalse(R.objects.filter(session=self.studio).exists(), "ambiguous: left to the explicit start")

    def test_capture_of_a_class_that_stopped_streaming_is_superseded(self):
        stale = services.ensure_server_recording(self.make_session(title="Stale"))
        self.go_live(self.studio)
        self.recorder.capture_active()
        stale.refresh_from_db()
        self.assertEqual(stale.state, R.STATE_FINALIZING)
        self.assertTrue(R.objects.filter(session=self.studio, state=R.STATE_RECORDING).exists())

    def test_meetings_are_not_captured_from_owncast(self):
        meeting = self.make_session(title="Meet", session_type=RealtimeSession.TYPE_MEETING,
                                    stream_service=RealtimeSession.STREAM_SERVICE_ALSYED)
        self.go_live(meeting)
        self.recorder.capture_active()
        self.assertFalse(R.objects.exists())

    # Review finding "auto-start picks the wrong session": a Host Studio test
    # whose tab was closed without End stays "live" in shadow mode. It must
    # never capture the real class's Owncast feed into its own take.
    def test_ghost_host_studio_session_does_not_take_the_real_class_feed(self):
        now = timezone.now()
        obs_class = self.make_session(title="Real OBS class", started_at=now - timedelta(minutes=30))
        self.go_live(obs_class, at=now - timedelta(minutes=30))
        ghost = self.make_session(
            title="Studio test", stream_service=RealtimeSession.STREAM_SERVICE_ALSYED,
            livekit_egress_id="EG_ghost", started_at=now - timedelta(minutes=5),
        )
        self.go_live(ghost, at=now - timedelta(minutes=5))  # newer, but nobody has its studio open
        RealtimeSession.objects.filter(pk=self.studio.pk).update(status=RealtimeSession.STATUS_ENDED)
        self.recorder.capture_active()
        self.assertFalse(R.objects.filter(session=ghost).exists(), "a ghost studio never records")
        self.assertTrue(R.objects.filter(session=obs_class, state=R.STATE_RECORDING).exists())

    def test_ghost_without_an_egress_is_not_recorded_even_with_a_heartbeat(self):
        ghost = self.make_session(title="Studio no egress", stream_service=RealtimeSession.STREAM_SERVICE_ALSYED,
                                  livekit_egress_id="")
        lifecycle.record_host_heartbeat(ghost.pk, state=lifecycle.HOST_CONNECTED)
        self.go_live(ghost)
        self.recorder.capture_active()
        self.assertFalse(R.objects.exists(), "no egress: it cannot be the feed Owncast carries")

    def test_the_session_that_most_recently_went_live_is_recorded_not_the_newest_row(self):
        now = timezone.now()
        # Created (and started) after the studio, but it entered "live" earlier.
        older_live = self.make_session(title="Created later", started_at=now + timedelta(minutes=1))
        self.go_live(older_live, at=now - timedelta(minutes=10))
        self.go_live(self.studio, at=now)
        self.recorder.capture_active()
        self.assertTrue(R.objects.filter(session=self.studio, state=R.STATE_RECORDING).exists())
        self.assertFalse(R.objects.filter(session=older_live).exists())

    def test_go_live_job_records_the_studio_explicitly(self):
        # handle_go_live starts the class's take itself (as OBS prepare does)
        # instead of leaving the recorder to guess which broadcast is live.
        from types import SimpleNamespace

        studio = self.make_session(
            title="Go Live", stream_service=RealtimeSession.STREAM_SERVICE_ALSYED,
            stream_status=RealtimeSession.STREAM_STARTING, livekit_egress_id="",
        )
        with patch("apps.realtime.views._restart_host_broadcast_egress", return_value=("started", "")), patch(
            "apps.realtime.models.RealtimeSession.resolve_stream_target_url", return_value="rtmp://owncast/live/key"
        ), patch("apps.realtime.views._sync_owncast_chat_settings_non_blocking"):
            lifecycle.handle_go_live(SimpleNamespace(payload={"session_id": studio.pk, "user_id": self.instructor.pk}))
        self.assertTrue(R.objects.filter(session=studio, source=R.SOURCE_SERVER, state=R.STATE_RECORDING).exists())


# --------------------------------------------------------------------------
# Instant publish
# --------------------------------------------------------------------------


@patch("apps.realtime.recording.ffmpeg.subprocess.run", side_effect=fake_ffmpeg_run)
class InstantPublishTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        Enrollment.objects.create(user=self.student, course=self.course, payment_status=Enrollment.STATUS_PAID)
        self.recorder = offline_recorder()

    def finalized(self):
        recording = self.capturing(None, b"a")
        services.on_session_ended(self.session)
        self.recorder.tick()
        recording.refresh_from_db()
        return recording

    def test_mp4_published_and_students_notified_once(self, _run):
        recording = self.finalized()
        lecture = recording.lecture
        self.assertTrue(lecture.is_published)
        self.assertEqual(recording.state, R.STATE_PROCESSING)
        kinds = Notification.objects.filter(lecture=lecture, kind=Notification.KIND_COURSE_VIDEO_UPLOADED)
        self.assertEqual(kinds.count(), 1)
        Lecture.objects.filter(pk=lecture.pk).update(
            stream_status=Lecture.STREAM_READY, stream_manifest_key="streams/x/v1/master.m3u8"
        )
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PUBLISHED)
        self.assertEqual(kinds.count(), 1, "the HD upgrade is not a new video")

    def test_admin_unpublish_while_processing_sticks(self, _run):
        recording = self.finalized()
        services.set_lecture_published(recording, False)
        Lecture.objects.filter(pk=recording.lecture_id).update(
            stream_status=Lecture.STREAM_READY, stream_manifest_key="streams/x/v1/master.m3u8"
        )
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PUBLISHED)
        self.assertFalse(recording.lecture.is_published, "automatic publishing never undoes an admin")
        services.set_lecture_published(recording, True)
        recording.refresh_from_db()
        self.assertTrue(recording.lecture.is_published)
        self.assertFalse(recording.hold_unpublished)

    def test_rollback_flag_waits_for_hls(self, _run):
        with override_settings(RECORDING_INSTANT_PUBLISH=False):
            recording = self.finalized()
        self.assertFalse(recording.lecture.is_published)


# --------------------------------------------------------------------------
# recording.reconcile
# --------------------------------------------------------------------------


@patch("apps.realtime.services.is_livekit_configured", return_value=True)
@override_settings(LIVEKIT_RECORDING_ENABLED=True, RECORDING_AUTO_MEETINGS=True)
class MeetingEgressReconcileTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        RealtimeSession.objects.filter(pk=self.session.pk).update(status=RealtimeSession.STATUS_ENDED)
        self.meeting = self.make_session(
            title="Mentor meeting", session_type=RealtimeSession.TYPE_MEETING,
            stream_service=RealtimeSession.STREAM_SERVICE_ALSYED,
        )

    @patch("apps.realtime.services.start_room_recording_egress",
           return_value={"egress_id": "EG_1", "output_file_path": "/recordings/meeting/x.mp4", "response": {}})
    def test_live_meeting_gets_an_egress_once(self, start, _cfg):
        stats = reconcile.reconcile_recordings()
        self.assertEqual(stats["meetings"]["started"], 1)
        egress = EG.objects.get(session=self.meeting)
        self.assertEqual((egress.status, egress.livekit_egress_id), (EG.STATUS_RECORDING, "EG_1"))
        reconcile.reconcile_recordings()
        self.assertEqual(start.call_count, 1, "an active egress is not started twice")

    @patch("apps.realtime.services.stop_room_recording_egress",
           return_value={"file_results": [{"filename": "/recordings/meeting/x.mp4"}]})
    def test_meeting_end_stops_the_egress_and_publishes(self, stop, _cfg):
        egress = EG.objects.create(session=self.meeting, status=EG.STATUS_RECORDING, livekit_egress_id="EG_2",
                                   output_file_path="/recordings/meeting/x.mp4", started_at=timezone.now())
        RealtimeSession.objects.filter(pk=self.meeting.pk).update(status=RealtimeSession.STATUS_ENDED)
        stats = reconcile.reconcile_recordings()
        self.assertEqual(stats["meetings"]["completed"], 1)
        stop.assert_called_once_with(egress_id="EG_2")
        egress.refresh_from_db()
        self.assertEqual(egress.status, EG.STATUS_COMPLETED)
        class_recording = R.objects.get(livekit_recording=egress)
        self.assertEqual((class_recording.source, class_recording.state), (R.SOURCE_LIVEKIT_EGRESS, R.STATE_FINALIZING))
        # Students' cameras: held back for an admin, never instantly published.
        self.assertTrue(class_recording.hold_unpublished)
        self.assertTrue(class_recording.needs_review)

    @patch("apps.realtime.services.get_broadcast_egress_status",
           return_value={"running": False, "status": "EGRESS_COMPLETE", "error": ""})
    def test_egress_that_ended_out_of_band_is_completed(self, _status, _cfg):
        egress = EG.objects.create(session=self.meeting, status=EG.STATUS_RECORDING, livekit_egress_id="EG_3",
                                   output_file_path="/recordings/meeting/y.mp4", started_at=timezone.now())
        EG.objects.filter(pk=egress.pk).update(updated_at=timezone.now() - timedelta(minutes=5))
        with patch("apps.realtime.services.start_room_recording_egress", side_effect=AssertionError("no restart")):
            cache.add(f"recording:reconcile:egress-start:{self.meeting.pk}", 1, 60)
            reconcile.reconcile_recordings()
        egress.refresh_from_db()
        self.assertEqual(egress.status, EG.STATUS_COMPLETED)
        self.assertTrue(R.objects.filter(livekit_recording=egress).exists())

    def test_start_failure_is_recorded_and_backed_off(self, _cfg):
        from apps.realtime.services import LiveKitEgressError

        with patch("apps.realtime.services.start_room_recording_egress", side_effect=LiveKitEgressError("no room")) as start:
            reconcile.reconcile_recordings()
            reconcile.reconcile_recordings()
        self.assertEqual(start.call_count, 1, "backoff between attempts")
        self.assertEqual(EG.objects.get(session=self.meeting).status, EG.STATUS_FAILED)

    def test_auto_meetings_default_is_off(self, _cfg):
        # Review finding: meetings record students' cameras; off unless enabled.
        from types import SimpleNamespace

        from apps.realtime.recording import config as recording_config

        with patch.object(recording_config, "settings", SimpleNamespace()):
            self.assertFalse(recording_config.auto_meetings())
        base = Path(settings.BASE_DIR) / "config" / "settings" / "base.py"
        self.assertIn('env_bool("RECORDING_AUTO_MEETINGS", False)', base.read_text(encoding="utf-8"))
        # Owner decision: meetings are never auto-recorded, in every shipped
        # environment (the env example and the E2E stack say so explicitly).
        env_example = (Path(settings.BASE_DIR) / ".env.example").read_text(encoding="utf-8")
        self.assertRegex(env_example, r"(?m)^RECORDING_AUTO_MEETINGS=0\s*$")
        self.assertNotRegex(env_example, r"(?m)^RECORDING_AUTO_MEETINGS=(1|true|yes|on)\b")
        e2e_settings = (Path(settings.BASE_DIR) / "config" / "settings" / "e2e.py").read_text(encoding="utf-8")
        self.assertIn('"RECORDING_AUTO_MEETINGS": "0",', e2e_settings)

    def test_auto_meetings_flag_off(self, _cfg):
        with override_settings(RECORDING_AUTO_MEETINGS=False), patch(
            "apps.realtime.services.start_room_recording_egress"
        ) as start:
            reconcile.reconcile_recordings()
        start.assert_not_called()


@patch("apps.realtime.recording.ffmpeg.subprocess.run", side_effect=fake_ffmpeg_run)
class UploadReconcileTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        self.recorder = offline_recorder()

    def test_browser_fallback_upload_joins_the_finalize_path(self, _run):
        studio = self.make_session(title="Studio", stream_service=RealtimeSession.STREAM_SERVICE_ALSYED)
        upload = EG.objects.create(
            session=studio, status=EG.STATUS_COMPLETED, started_at=timezone.now(), ended_at=timezone.now(),
            video_file=SimpleUploadedFile("class.webm", b"webm-bytes", content_type="video/webm"),
            livekit_payload={"source": "browser_fallback"},
        )
        self.assertEqual(reconcile.publish_completed_recordings(timezone.now()), 1)
        recording = R.objects.get(livekit_recording=upload)
        self.assertEqual((recording.source, recording.state), (R.SOURCE_BROWSER_FALLBACK, R.STATE_FINALIZING))
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PROCESSING, recording.error)
        self.assertTrue(recording.lecture.video_file.name.endswith(".webm"))
        self.assertTrue(recording.lecture.is_published)
        self.assertTrue(Path(upload.video_file.path).exists(), "the upload is kept")

    def test_a_meeting_browser_upload_is_held_for_review_not_published(self, _run):
        # Meeting privacy: students' cameras and microphones are never
        # published to the course instantly, whichever path made the file.
        meeting = self.make_session(title="Meeting", session_type=RealtimeSession.TYPE_MEETING,
                                    stream_service=RealtimeSession.STREAM_SERVICE_ALSYED)
        upload = EG.objects.create(
            session=meeting, status=EG.STATUS_COMPLETED, started_at=timezone.now(), ended_at=timezone.now(),
            video_file=SimpleUploadedFile("meeting.webm", b"webm-bytes", content_type="video/webm"),
            livekit_payload={"source": "browser_fallback"},
        )
        self.assertEqual(reconcile.publish_completed_recordings(timezone.now()), 1)
        recording = R.objects.get(livekit_recording=upload)
        self.assertTrue(recording.hold_unpublished)
        self.assertTrue(recording.needs_review)
        self.recorder.tick()
        recording.refresh_from_db()
        self.assertEqual(recording.state, R.STATE_PROCESSING, recording.error)
        self.assertFalse(recording.lecture.is_published, "held until an admin reviews it")
        self.assertTrue(recording.needs_review)
        self.assertEqual(reconcile.publish_completed_recordings(timezone.now()), 0, "idempotent")

    def test_old_and_duplicate_recordings_are_left_for_review(self, _run):
        old = EG.objects.create(session=self.session, status=EG.STATUS_COMPLETED,
                                output_file_path="/recordings/broadcasting/old.mp4",
                                ended_at=timezone.now() - timedelta(days=3))
        services.ensure_server_recording(self.session)  # the server recorder has this class
        dup = EG.objects.create(session=self.session, status=EG.STATUS_COMPLETED,
                                output_file_path="/recordings/broadcasting/dup.mp4", ended_at=timezone.now())
        self.assertEqual(reconcile.publish_completed_recordings(timezone.now()), 0)
        self.assertFalse(R.objects.filter(livekit_recording__in=[old, dup]).exists())


class ReconcileScheduleTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        RealtimeSession.objects.filter(pk=self.session.pk).update(status=RealtimeSession.STATUS_ENDED)

    def test_hook_publishes_only_when_there_is_work(self):
        self.assertIsNone(reconcile.schedule_recording_reconcile())
        services.ensure_server_recording(self.make_session(title="Live"))
        event = reconcile.schedule_recording_reconcile()
        self.assertIsNotNone(event)
        self.assertEqual(OutboxEvent.objects.get(pk=event.pk).event_type, reconcile.EVENT_RECORDING_RECONCILE)
        self.assertEqual(reconcile.schedule_recording_reconcile().pk, event.pk, "deduplicated per interval")

    def test_reconcile_is_single_flight(self):
        from apps.core.concurrency import DistributedLock

        other = DistributedLock(reconcile.LOCK_NAME, ttl=60)
        self.assertTrue(other.acquire(blocking=False))
        try:
            self.assertEqual(reconcile.reconcile_recordings(), {"skipped": "locked"})
        finally:
            other.release()

    def test_a_slow_pass_never_releases_another_workers_lock(self):
        from apps.core.concurrency import DistributedLock

        def lock_expires_and_another_worker_takes_it(now):
            cache.delete(f"core:lock:{reconcile.LOCK_NAME}")
            self.assertTrue(DistributedLock(reconcile.LOCK_NAME, ttl=60).acquire(blocking=False))
            return 0

        with patch.object(reconcile, "reconcile_meeting_egress", side_effect=lock_expires_and_another_worker_takes_it):
            reconcile.reconcile_recordings()
        # The other worker's lock survived this pass's release.
        self.assertEqual(reconcile.reconcile_recordings(), {"skipped": "locked"})

    def test_exhausted_failed_recordings_do_not_keep_scheduling_reconciles(self):
        recording = services.ensure_server_recording(self.make_session(title="Broken"))
        ClassRecording.objects.filter(pk=recording.pk).update(
            state=ClassRecording.STATE_FAILED, attempts=99, alerted_at=timezone.now() + timedelta(seconds=5)
        )
        self.assertFalse(reconcile.has_work())
        ClassRecording.objects.filter(pk=recording.pk).update(attempts=0)
        self.assertTrue(reconcile.has_work(), "still retryable")
        ClassRecording.objects.filter(pk=recording.pk).update(attempts=99, alerted_at=None)
        self.assertTrue(reconcile.has_work(), "alert due")


class AutoRetryAndAlertTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        self.staff = self.admin  # superuser is staff
        self.recording = services.ensure_server_recording(self.session)
        self.write_parts(self.recording, b"a")
        R.objects.filter(pk=self.recording.pk).update(part_count=1, captured_bytes=1)
        self.recording.refresh_from_db()
        state.transition(self.recording, R.STATE_FINALIZING, reason="t")
        state.transition(self.recording, R.STATE_FAILED, error="disk full", reason="t")

    def test_failed_recording_is_retried_with_backoff_up_to_the_cap(self):
        now = timezone.now()
        reconcile.auto_retry_failed(now)
        self.recording.refresh_from_db()
        self.assertEqual(self.recording.state, R.STATE_FAILED)
        self.assertAlmostEqual((self.recording.next_retry_at - now).total_seconds(), 300, delta=2)
        self.assertEqual(reconcile.auto_retry_failed(now + timedelta(seconds=301)), 1)
        self.recording.refresh_from_db()
        self.assertEqual((self.recording.state, self.recording.attempts), (R.STATE_FINALIZING, 1))
        R.objects.filter(pk=self.recording.pk).update(state=R.STATE_FAILED, attempts=3, next_retry_at=None)
        self.assertEqual(reconcile.auto_retry_failed(now + timedelta(days=1)), 0, "cap reached")

    def _published_lecture_with_failed_transcode(self, attempts):
        lecture = Lecture.objects.create(section=self.module, title="Class", video_key="videos/class.mp4")
        Lecture.objects.filter(pk=lecture.pk).update(stream_status=Lecture.STREAM_FAILED, stream_attempts=attempts)
        R.objects.filter(pk=self.recording.pk).update(lecture=lecture, next_retry_at=timezone.now() - timedelta(seconds=1))
        self.recording.refresh_from_db()
        return lecture

    def test_auto_retry_leaves_an_exhausted_transcode_alone(self):
        from apps.courses.transcode_queue import max_attempts

        lecture = self._published_lecture_with_failed_transcode(max_attempts())
        self.assertEqual(reconcile.auto_retry_failed(timezone.now()), 0)
        lecture.refresh_from_db()
        self.assertEqual((lecture.stream_status, lecture.stream_attempts), (Lecture.STREAM_FAILED, max_attempts()))
        self.recording.refresh_from_db()
        self.assertEqual(self.recording.state, R.STATE_FAILED)

    def test_auto_retry_keeps_the_transcode_attempt_count(self):
        lecture = self._published_lecture_with_failed_transcode(1)
        self.assertEqual(reconcile.auto_retry_failed(timezone.now()), 1)
        lecture.refresh_from_db()
        self.assertEqual((lecture.stream_status, lecture.stream_attempts), (Lecture.STREAM_UPLOADED, 1))

    def test_an_explicit_retry_resets_the_transcode_attempts(self):
        from apps.courses.transcode_queue import max_attempts

        lecture = self._published_lecture_with_failed_transcode(max_attempts())
        self.assertTrue(services.retry(self.recording))
        lecture.refresh_from_db()
        self.assertEqual((lecture.stream_status, lecture.stream_attempts), (Lecture.STREAM_UPLOADED, 0))

    def test_a_class_that_never_streamed_is_not_retried(self):
        R.objects.filter(pk=self.recording.pk).update(part_count=0, captured_bytes=0)
        for part in Path(self.recording.work_dir).glob("part-*.ts"):
            part.unlink()
        now = timezone.now()
        reconcile.auto_retry_failed(now)
        later = now + timedelta(days=1)
        self.assertEqual(reconcile.auto_retry_failed(later), 0)
        self.recording.refresh_from_db()
        self.assertEqual((self.recording.state, self.recording.attempts), (R.STATE_FAILED, 0))
        # Looked at again only after the longest backoff, not every interval.
        self.assertEqual(self.recording.next_retry_at, later + timedelta(seconds=7200))
        R.objects.filter(pk=self.recording.pk).update(alerted_at=later + timedelta(seconds=5))
        self.assertFalse(reconcile.has_work(later + timedelta(seconds=30)))

    def test_exhausted_transcode_never_wakes_the_reconcile(self):
        from apps.courses.transcode_queue import max_attempts

        self._published_lecture_with_failed_transcode(max_attempts())
        R.objects.filter(pk=self.recording.pk).update(attempts=0, next_retry_at=None,
                                                    alerted_at=timezone.now() + timedelta(seconds=5))
        self.assertFalse(reconcile.has_work(), "MP4 published; only an explicit Retry runs it again")
        self.assertEqual(reconcile.auto_retry_failed(timezone.now()), 0)

    def test_waiting_for_backoff_is_not_work(self):
        now = timezone.now()
        R.objects.filter(pk=self.recording.pk).update(alerted_at=now + timedelta(seconds=5))
        self.assertTrue(reconcile.has_work(now), "first retry time still to schedule")
        reconcile.auto_retry_failed(now)
        self.assertFalse(reconcile.has_work(now + timedelta(seconds=30)))
        self.assertTrue(reconcile.has_work(now + timedelta(seconds=301)))

    def test_non_retryable_rows_do_not_starve_the_batch(self):
        due = timezone.now() - timedelta(seconds=1)
        R.objects.filter(pk=self.recording.pk).update(source=R.SOURCE_OBS_UPLOAD, source_path="", next_retry_at=due)
        for _ in range(reconcile.BATCH + 2):  # OBS uploads with nothing staged: never auto-retryable
            copy = R.objects.get(pk=self.recording.pk)
            copy.pk = None
            copy.save()
        retryable = R.objects.get(pk=self.recording.pk)
        retryable.pk = None
        retryable.source = R.SOURCE_SERVER  # captured parts (setUp): retryable, and sorts last
        retryable.save()
        R.objects.filter(pk=retryable.pk).update(next_retry_at=due)
        now = timezone.now()
        self.assertEqual(reconcile.auto_retry_failed(now), 0, "the first batch is all non-retryable")
        self.assertEqual(reconcile.auto_retry_failed(now), 1, "deferred rows leave the batch")
        retryable.refresh_from_db()
        self.assertEqual(retryable.state, R.STATE_FINALIZING)

    def test_failure_alert_reaches_staff_once(self):
        reconcile.raise_due_alerts(timezone.now())
        reconcile.raise_due_alerts(timezone.now())
        alerts_sent = Notification.objects.filter(event_key__startswith=f"class-recording-alert:{self.recording.pk}:failed")
        self.assertEqual(alerts_sent.count(), 1)
        self.assertTrue(alerts_sent.get().recipients.filter(user=self.admin).exists())

    def test_needs_review_alert_once_published(self):
        R.objects.filter(pk=self.recording.pk).update(state=R.STATE_PROCESSING, needs_review=True,
                                                    review_reason="auto module")
        reconcile.raise_due_alerts(timezone.now())
        self.assertFalse(Notification.objects.filter(event_key__contains="needs-review").exists(), "no lecture yet")
        lecture = Lecture.objects.create(section=self.module, title="x", video_key="videos/x.mp4")
        R.objects.filter(pk=self.recording.pk).update(lecture=lecture)
        reconcile.raise_due_alerts(timezone.now())
        reconcile.raise_due_alerts(timezone.now())
        self.assertEqual(Notification.objects.filter(event_key__contains="needs-review").count(), 1)

    def test_stuck_processing_and_stale_recorder_alerts(self):
        R.objects.filter(pk=self.recording.pk).update(state=R.STATE_PROCESSING,
                                                    updated_at=timezone.now() - timedelta(hours=7))
        live = services.ensure_server_recording(self.make_session(title="Live now"))
        R.objects.filter(pk=live.pk).update(created_at=timezone.now() - timedelta(minutes=10))
        reconcile.raise_due_alerts(timezone.now())
        keys = set(Notification.objects.values_list("event_key", flat=True))
        self.assertIn(f"class-recording-alert:{self.recording.pk}:{alerts.KIND_STUCK_PROCESSING}", keys)
        self.assertIn(f"class-recording-alert:{live.pk}:recorder-stale", keys)

    def test_alerts_can_be_switched_off(self):
        with override_settings(RECORDING_ALERTS_ENABLED=False):
            reconcile.raise_due_alerts(timezone.now())
        self.assertFalse(Notification.objects.filter(event_key__startswith="class-recording-alert").exists())


# --------------------------------------------------------------------------
# API: module picker (optional override) and admin re-run finalize
# --------------------------------------------------------------------------


@patch("apps.realtime.recording.ffmpeg.subprocess.run", side_effect=fake_ffmpeg_run)
class RecordingApiTests(Phase2Fixture, APITestCase):
    def setUp(self):
        self.build_phase2()
        self.recording = services.ensure_server_recording(self.session)
        self.write_parts(self.recording, b"a")

    def url(self, name):
        return reverse(name, kwargs={"recording_id": self.recording.pk})

    def test_module_picker_permissions_and_validation(self, _run):
        self.client.force_authenticate(self.student)
        denied = self.client.post(self.url("realtime-class-recording-module"), {"module_id": self.module2.pk})
        self.assertEqual(denied.status_code, 403)
        self.client.force_authenticate(self.instructor)
        foreign = self.client.post(self.url("realtime-class-recording-module"), {"module_id": self.foreign_module.pk})
        self.assertEqual(foreign.status_code, 400)
        ok = self.client.post(self.url("realtime-class-recording-module"), {"module_id": self.module2.pk})
        self.assertEqual(ok.status_code, 200, ok.data)
        self.assertEqual(ok.data["data"]["module"]["id"], self.module2.pk)
        self.assertIn("needs_review", ok.data["data"])
        state.transition(self.recording, R.STATE_FINALIZING, reason="t")
        busy = self.client.post(self.url("realtime-class-recording-module"), {"module_id": self.module.pk})
        self.assertEqual(busy.status_code, 400)

    def test_a_recording_without_a_course_only_goes_to_a_course_the_user_teaches(self, _run):
        RealtimeSession.objects.filter(pk=self.session.pk).update(
            target_module=None, linked_live_class=None, linked_course=None
        )
        R.objects.filter(pk=self.recording.pk).update(module=None)
        self.recording.refresh_from_db()
        self.assertIsNone(services.recording_course_id(self.recording))
        self.client.force_authenticate(self.instructor)
        foreign = self.client.post(self.url("realtime-class-recording-module"), {"module_id": self.foreign_module.pk})
        self.assertEqual(foreign.status_code, 400, "another instructor's course")
        own = self.client.post(self.url("realtime-class-recording-module"), {"module_id": self.module2.pk})
        self.assertEqual(own.status_code, 200, own.data)
        R.objects.filter(pk=self.recording.pk).update(module=None)
        self.client.force_authenticate(self.admin)
        staff = self.client.post(self.url("realtime-class-recording-module"), {"module_id": self.foreign_module.pk})
        self.assertEqual(staff.status_code, 200, staff.data)

    def test_rerun_finalize_is_admin_only_and_pushes_forward(self, _run):
        self.client.force_authenticate(self.instructor)
        self.assertEqual(self.client.post(self.url("realtime-class-recording-rerun-finalize")).status_code, 403)
        self.client.force_authenticate(self.admin)
        response = self.client.post(self.url("realtime-class-recording-rerun-finalize"))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["data"]["recording"]["state"], R.STATE_FINALIZING)
        offline_recorder().tick()
        self.recording.refresh_from_db()
        lecture = self.recording.lecture
        Lecture.objects.filter(pk=lecture.pk).update(stream_status=Lecture.STREAM_FAILED, stream_attempts=99)
        response = self.client.post(self.url("realtime-class-recording-rerun-finalize"))
        self.assertEqual(response.status_code, 200)
        lecture.refresh_from_db()
        self.assertEqual((lecture.stream_status, lecture.stream_attempts), (Lecture.STREAM_UPLOADED, 0))


# --------------------------------------------------------------------------
# Periodic import scan, nightly canary, metrics, leader lease
# --------------------------------------------------------------------------


class ImportScanAutoPublishTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        RealtimeSession.objects.filter(pk=self.session.pk).update(status=RealtimeSession.STATUS_ENDED)
        self.recorder = offline_recorder()

    def egress_file(self, name, session, *, started_at):
        path = Path(self.work_root) / "meeting" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(MP4_BYTES)
        old = time.time() - 3600
        os.utime(path, (old, old))
        EG.objects.create(session=session, status=EG.STATUS_FAILED, output_file_path=f"/recordings/meeting/{name}",
                          started_at=started_at)
        return path

    def test_only_recent_files_of_classes_without_a_lecture_are_published(self):
        fresh_session = self.make_session(title="Never published")
        published_session = self.make_session(title="Has lecture")
        lecture = Lecture.objects.create(section=self.module, title="done", video_key="videos/done.mp4")
        R.objects.create(session=published_session, source=R.SOURCE_SERVER, state=R.STATE_PUBLISHED, lecture=lecture)
        fresh = self.egress_file("fresh.mp4", fresh_session, started_at=timezone.now() - timedelta(hours=2))
        self.egress_file("old.mp4", self.make_session(title="Old"), started_at=timezone.now() - timedelta(days=30))
        self.egress_file("dup.mp4", published_session, started_at=timezone.now() - timedelta(hours=2))

        result = self.recorder.run_import_scan()

        self.assertEqual(result["auto_published"], 1)
        auto = R.objects.get(source=R.SOURCE_IMPORTED, source_path=str(fresh))
        self.assertEqual(auto.state, R.STATE_FINALIZING)
        self.assertEqual(R.objects.filter(source=R.SOURCE_IMPORTED, state=R.STATE_IMPORTED).count(), 2)

    @override_settings(RECORDING_IMPORT_SCAN_INTERVAL_SECONDS=0)
    def test_scan_can_be_disabled(self):
        self.recorder._next_import_scan = 0
        self.assertIsNone(self.recorder.import_scan_if_due())


class CanaryTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()
        RealtimeSession.objects.filter(pk=self.session.pk).update(status=RealtimeSession.STATUS_ENDED)
        self.process = FakeProcess()
        self.popen = MagicMock(return_value=self.process)
        self.recorder = StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": False},
                                       canary_popen=self.popen)
        self.at_hour = timezone.localtime().replace(hour=3, minute=5)

    def test_runs_once_a_night_in_a_subprocess_and_records_success(self):
        self.assertEqual(self.recorder.canary_if_due(now=self.at_hour), "started")
        argv = self.popen.call_args.args[0]
        self.assertEqual(argv[-1], "verify_recording_pipeline")
        self.assertEqual(self.recorder.canary_if_due(now=self.at_hour), "running")
        self.process.returncode = 0
        self.assertEqual(self.recorder.canary_if_due(now=self.at_hour), "passed")
        self.assertTrue(cache.get(CANARY_RESULT_CACHE_KEY)["ok"])
        self.assertIsNone(self.recorder.canary_if_due(now=self.at_hour), "once per night")

    def test_runs_on_a_direct_database_connection_with_the_timeouts_lifted(self):
        pooled = "postgresql://app:secret@pgbouncer:5432/academy"
        with patch.dict(os.environ, {"DATABASE_URL": pooled, "DATABASE_STATEMENT_TIMEOUT_MS": "15000"}):
            self.recorder.canary_if_due(now=self.at_hour)
            self.assertEqual(os.environ["DATABASE_URL"], pooled, "the recorder's own environment is untouched")
            self.assertEqual(os.environ["DATABASE_STATEMENT_TIMEOUT_MS"], "15000")
        env = self.popen.call_args.kwargs["env"]
        self.assertEqual(env["DATABASE_URL"], "postgresql://app:secret@postgres:5432/academy")
        self.assertEqual(env["DATABASE_BEHIND_POOLER"], "0")
        self.assertEqual(env["DATABASE_STATEMENT_TIMEOUT_MS"], "0")
        self.assertEqual(env["DATABASE_IDLE_IN_TX_TIMEOUT_MS"], "0")

    def test_canary_database_url_precedence(self):
        from apps.realtime.recording.recorder import canary_environment

        pooled = {"DATABASE_URL": "postgresql://a:b@pgbouncer/db", "PATH": "/bin"}
        self.assertEqual(canary_environment(pooled)["DATABASE_URL"], "postgresql://a:b@postgres:5432/db")
        self.assertEqual(canary_environment(pooled)["PATH"], "/bin")
        migrate = dict(pooled, DATABASE_MIGRATE_URL="postgresql://a:b@db.internal:5432/db")
        self.assertEqual(canary_environment(migrate)["DATABASE_URL"], "postgresql://a:b@db.internal:5432/db")
        own = dict(migrate, RECORDING_CANARY_DATABASE_URL="postgresql://a:b@replica-primary:5432/db")
        self.assertEqual(canary_environment(own)["DATABASE_URL"], "postgresql://a:b@replica-primary:5432/db")
        self.assertEqual(canary_environment({})["DATABASE_STATEMENT_TIMEOUT_MS"], "0")
        self.assertNotIn("DATABASE_URL", canary_environment({}), "SQLite default left alone")

    def test_failure_alerts_staff(self):
        self.recorder.canary_if_due(now=self.at_hour)
        self.process.returncode = 1
        self.assertEqual(self.recorder.canary_if_due(now=self.at_hour), "failed")
        self.assertTrue(Notification.objects.filter(event_key__startswith="class-recording-alert:canary:").exists())

    def test_only_the_long_running_service_runs_it(self):
        with patch.object(self.recorder, "canary_if_due") as canary, patch.object(
            self.recorder, "import_scan_if_due"
        ) as scan:
            self.recorder.tick()
        canary.assert_not_called()
        scan.assert_not_called()
        service = StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": False},
                                 canary_popen=self.popen, service_duties=True)
        with patch.object(service, "canary_if_due") as canary:
            service.tick()
        canary.assert_called_once()

    def test_never_while_a_class_is_recorded_or_outside_the_hour(self):
        self.assertIsNone(self.recorder.canary_if_due(now=self.at_hour.replace(hour=14)))
        services.ensure_server_recording(self.make_session(title="Live"))
        self.assertIsNone(self.recorder.canary_if_due(now=self.at_hour))
        self.popen.assert_not_called()


class MetricsTests(Phase2Fixture, TestCase):
    def setUp(self):
        self.build_phase2()

    def test_collector_reports_states_ages_review_and_streams(self):
        recording = services.ensure_server_recording(self.session)
        R.objects.filter(pk=recording.pk).update(needs_review=True)
        families = {family.name: family for family in metrics.RecordingCollector().collect()}
        for name in ("streamx_class_recordings", "streamx_class_recording_oldest_age_seconds",
                     "streamx_class_recordings_needs_review", "streamx_lecture_streams",
                     "streamx_lecture_transcode_exhausted"):
            self.assertIn(name, families)
        samples = {(s.labels.get("state"), s.labels.get("source")): s.value
                   for s in families["streamx_class_recordings"].samples}
        self.assertEqual(samples[("recording", "server")], 1)
        self.assertEqual(families["streamx_class_recordings_needs_review"].samples[0].value, 1)


class LeaderLeaseFailStaticTests(TestCase):
    class FlakyCache:
        def __init__(self):
            self.store = {}
            self.down = False

        def _check(self):
            if self.down:
                raise ConnectionError("redis down")

        def add(self, key, value, timeout=None):
            self._check()
            if key in self.store:
                return False
            self.store[key] = value
            return True

        def get(self, key):
            self._check()
            return self.store.get(key)

        def set(self, key, value, timeout=None):
            self._check()
            self.store[key] = value

        def delete(self, key):
            self._check()
            self.store.pop(key, None)

    def test_redis_outage_keeps_a_confirmed_lease_for_one_ttl_only(self):
        flaky = self.FlakyCache()
        clock = [0.0]
        lease = LeaderLease("me", 30, cache_backend=flaky)
        lease._clock = lambda: clock[0]
        self.assertTrue(lease.try_hold())
        flaky.down = True
        clock[0] = 20
        self.assertTrue(lease.try_hold(), "captures of the running class continue")
        clock[0] = 31
        self.assertFalse(lease.try_hold(), "no longer certain nobody else holds it")
        lease.release()  # never raises while the cache is down

    def test_fresh_start_during_an_outage_waits(self):
        flaky = self.FlakyCache()
        flaky.down = True
        self.assertFalse(LeaderLease("me", 30, cache_backend=flaky).try_hold())


class VerificationAutoPublishChecksTests(Phase2Fixture, TestCase):
    """The new verify_recording_pipeline checks, driven by the fake ffmpeg here
    (the real-ffmpeg run happens on the server)."""

    def setUp(self):
        self.build_phase2()

    def test_auto_publish_checks_pass_against_a_fake_ffmpeg(self):
        from apps.realtime.recording import verification

        from tests.test_hls_transcode_queue import FakeFfmpeg

        with patch("apps.realtime.recording.ffmpeg.subprocess.run", side_effect=fake_ffmpeg_run):
            recording = services.ensure_server_recording(self.session)
            self.write_parts(recording, b"a")
            services.on_session_ended(self.session)
            recorder = offline_recorder(recording_ids=[recording.pk])
            recorder.tick()
            recording.refresh_from_db()
            egress = Path(self.work_root) / "egress.mp4"
            egress.write_bytes(MP4_BYTES)
            os.utime(egress, (time.time() - 60, time.time() - 60))
            hd_source = Path(self.work_root) / "hd.mp4"
            hd_source.write_bytes(MP4_BYTES)
            report = verification.Report()
            with patch("apps.courses.services.subprocess.run", new=FakeFfmpeg(width=960, height=540)), patch(
                "apps.realtime.recording.verification.probe", return_value={"duration": 4.0}
            ):
                verification._auto_publish_checks(
                    report, recorder, course=self.course, host=self.instructor, token="t0k3n", egress=egress,
                    recording=recording, media_root=Path(self.media_root), module=self.module, hd_source=hd_source,
                )
        failures = [line for line in report.lines if line[0] == "FAIL"]
        self.assertEqual(failures, [])
        self.assertGreaterEqual(sum(1 for line in report.lines if line[0] == "PASS"), 8)

    def test_canary_transaction_lifts_the_role_timeouts_on_postgresql(self):
        from apps.realtime.recording import verification

        executed = []
        cursor = MagicMock()
        cursor.__enter__.return_value.execute.side_effect = executed.append
        fake = MagicMock(vendor="postgresql")
        fake.cursor.return_value = cursor
        with patch("django.db.connection", fake):
            verification._lift_db_timeouts_for_this_transaction()
        self.assertEqual(executed, [
            "SET LOCAL statement_timeout = 0",
            "SET LOCAL idle_in_transaction_session_timeout = 0",
            "SET LOCAL lock_timeout = '10s'",
        ])
        sqlite = MagicMock(vendor="sqlite")
        with patch("django.db.connection", sqlite):
            verification._lift_db_timeouts_for_this_transaction()
        sqlite.cursor.assert_not_called()
