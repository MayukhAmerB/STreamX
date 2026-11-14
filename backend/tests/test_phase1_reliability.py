"""Phase 1B reliability and security quick wins.

* Session list: active-only default, staff-only history, shared cache with
  per-user visibility, ETag/304, bounded rows, read-only GETs.
* OBS stream health: written only by the periodic hook, compare-and-set.
* Join: live state (not the wall clock) gates attendees; per-user throttle.
* Periodic hooks: chat timeouts, OBS health, report housekeeping, JWT flush.
* Settings: PgBouncer-aware DB options, gunicorn recycling.
* Private media: lecture resources and recordings only through access-checked
  views (X-Accel-Redirect), including the admin links.
"""

from __future__ import annotations

import os
import runpy
import subprocess
import sys
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.core.worker import _periodic_hooks
from apps.courses.models import Course, LiveClass, LiveClassEnrollment
from apps.realtime import session_list
from apps.realtime.models import RealtimeSession, RealtimeSessionRecording
from apps.realtime.periodic import persist_obs_stream_health
from apps.realtime.serializers import RealtimeSessionRecordingSerializer
from apps.users.models import User
from config.throttling import RealtimeJoinIpCeilingThrottle, RealtimeJoinUserRateThrottle
from django.conf import settings
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import RequestFactory, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from .test_api import mark_terms_accepted

BACKEND_DIR = Path(__file__).resolve().parents[1]
PASSWORD = "StrongPass@123"
LIST_URL = "realtime-session-list-create"


class RealtimeFixtureMixin:
    def make_fixture(self):
        cache.clear()
        self.instructor = User.objects.create_user(
            email="phase1-host@test.com", password=PASSWORD, full_name="Host", role=User.ROLE_INSTRUCTOR
        )
        self.admin = User.objects.create_superuser(email="phase1-admin@test.com", password=PASSWORD, full_name="Admin")
        self.student = User.objects.create_user(
            email="phase1-student@test.com", password=PASSWORD, full_name="Student", role=User.ROLE_STUDENT
        )
        self.outsider = User.objects.create_user(
            email="phase1-outsider@test.com", password=PASSWORD, full_name="Outsider", role=User.ROLE_STUDENT
        )
        mark_terms_accepted(self.instructor, self.admin, self.student, self.outsider)
        self.course = Course.objects.create(
            title="Phase 1 Course", description="Course.", price="999.00", instructor=self.instructor, is_published=True
        )
        self.live_class = LiveClass.objects.create(
            title="Phase 1 Live Class",
            description="Live class.",
            level=LiveClass.LEVEL_BEGINNER,
            month_number=1,
            is_active=True,
            linked_course=self.course,
        )
        LiveClassEnrollment.objects.create(
            user=self.student, live_class=self.live_class, status=LiveClassEnrollment.STATUS_APPROVED
        )

    def make_session(self, **overrides):
        fields = {
            "title": "Session",
            "description": "Session.",
            "host": self.instructor,
            "session_type": RealtimeSession.TYPE_BROADCASTING,
            "linked_live_class": self.live_class,
            "linked_course": self.course,
            "status": RealtimeSession.STATUS_LIVE,
        }
        fields.update(overrides)
        return RealtimeSession.objects.create(**fields)

    def login(self, user):
        response = self.client.post(reverse("auth-login"), {"email": user.email, "password": PASSWORD}, format="json")
        self.assertEqual(response.status_code, 200)

    def list_ids(self, params=None, **headers):
        response = self.client.get(reverse(LIST_URL), params or {}, **headers)
        self.assertEqual(response.status_code, 200, response.content)
        return response, {row["id"] for row in response.data["data"]}


