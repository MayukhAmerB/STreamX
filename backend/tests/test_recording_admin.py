"""Class recordings admin: list, filters, staff-only player/streaming, actions, scan."""

import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.contrib.auth.models import Permission
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.courses.models import Lecture
from apps.realtime.models import RealtimeSessionRecording
from apps.realtime.recording.recorder import StreamRecorder
from tests.test_class_recordings import MP4_BYTES, R, RecordingFixtureMixin, User

VIDEO = MP4_BYTES + bytes(range(256)) * 4  # 1048 bytes


class AdminFixture(RecordingFixtureMixin):
    def build(self):
        self.build_fixture()
        self.media = Path(self.media_root)
        self.client.force_login(self.admin)
        self.lecture = Lecture.objects.create(section=self.module, title="Recon Class - 10 Nov 2026", order=5,
                                              is_published=False)
        name = f"lecture_videos/osint-batch/module_{self.module.pk}/class-recording-1.mp4"
        (self.media / name).parent.mkdir(parents=True, exist_ok=True)
        (self.media / name).write_bytes(VIDEO)
        Lecture.objects.filter(pk=self.lecture.pk).update(video_file=name, stream_status=Lecture.STREAM_PROCESSING)
        self.lecture.refresh_from_db()
        self.video_path = self.media / name
        self.recording = R.objects.create(
            session=self.session, module=self.module, lecture=self.lecture, source=R.SOURCE_SERVER,
            state=R.STATE_PROCESSING, file_size_bytes=len(VIDEO), duration_seconds=3725,
            started_at=timezone.now(),
        )

    def url(self, name, recording=None):
        return reverse(f"admin:realtime_classrecording_{name}", args=[(recording or self.recording).pk])

    def make_ready(self):
        Lecture.objects.filter(pk=self.lecture.pk).update(
            stream_status=Lecture.STREAM_READY, stream_manifest_key="streams/x/master.m3u8"
        )


class ChangelistTests(AdminFixture, TestCase):
    def setUp(self):
        self.build()
        self.other_session = self.make_session(title="Other Class", target_module=None, linked_live_class=None,
                                               linked_course=self.other_course)
        self.failed = R.objects.create(session=self.other_session, source=R.SOURCE_LIVEKIT_EGRESS,
                                       state=R.STATE_FAILED, error="No module selected for this class")
        self.imported = R.objects.create(source=R.SOURCE_IMPORTED, state=R.STATE_IMPORTED,
                                         source_path=str(Path(self.work_root) / "old 2026.mp4"),
                                         source_size_bytes=5 * 1024**3, file_size_bytes=5 * 1024**3)

    def ids(self, query=""):
        response = self.client.get(reverse("admin:realtime_classrecording_changelist") + query)
        self.assertEqual(response.status_code, 200)
        return {row.pk for row in response.context["cl"].result_list}

    def test_list_shows_course_module_source_state_lecture_and_scan_button(self):
        response = self.client.get(reverse("admin:realtime_classrecording_changelist"))
        self.assertEqual(response.status_code, 200)
        html = response.content.decode()
        for text in ("OSINT Batch", "Recon", "Server capture", "Host Studio", "Imported", "Imported (unassigned)",
                     "Processing", "Failed", "1:02:05", "5.0 GB", "Unassigned", "Scan for existing recordings",
                     "old 2026.mp4", "Unpublished", "#icon-renew",
                     reverse("admin:realtime_classrecording_scan"), self.url("assign", self.imported)):
            self.assertIn(text, html)

    def test_filters_and_search(self):
        everything = {self.recording.pk, self.failed.pk, self.imported.pk}
        self.assertEqual(self.ids(), everything)
        self.assertEqual(self.ids(f"?course={self.course.pk}"), {self.recording.pk})
        self.assertEqual(self.ids(f"?course={self.other_course.pk}"), {self.failed.pk})
        self.assertEqual(self.ids(f"?module={self.module.pk}"), {self.recording.pk})
        self.assertEqual(self.ids("?source=imported"), {self.imported.pk})
        self.assertEqual(self.ids("?state=failed"), {self.failed.pk})
        self.assertEqual(self.ids("?state=imported"), {self.imported.pk})
        today = timezone.localdate().isoformat()
        self.assertEqual(self.ids(f"?started_at__gte={today}"), {self.recording.pk})
        self.assertEqual(self.ids("?q=Other+Class"), {self.failed.pk})
        self.assertEqual(self.ids("?q=old+2026"), {self.imported.pk})

    def test_module_filter_follows_the_selected_course(self):
        response = self.client.get(reverse("admin:realtime_classrecording_changelist") + f"?course={self.course.pk}")
        self.assertContains(response, "OSINT Batch - Recon")

    def test_change_page_has_the_staff_player_and_actions(self):
        response = self.client.get(reverse("admin:realtime_classrecording_change", args=[self.recording.pk]))
        self.assertEqual(response.status_code, 200)
        media = self.url("media")
        self.assertContains(response, f'<video class="class-recording-player" controls preload="metadata" src="{media}">')
        self.assertContains(response, f'href="{media}?download=1" download')
        for name in ("move", "delete_files", "obs_upload"):
            self.assertContains(response, self.url(name))
        self.assertNotContains(response, self.url("publish"), msg_prefix="HLS not ready: no publish button")
        self.make_ready()
        response = self.client.get(reverse("admin:realtime_classrecording_change", args=[self.recording.pk]))
        self.assertContains(response, self.url("publish"))

    def test_imported_change_page_offers_publish_to_module(self):
        response = self.client.get(reverse("admin:realtime_classrecording_change", args=[self.imported.pk]))
        self.assertContains(response, self.url("assign", self.imported))
        self.assertContains(response, "No playable video file")