class SessionListTests(RealtimeFixtureMixin, APITestCase):
    def setUp(self):
        self.make_fixture()
        self.live = self.make_session(title="Live now")
        self.scheduled = self.make_session(title="Later", status=RealtimeSession.STATUS_SCHEDULED)
        self.ended = self.make_session(title="Old", status=RealtimeSession.STATUS_ENDED)
        self.foreign = self.make_session(title="Other class", linked_live_class=None, linked_course=Course.objects.create(
            title="Other", description="Other.", price="1.00", instructor=self.instructor, is_published=True
        ))
        self.open_session = self.make_session(title="Open to all", linked_live_class=None, linked_course=None)

    def test_omitted_status_returns_active_sessions_only(self):
        self.login(self.student)
        _, ids = self.list_ids()
        self.assertEqual(ids, {self.live.id, self.scheduled.id, self.open_session.id})

    def test_status_all_is_history_for_staff_and_active_for_everyone_else(self):
        self.login(self.student)
        _, student_ids = self.list_ids({"status": "all"})
        self.assertNotIn(self.ended.id, student_ids)
        self.assertIn(self.live.id, student_ids)

        self.client.post(reverse("auth-logout"))
        self.login(self.admin)
        _, admin_ids = self.list_ids({"status": "all"})
        self.assertIn(self.ended.id, admin_ids)
        self.assertIn(self.foreign.id, admin_ids)

        _, admin_default = self.list_ids()
        self.assertNotIn(self.ended.id, admin_default)

    def test_explicit_status_filters_still_work(self):
        self.login(self.student)
        _, live_ids = self.list_ids({"status": "live"})
        self.assertEqual(live_ids, {self.live.id, self.open_session.id})
        _, ended_ids = self.list_ids({"status": "ended"})
        self.assertEqual(ended_ids, {self.ended.id})

    def test_visibility_is_per_user_on_the_shared_cache(self):
        self.login(self.student)
        _, student_ids = self.list_ids()
        self.client.post(reverse("auth-logout"))
        self.login(self.outsider)
        _, outsider_ids = self.list_ids()
        self.assertIn(self.live.id, student_ids)
        self.assertNotIn(self.live.id, outsider_ids)
        self.assertNotIn(self.foreign.id, outsider_ids)
        self.assertIn(self.open_session.id, outsider_ids)

    @override_settings(REALTIME_SESSION_LIST_SHARED_CACHE_TTL_SECONDS=30)
    def test_students_share_one_cached_computation(self):
        with patch.object(session_list, "_compute_shared_rows", wraps=session_list._compute_shared_rows) as compute:
            self.login(self.student)
            self.list_ids()
            self.list_ids()
            self.client.post(reverse("auth-logout"))
            self.login(self.outsider)
            self.list_ids()
        self.assertEqual(compute.call_count, 1)

    def test_shared_rows_have_the_same_fields_and_flags_as_the_direct_path(self):
        self.login(self.student)
        response, _ = self.list_ids()
        shared_row = next(row for row in response.data["data"] if row["id"] == self.live.id)

        request = RequestFactory().get("/api/realtime/sessions/")
        request.user = self.student
        from apps.realtime.serializers import RealtimeSessionListSerializer

        direct_row = RealtimeSessionListSerializer(self.live, context={"request": request}).data
        self.assertEqual(set(shared_row), set(direct_row))
        self.assertFalse(shared_row["is_host"])
        self.assertFalse(shared_row["can_manage"])
        self.assertEqual(shared_row["obs_stream_key"], "")
        self.assertTrue(shared_row["viewer_can_join_now"])

    def test_moderators_get_their_private_fields(self):
        obs = self.make_session(
            title="OBS",
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            obs_stream_key="key",
        )
        self.login(self.instructor)
        response, _ = self.list_ids()
        row = next(item for item in response.data["data"] if item["id"] == obs.id)
        self.assertTrue(row["is_host"])
        self.assertTrue(row["can_manage"])

    @override_settings(REALTIME_SESSION_LIST_SHARED_CACHE_TTL_SECONDS=0)
    def test_etag_answers_304_until_the_list_changes(self):
        self.login(self.student)
        first, _ = self.list_ids()
        etag = first["ETag"]
        self.assertTrue(etag.startswith('W/"'))

        unchanged = self.client.get(reverse(LIST_URL), HTTP_IF_NONE_MATCH=etag)
        self.assertEqual(unchanged.status_code, 304)
        self.assertEqual(unchanged.content, b"")
        self.assertEqual(unchanged["ETag"], etag)

        RealtimeSession.objects.filter(pk=self.scheduled.pk).update(status=RealtimeSession.STATUS_LIVE)
        changed = self.client.get(reverse(LIST_URL), HTTP_IF_NONE_MATCH=etag)
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed["ETag"], etag)

    def test_etag_ignores_the_volatile_server_time(self):
        payload = [{"id": 1, "live_schedule": {"is_open": True, "server_time": "a"}}]
        moved = [{"id": 1, "live_schedule": {"is_open": True, "server_time": "b"}}]
        closed = [{"id": 1, "live_schedule": {"is_open": False, "server_time": "a"}}]
        self.assertEqual(session_list.build_etag(payload), session_list.build_etag(moved))
        self.assertNotEqual(session_list.build_etag(payload), session_list.build_etag(closed))

    @override_settings(REALTIME_SESSION_LIST_MAX_ROWS=2)
    def test_unpaginated_lists_are_bounded(self):
        for index in range(4):
            self.make_session(title=f"Extra {index}")
        self.login(self.student)
        _, ids = self.list_ids()
        self.assertEqual(len(ids), 2)
        self.client.post(reverse("auth-logout"))
        self.login(self.admin)
        _, admin_ids = self.list_ids({"status": "all"})
        self.assertEqual(len(admin_ids), 2)

    @patch("apps.realtime.services.get_owncast_public_status", return_value={"online": True})
    def test_list_and_detail_gets_never_write_stream_status(self, _status):
        obs = self.make_session(
            title="OBS live",
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            stream_status=RealtimeSession.STREAM_STARTING,
        )
        before = RealtimeSession.objects.get(pk=obs.pk).updated_at
        self.login(self.student)

        response, _ = self.list_ids()
        row = next(item for item in response.data["data"] if item["id"] == obs.id)
        self.assertEqual(row["stream_status"], RealtimeSession.STREAM_LIVE)
        detail = self.client.get(reverse("realtime-session-detail", kwargs={"pk": obs.pk}))
        self.assertEqual(detail.data["data"]["stream_status"], RealtimeSession.STREAM_LIVE)

        obs.refresh_from_db()
        self.assertEqual(obs.stream_status, RealtimeSession.STREAM_STARTING)
        self.assertEqual(obs.updated_at, before)


class ObsStreamHealthWriterTests(RealtimeFixtureMixin, TestCase):
    def setUp(self):
        self.make_fixture()

    # The legacy OBS writer runs until LIVE_RECONCILER_MODE=enforce, where the
    # live reconciler takes over (tests/test_live_lifecycle.py).
    @override_settings(LIVE_RECONCILER_MODE="shadow")
    @patch("apps.realtime.services.get_owncast_public_status", return_value={"online": True})
    def test_periodic_hook_persists_obs_stream_status(self, _status):
        obs = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS, stream_status=RealtimeSession.STREAM_STARTING
        )
        self.assertEqual(persist_obs_stream_health(), 1)
        obs.refresh_from_db()
        self.assertEqual(obs.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertEqual(persist_obs_stream_health(), 0)

    def test_stale_row_cannot_resurrect_a_stopped_stream(self):
        obs = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS, stream_status=RealtimeSession.STREAM_LIVE
        )
        stale = RealtimeSession.objects.get(pk=obs.pk)
        RealtimeSession.objects.filter(pk=obs.pk).update(stream_status=RealtimeSession.STREAM_STOPPED)

        # A writer that loaded "live" earlier now applies a transition.
        changed = stale.sync_stream_status(RealtimeSession.STREAM_FAILED)

        self.assertFalse(changed)
        obs.refresh_from_db()
        self.assertEqual(obs.stream_status, RealtimeSession.STREAM_STOPPED)
        self.assertEqual(stale.stream_status, RealtimeSession.STREAM_STOPPED)

    def test_hooks_are_registered(self):
        for name in (
            "realtime.chat_timeouts",
            "realtime.obs_stream_health",
            "reports.housekeeping",
            "users.flush_expired_tokens",
        ):
            self.assertIn(name, _periodic_hooks)