class StreamingTests(AdminFixture, TestCase):
    def setUp(self):
        self.build()

    def test_full_and_ranged_responses(self):
        url = self.url("media")
        with override_settings(COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=False):
            full = self.client.get(url)
            self.assertEqual(full.status_code, 200)
            self.assertEqual(b"".join(full.streaming_content), VIDEO)
            self.assertEqual(full["Accept-Ranges"], "bytes")
            self.assertEqual(full["Content-Type"], "video/mp4")
            self.assertTrue(full["Content-Disposition"].startswith("inline"))
            self.assertIn("private", full["Cache-Control"])
            self.assertIn("no-store", full["Cache-Control"])

            part = self.client.get(url, HTTP_RANGE="bytes=10-19")
            self.assertEqual(part.status_code, 206)
            self.assertEqual(part["Content-Range"], f"bytes 10-19/{len(VIDEO)}")
            self.assertEqual(b"".join(part.streaming_content), VIDEO[10:20])

            tail = self.client.get(url, HTTP_RANGE="bytes=-8")
            self.assertEqual(b"".join(tail.streaming_content), VIDEO[-8:])

            with patch("apps.realtime.recording.media.MAX_OPEN_RANGE_BYTES", 100):
                open_ended = self.client.get(url, HTTP_RANGE="bytes=0-")
            self.assertEqual(open_ended.status_code, 206)
            self.assertEqual(open_ended["Content-Range"], f"bytes 0-99/{len(VIDEO)}")

            bad = self.client.get(url, HTTP_RANGE=f"bytes={len(VIDEO) + 5}-")
            self.assertEqual(bad.status_code, 416)
            self.assertEqual(bad["Content-Range"], f"bytes */{len(VIDEO)}")

            download = self.client.get(url + "?download=1")
            self.assertTrue(download["Content-Disposition"].startswith("attachment"))

    def test_media_root_files_go_through_nginx_protected_media(self):
        with override_settings(COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True):
            response = self.client.get(self.url("media"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["X-Accel-Redirect"], f"/_protected_media/{self.lecture.video_file.name}")
        self.assertEqual(response.content, b"")

    def test_files_outside_media_are_streamed_by_django(self):
        egress = Path(self.work_root) / "rooms" / "room.mp4"
        egress.parent.mkdir(parents=True)
        egress.write_bytes(VIDEO)
        recording = R.objects.create(session=self.session, source=R.SOURCE_LIVEKIT_EGRESS, state=R.STATE_FAILED,
                                     source_path=str(egress))
        with override_settings(COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=True):
            response = self.client.get(self.url("media", recording), HTTP_RANGE="bytes=0-3")
        self.assertEqual(response.status_code, 206)
        self.assertNotIn("X-Accel-Redirect", response)
        self.assertEqual(b"".join(response.streaming_content), VIDEO[:4])

    def test_paths_outside_the_recording_folders_are_never_served(self):
        outside = Path(self.media_root).parent / f"secret-{os.getpid()}.mp4"
        outside.write_bytes(b"secret")
        self.addCleanup(outside.unlink, missing_ok=True)
        recording = R.objects.create(source=R.SOURCE_IMPORTED, state=R.STATE_IMPORTED, source_path=str(outside))
        self.assertEqual(self.client.get(self.url("media", recording)).status_code, 404)

    def test_anonymous_students_and_staff_without_permission_are_refused(self):
        url = self.url("media")
        login = reverse("admin:login")
        self.client.logout()
        anonymous = self.client.get(url)
        self.assertEqual(anonymous.status_code, 302)
        self.assertTrue(anonymous["Location"].startswith(login))
        self.client.force_login(self.student)
        student = self.client.get(url)
        self.assertEqual(student.status_code, 302)
        self.assertTrue(student["Location"].startswith(login))
        self.client.force_login(self.instructor)  # an instructor is not staff either
        self.assertEqual(self.client.get(url).status_code, 302)
        for name in ("publish", "unpublish", "retry", "move", "delete_files", "assign"):
            self.assertEqual(self.client.post(self.url(name)).status_code, 302, name)
        self.assertEqual(self.client.post(reverse("admin:realtime_classrecording_scan")).status_code, 302)

        staff = User.objects.create_user(email="rec-staff@test.com", password="StrongPass@123", is_staff=True)
        self.client.force_login(staff)
        self.assertEqual(self.client.get(url).status_code, 403)
        staff.user_permissions.add(Permission.objects.get(codename="view_classrecording"))
        staff = User.objects.get(pk=staff.pk)
        self.client.force_login(staff)
        self.assertEqual(self.client.get(url).status_code, 200)
        for name in ("publish", "unpublish", "retry", "move", "delete_files", "assign"):
            self.assertEqual(self.client.post(self.url(name)).status_code, 403, name)
        self.assertEqual(self.client.post(reverse("admin:realtime_classrecording_scan")).status_code, 403)
        self.lecture.refresh_from_db()
        self.assertFalse(self.lecture.is_published)

    def test_old_livekit_recording_admin_uses_the_staff_view(self):
        egress = Path(self.work_root) / "room-1.mp4"
        egress.write_bytes(VIDEO)
        old = RealtimeSessionRecording.objects.create(
            session=self.session, status=RealtimeSessionRecording.STATUS_COMPLETED,
            output_file_path="/recordings/room-1.mp4", started_at=timezone.now(),
        )
        changelist = self.client.get(reverse("admin:realtime_realtimesessionrecording_changelist"))
        self.assertEqual(changelist.status_code, 200)
        media = reverse("admin:realtime_realtimesessionrecording_media", args=[old.pk])
        self.assertContains(changelist, f"{media}?download=1")
        self.assertContains(changelist, "OSINT Batch")
        self.assertContains(changelist, "Completed")
        change = self.client.get(reverse("admin:realtime_realtimesessionrecording_change", args=[old.pk]))
        self.assertContains(change, f'<video class="class-recording-player" controls preload="metadata" src="{media}">')
        with override_settings(COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT=False):
            response = self.client.get(media, HTTP_RANGE="bytes=0-9")
        self.assertEqual(response.status_code, 206)
        self.assertEqual(b"".join(response.streaming_content), VIDEO[:10])
        self.client.logout()
        self.assertEqual(self.client.get(media).status_code, 302)
        self.client.force_login(self.student)
        self.assertEqual(self.client.get(media).status_code, 302)


class ActionTests(AdminFixture, TestCase):
    def setUp(self):
        self.build()

    def test_publish_requires_a_ready_stream(self):
        self.assertEqual(self.client.get(self.url("publish")).status_code, 200)
        response = self.client.post(self.url("publish"), follow=True)
        self.assertContains(response, "not ready yet")
        self.lecture.refresh_from_db()
        self.assertFalse(self.lecture.is_published)
        self.make_ready()
        self.client.post(self.url("publish"))
        self.lecture.refresh_from_db()
        self.assertTrue(self.lecture.is_published)

    def test_unpublish(self):
        self.make_ready()
        Lecture.objects.filter(pk=self.lecture.pk).update(is_published=True)
        response = self.client.post(self.url("unpublish"), follow=True)
        self.assertContains(response, "still being processed", msg_prefix="no unpublish while auto-publish pending")
        R.objects.filter(pk=self.recording.pk).update(state=R.STATE_PUBLISHED)
        self.client.post(self.url("unpublish"))
        self.lecture.refresh_from_db()
        self.assertFalse(self.lecture.is_published)

    def test_bulk_publish_and_unpublish_actions(self):
        self.make_ready()
        changelist = reverse("admin:realtime_classrecording_changelist")
        self.client.post(changelist, {"action": "publish_lectures", "_selected_action": [self.recording.pk]})
        self.lecture.refresh_from_db()
        self.assertTrue(self.lecture.is_published)
        R.objects.filter(pk=self.recording.pk).update(state=R.STATE_PUBLISHED)
        self.client.post(changelist, {"action": "unpublish_lectures", "_selected_action": [self.recording.pk]})
        self.lecture.refresh_from_db()
        self.assertFalse(self.lecture.is_published)

    def test_move_to_another_module_of_the_same_course(self):
        page = self.client.get(self.url("move"))
        self.assertContains(page, "Dorking")
        self.assertNotContains(page, "Foreign", msg_prefix="only modules of the recording's course are offered")
        refused = self.client.post(self.url("move"), {"module": self.foreign_module.pk})
        self.assertEqual(refused.status_code, 200)
        self.lecture.refresh_from_db()
        self.assertEqual(self.lecture.section_id, self.module.pk)
        self.client.post(self.url("move"), {"module": self.module2.pk})
        self.lecture.refresh_from_db()
        self.recording.refresh_from_db()
        self.assertEqual(self.lecture.section_id, self.module2.pk)
        self.assertEqual(self.recording.module_id, self.module2.pk)
        self.assertEqual(self.lecture.video_file.name.split("/")[-1], "class-recording-1.mp4", "video untouched")

    def test_retry(self):
        R.objects.filter(pk=self.recording.pk).update(state=R.STATE_FAILED, error="boom")
        self.assertContains(self.client.get(self.url("retry")), "boom")
        self.client.post(self.url("retry"))
        self.recording.refresh_from_db()
        self.assertEqual(self.recording.state, R.STATE_PROCESSING)
        self.assertEqual(self.recording.attempts, 1)

    def test_delete_files_confirmation_and_published_guard(self):
        parts = Path(self.work_root) / f"class-recording-{self.recording.pk}"
        parts.mkdir()
        (parts / "part-0001.ts").write_bytes(b"x" * 100)
        R.objects.filter(pk=self.recording.pk).update(work_dir=str(parts), state=R.STATE_PUBLISHED, part_count=1)
        self.make_ready()
        Lecture.objects.filter(pk=self.lecture.pk).update(is_published=True)
        page = self.client.get(self.url("delete_files"))
        self.assertContains(page, "Captured parts")
        self.assertContains(page, "Lecture video")
        self.assertContains(page, "is published")

        refused = self.client.post(self.url("delete_files"), {"kinds": ["lecture_video"]})
        self.assertEqual(refused.status_code, 200)
        self.assertContains(refused, "Tick the confirmation")
        self.assertTrue(self.video_path.exists())

        self.client.post(self.url("delete_files"), {"kinds": ["parts"]})
        self.assertFalse(parts.exists())
        self.recording.refresh_from_db()
        self.assertIsNotNone(self.recording.files_deleted_at)
        self.assertEqual(self.recording.part_count, 0)
        self.assertTrue(self.video_path.exists())

        self.client.post(self.url("delete_files"), {"kinds": ["lecture_video"], "confirm_published": "on"})
        self.assertFalse(self.video_path.exists())
        self.lecture.refresh_from_db()
        self.assertEqual(str(self.lecture.video_file or ""), "")
        self.assertEqual(self.lecture.stream_manifest_key, "streams/x/master.m3u8", "students keep the built stream")
        self.assertEqual(self.lecture.stream_status, Lecture.STREAM_READY)

    def test_delete_refused_while_recording(self):
        R.objects.filter(pk=self.recording.pk).update(state=R.STATE_RECORDING)
        response = self.client.post(self.url("delete_files"), {"kinds": ["lecture_video"]})
        self.assertContains(response, "still recording or finalizing")
        self.assertTrue(self.video_path.exists())

    def test_read_only_files_are_deleted_by_the_recorder(self):
        egress = Path(self.work_root) / "rooms" / "room.mp4"
        egress.parent.mkdir()
        egress.write_bytes(VIDEO)
        recording = R.objects.create(session=self.session, source=R.SOURCE_LIVEKIT_EGRESS, state=R.STATE_FAILED,
                                     source_path=str(egress))
        media_root = os.path.abspath(self.media_root)
        real_access = os.access

        def read_only_recordings(path, mode):  # what the web container sees: /recordings mounted ro
            return real_access(path, mode) and os.path.abspath(path).startswith(media_root)

        with patch("apps.realtime.recording.services.os.access", side_effect=read_only_recordings):
            response = self.client.post(self.url("delete_files", recording), {"kinds": ["source"]}, follow=True)
        self.assertContains(response, "deleted by the stream recorder")
        self.assertTrue(egress.exists())
        recording.refresh_from_db()
        self.assertEqual(recording.delete_requested_kinds, "source")
        StreamRecorder(popen=MagicMock(), owncast_status=lambda **_: {"online": False}).process_file_deletions()
        self.assertFalse(egress.exists())
        recording.refresh_from_db()
        self.assertEqual(recording.delete_requested_kinds, "")
        self.assertIsNone(recording.delete_requested_at)
        self.assertIsNotNone(recording.files_deleted_at)

    def test_publish_imported_recording_to_a_module(self):
        original = Path(self.work_root) / "old.mp4"
        original.write_bytes(VIDEO)
        imported = R.objects.create(source=R.SOURCE_IMPORTED, state=R.STATE_IMPORTED, source_path=str(original))
        page = self.client.get(self.url("assign", imported))
        self.assertContains(page, "OSINT Batch")  # optgroup per course
        self.assertContains(page, "Foreign")  # unassigned imports may go to any course
        self.client.post(self.url("assign", imported), {"module": self.module2.pk})
        imported.refresh_from_db()
        self.assertEqual(imported.state, R.STATE_FINALIZING)
        self.assertEqual(imported.module_id, self.module2.pk)
        again = self.client.post(self.url("assign", imported), {"module": self.module2.pk})
        self.assertContains(again, "Only an imported recording without a lecture")

    def test_scan_page_and_action(self):
        old = Path(self.work_root) / "egress" / "old class.mp4"
        old.parent.mkdir()
        old.write_bytes(VIDEO)
        stamp = time.time() - 7200
        os.utime(old, (stamp, stamp))
        page = self.client.get(reverse("admin:realtime_classrecording_scan"))
        self.assertContains(page, "Scan now")
        self.assertContains(page, "LiveKit egress outputs")
        response = self.client.post(reverse("admin:realtime_classrecording_scan"))
        self.assertEqual(response.status_code, 302)
        self.assertIn("state=imported", response["Location"])
        row = R.objects.get(source=R.SOURCE_IMPORTED)
        self.assertEqual(row.source_path, str(old.resolve()))
        self.assertEqual(row.file_size_bytes, len(VIDEO))
        self.client.post(reverse("admin:realtime_classrecording_scan"))
        self.assertEqual(R.objects.filter(source=R.SOURCE_IMPORTED).count(), 1, "idempotent")