class JoinGateTests(RealtimeFixtureMixin, APITestCase):
    def setUp(self):
        self.make_fixture()

    def join(self, session):
        return self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.pk}), {"display_name": "Student"}, format="json"
        )

    @patch("apps.realtime.services.get_owncast_public_status", return_value={"online": False})
    def test_live_obs_class_admits_viewers_while_the_encoder_is_offline(self, _status):
        obs = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            stream_status=RealtimeSession.STREAM_STOPPED,
            stream_embed_url="https://stream.example.com/embed/video",
        )
        self.login(self.student)
        response = self.join(obs)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.data["data"]["mode"], "broadcast")
        obs.refresh_from_db()
        self.assertEqual(obs.stream_status, RealtimeSession.STREAM_STOPPED)  # join writes nothing

    def test_ended_session_is_still_refused(self):
        ended = self.make_session(status=RealtimeSession.STATUS_ENDED)
        self.login(self.student)
        self.assertEqual(self.join(ended).status_code, 400)

    def test_meeting_the_host_never_ended_stops_admitting_attendees(self):
        # D1 bound: live state admits attendees whatever the clock says, but a
        # room left live for longer than the bound is abandoned, not a class.
        abandoned = self.make_session(session_type=RealtimeSession.TYPE_MEETING)
        RealtimeSession.objects.filter(pk=abandoned.pk).update(started_at=timezone.now() - timedelta(hours=7))
        self.login(self.student)
        response = self.join(abandoned)
        self.assertEqual(response.status_code, 409, response.content)
        self.assertIn("finished", response.data["message"])
        abandoned.refresh_from_db()
        self.assertEqual(abandoned.status, RealtimeSession.STATUS_LIVE)  # the host can still enter and end it

    def test_session_list_reports_an_abandoned_session_as_not_joinable(self):
        recent = self.make_session(session_type=RealtimeSession.TYPE_MEETING, title="Recent")
        abandoned = self.make_session(session_type=RealtimeSession.TYPE_MEETING, title="Abandoned")
        RealtimeSession.objects.filter(pk=abandoned.pk).update(started_at=timezone.now() - timedelta(hours=7))
        self.login(self.student)
        response = self.client.get(reverse(LIST_URL))
        self.assertEqual(response.status_code, 200, response.content)
        joinable = {row["id"]: row["viewer_can_join_now"] for row in response.data["data"]}
        self.assertTrue(joinable[recent.pk])
        self.assertFalse(joinable[abandoned.pk])

    def test_join_throttle_is_per_user_with_an_ip_ceiling(self):
        factory = RequestFactory()

        def keyed(throttle_class, user):
            request = factory.post("/join/", REMOTE_ADDR="203.0.113.7")
            request.user = user
            throttle = throttle_class.__new__(throttle_class)
            throttle.scope = throttle_class.scope
            return throttle.get_cache_key(request, None)

        self.assertNotEqual(
            keyed(RealtimeJoinUserRateThrottle, self.student), keyed(RealtimeJoinUserRateThrottle, self.outsider)
        )
        self.assertEqual(
            keyed(RealtimeJoinIpCeilingThrottle, self.student), keyed(RealtimeJoinIpCeilingThrottle, self.outsider)
        )

    def test_one_users_budget_does_not_lock_out_classmates_on_the_same_ip(self):
        rates = {"realtime_session_join": "2/hour", "realtime_session_join_ip": "1000/hour"}
        session = self.make_session(status=RealtimeSession.STATUS_ENDED)  # cheap 400s still count
        with (
            patch.object(RealtimeJoinUserRateThrottle, "THROTTLE_RATES", rates),
            patch.object(RealtimeJoinIpCeilingThrottle, "THROTTLE_RATES", rates),
        ):
            self.login(self.student)
            statuses = [self.join(session).status_code for _ in range(3)]
            self.assertEqual(statuses, [400, 400, 429])
            self.client.post(reverse("auth-logout"))
            self.login(self.outsider)
            self.assertEqual(self.join(session).status_code, 400)


class ChatTimeoutReleaseRotationTests(RealtimeFixtureMixin, TestCase):
    def setUp(self):
        self.make_fixture()
        self.session = self.make_session()

    def identity(self, user, owncast_user_id, minutes_ago):
        from apps.realtime.models import OwncastChatIdentity

        return OwncastChatIdentity.objects.create(
            session=self.session,
            user=user,
            platform_user_id=user.id,
            platform_email=user.email,
            platform_full_name=user.full_name,
            platform_role=user.role,
            platform_display_name=user.full_name,
            owncast_user_id=owncast_user_id,
            owncast_display_name=user.full_name,
            owncast_disabled_at=timezone.now() - timedelta(minutes=minutes_ago + 10),
            owncast_timeout_until=timezone.now() - timedelta(minutes=minutes_ago),
        )

    def test_permanently_failing_identities_do_not_starve_newer_ones(self):
        from apps.realtime.services import OwncastAdminError, release_expired_owncast_chat_timeouts

        self.identity(self.outsider, "deleted-in-owncast", minutes_ago=60)
        newer = self.identity(self.student, "still-exists", minutes_ago=5)

        def enable(*, owncast_user_id, enabled, timeout):
            if owncast_user_id == "deleted-in-owncast":
                raise OwncastAdminError("user not found")
            return {}

        with patch("apps.realtime.services.owncast_set_chat_user_enabled", side_effect=enable):
            first = release_expired_owncast_chat_timeouts(limit=1)
            second = release_expired_owncast_chat_timeouts(limit=1)

        self.assertEqual((first["released"], len(first["errors"])), (0, 1))
        self.assertEqual((second["released"], len(second["errors"])), (1, 0))
        newer.refresh_from_db()
        self.assertIsNone(newer.owncast_timeout_until)


class HousekeepingHookTests(TestCase):
    def test_report_housekeeping_runs_once_per_hour_bucket(self):
        from apps.reports.housekeeping import EVENT_HOUSEKEEPING, schedule_housekeeping

        now = timezone.now()
        schedule_housekeeping(now)
        schedule_housekeeping(now)
        self.assertEqual(OutboxEvent.objects.filter(event_type=EVENT_HOUSEKEEPING).count(), 1)
        with patch(
            "apps.reports.housekeeping.run_housekeeping", return_value={"reminders_sent": 0, "staged_pruned": 0}
        ) as run:
            drain_outbox(batch_size=10)
        run.assert_called_once()

    def test_expired_refresh_tokens_are_flushed_in_batches(self):
        from apps.users.token_housekeeping import (
            EVENT_FLUSH_EXPIRED_TOKENS,
            flush_expired_tokens,
            schedule_flush_expired_tokens,
        )
        from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken

        user = User.objects.create_user(email="tokens@test.com", password=PASSWORD, full_name="Tokens")
        now = timezone.now()
        expired = [
            OutstandingToken.objects.create(
                user=user, jti=f"expired-{index}", token=f"t{index}", created_at=now, expires_at=now - timedelta(days=1)
            )
            for index in range(5)
        ]
        BlacklistedToken.objects.create(token=expired[0])
        fresh = OutstandingToken.objects.create(
            user=user, jti="fresh", token="fresh", created_at=now, expires_at=now + timedelta(days=1)
        )

        self.assertEqual(flush_expired_tokens(now=now, batch_size=2), 5)
        self.assertEqual(list(OutstandingToken.objects.values_list("pk", flat=True)), [fresh.pk])
        self.assertFalse(BlacklistedToken.objects.exists())

        schedule_flush_expired_tokens(now)
        schedule_flush_expired_tokens(now)
        self.assertEqual(OutboxEvent.objects.filter(event_type=EVENT_FLUSH_EXPIRED_TOKENS).count(), 1)


class RuntimeConfigTests(TestCase):
    def _settings_for(self, database_url, **extra_env):
        env = {**os.environ, "DATABASE_URL": database_url, "DJANGO_SETTINGS_MODULE": "config.settings.dev", **extra_env}
        env.pop("DATABASE_CONN_HEALTH_CHECKS", None)
        code = (
            "from django.conf import settings; d = settings.DATABASES['default']; "
            "print(d['CONN_HEALTH_CHECKS'], d.get('DISABLE_SERVER_SIDE_CURSORS'))"
        )
        result = subprocess.run(
            [sys.executable, "-c", code], cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=60
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip().splitlines()[-1]

    def test_pgbouncer_connections_skip_health_checks_and_server_side_cursors(self):
        self.assertEqual(self._settings_for("postgresql://u:p@pgbouncer:5432/db"), "False True")
        self.assertEqual(self._settings_for("postgresql://u:p@postgres:5432/db"), "True True")
        self.assertEqual(
            self._settings_for("postgresql://u:p@pgbouncer:5432/db", DATABASE_POOLER_CONN_HEALTH_CHECKS="1"),
            "True True",
        )

    def test_gunicorn_recycles_workers_rarely_with_jitter(self):
        cleaned = {k: v for k, v in os.environ.items() if not k.startswith("GUNICORN_MAX_REQUESTS")}
        with patch.dict(os.environ, cleaned, clear=True):
            config = runpy.run_path(str(BACKEND_DIR / "gunicorn.conf.py"))
        self.assertEqual(config["max_requests"], 10000)
        self.assertEqual(config["max_requests_jitter"], 1000)


class PrivateMediaTests(RealtimeFixtureMixin, APITestCase):
    def setUp(self):
        self.make_fixture()
        self.media_root = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.media_root, ignore_errors=True))
        media_override = override_settings(MEDIA_ROOT=self.media_root)
        media_override.enable()
        self.addCleanup(media_override.disable)
        self.session = self.make_session(session_type=RealtimeSession.TYPE_MEETING)
        self.recording = RealtimeSessionRecording.objects.create(
            session=self.session,
            recording_type=RealtimeSession.TYPE_MEETING,
            started_by=self.instructor,
            status=RealtimeSessionRecording.STATUS_COMPLETED,
            video_file=SimpleUploadedFile("class.webm", b"\x1a\x45\xdf\xa3webm", content_type="video/webm"),
        )
        self.download_url = reverse("realtime-session-recording-download", kwargs={"recording_id": self.recording.pk})

    def test_recording_playback_url_is_the_access_checked_view(self):
        request = RequestFactory().get("/")
        url = RealtimeSessionRecordingSerializer(self.recording, context={"request": request}).data["playback_url"]
        self.assertTrue(url.endswith(self.download_url), url)
        self.assertNotIn("/media/", url)

    def test_recording_download_checks_access_then_hands_off_to_nginx(self):
        self.login(self.outsider)
        self.assertEqual(self.client.get(self.download_url).status_code, 403)
        self.client.post(reverse("auth-logout"))

        self.login(self.student)
        response = self.client.get(self.download_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["X-Accel-Redirect"], f"/_protected_media/{self.recording.video_file.name}")
        self.assertEqual(response["Cache-Control"], "private, no-store")

    def test_recording_admin_links_the_protected_view(self):
        self.client.force_login(self.admin)
        page = self.client.get(reverse("admin:realtime_realtimesessionrecording_change", args=[self.recording.pk]))
        self.assertEqual(page.status_code, 200)
        content = page.content.decode()
        self.assertNotIn(f"{settings.MEDIA_URL}realtime_recordings/", content)
        self.assertIn(reverse("admin:realtime_realtimesessionrecording_media", args=[self.recording.pk]), content)

    def test_lecture_resource_admin_link_and_view_are_staff_only(self):
        from apps.courses.models import Lecture, LectureResource, Section

        section = Section.objects.create(course=self.course, title="Module", order=1)
        lecture = Lecture.objects.create(section=section, title="Lecture", order=1)
        resource = LectureResource.objects.create(
            lecture=lecture,
            title="Sheet",
            resource_file=SimpleUploadedFile("sheet.pdf", b"%PDF-1.4 sheet", content_type="application/pdf"),
            order=1,
        )
        file_url = reverse("admin:courses_lecture_resource_file", args=[lecture.pk, resource.pk])

        self.client.force_login(self.admin)
        page = self.client.get(reverse("admin:courses_lecture_change", args=[lecture.pk]))
        self.assertEqual(page.status_code, 200)
        content = page.content.decode()
        self.assertIn(file_url, content)
        self.assertNotIn(f"{settings.MEDIA_URL}lecture_resources/", content)

        download = self.client.get(file_url)
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download["X-Accel-Redirect"], f"/_protected_media/{resource.resource_file.name}")
        self.assertIn("attachment;", download["Content-Disposition"])

        self.client.logout()
        self.client.force_login(self.student)
        self.assertNotEqual(self.client.get(file_url).status_code, 200)

    def test_resource_download_refuses_storage_names_outside_lecture_resources(self):
        from apps.courses.models import Lecture, LectureResource, Section

        section = Section.objects.create(course=self.course, title="Module 2", order=2)
        lecture = Lecture.objects.create(section=section, title="Lecture 2", order=1)
        resource = LectureResource.objects.create(
            lecture=lecture,
            title="Sheet",
            resource_file=SimpleUploadedFile("sheet.pdf", b"%PDF-1.4 sheet", content_type="application/pdf"),
            order=1,
        )
        stray = Path(settings.MEDIA_ROOT) / "profile_images" / "phase1-stray.png"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_bytes(b"\x89PNG stray")
        self.addCleanup(stray.unlink, missing_ok=True)
        LectureResource.objects.filter(pk=resource.pk).update(resource_file="profile_images/phase1-stray.png")

        self.client.force_login(self.admin)
        response = self.client.get(reverse("admin:courses_lecture_resource_file", args=[lecture.pk, resource.pk]))
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("X-Accel-Redirect", response)
