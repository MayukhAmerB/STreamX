"""Live broadcast hardening: Owncast status single-flight, idempotent OBS
re-prepare, and Host Studio egress verification/restart (LiveKit mocked)."""

import json
import threading
import time
from decimal import Decimal
from unittest.mock import MagicMock, patch
from urllib.error import URLError

from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.courses.models import Course, LiveClass, LiveClassEnrollment
from apps.realtime import services as realtime_services
from apps.realtime.models import RealtimeSession
from apps.users.models import User
from apps.users.terms import TERMS_VERSION


OWNCAST_STATUS_URL_FRAGMENT = "/api/status"

LIVEKIT_SETTINGS = {
    "OWNCAST_RTMP_TARGET": "rtmp://owncast:1935/live/stream-key",
    "LIVEKIT_URL": "ws://livekit.test",
    "LIVEKIT_API_KEY": "devkey",
    "LIVEKIT_API_SECRET": "secret",
}


def _owncast_response(online=True):
    response = MagicMock()
    response.read.return_value = json.dumps({"online": online, "viewerCount": 3}).encode("utf-8")
    response.__enter__.return_value = response
    response.__exit__.return_value = False
    return response


def _status_calls(mock_urlopen):
    return [
        call
        for call in mock_urlopen.call_args_list
        if OWNCAST_STATUS_URL_FRAGMENT in getattr(call.args[0], "full_url", str(call.args[0]))
    ]


@override_settings(
    OWNCAST_BASE_URL="http://owncast:8080",
    OWNCAST_ADMIN_API_BASE_URL="",
    REALTIME_OWNCAST_STATUS_CACHE_TTL_SECONDS=3,
)
class OwncastStatusSingleFlightTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    @patch("apps.realtime.services.urlopen")
    def test_repeated_reads_within_ttl_cost_one_owncast_call(self, mock_urlopen):
        mock_urlopen.return_value = _owncast_response(online=True)

        payloads = [realtime_services.get_owncast_public_status() for _ in range(5)]

        self.assertTrue(all(payload["online"] for payload in payloads))
        self.assertEqual(len(_status_calls(mock_urlopen)), 1)

    @patch("apps.realtime.services.urlopen")
    def test_concurrent_cold_reads_share_one_owncast_call(self, mock_urlopen):
        def slow_owncast(*args, **kwargs):
            time.sleep(0.3)
            return _owncast_response(online=True)

        mock_urlopen.side_effect = slow_owncast
        results = []

        def read_status():
            results.append(realtime_services.get_owncast_public_status())

        threads = [threading.Thread(target=read_status) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(len(results), 8)
        self.assertTrue(all(result.get("online") is True for result in results))
        self.assertEqual(len(_status_calls(mock_urlopen)), 1)

    @patch("apps.realtime.services.urlopen")
    def test_reader_gets_last_known_payload_while_another_worker_refreshes(self, mock_urlopen):
        cache.set(realtime_services.OWNCAST_STATUS_LOCK_KEY, "other-worker", timeout=30)
        cache.set(realtime_services.OWNCAST_STATUS_STALE_CACHE_KEY, {"online": True}, timeout=30)

        payload = realtime_services.get_owncast_public_status()

        self.assertEqual(payload, {"online": True})
        mock_urlopen.assert_not_called()

    @patch("apps.realtime.services.urlopen")
    def test_unreachable_owncast_is_not_retried_by_every_request(self, mock_urlopen):
        mock_urlopen.side_effect = URLError("connection refused")

        first = realtime_services.get_owncast_public_status()
        second = realtime_services.get_owncast_public_status()

        self.assertEqual(first, {})
        self.assertEqual(second, {})
        self.assertEqual(len(_status_calls(mock_urlopen)), 1)
        self.assertIsNone(cache.get(realtime_services.OWNCAST_STATUS_LOCK_KEY))

    @patch("apps.realtime.services.urlopen")
    def test_force_refresh_bypasses_the_fresh_cache(self, mock_urlopen):
        mock_urlopen.side_effect = [_owncast_response(online=True), _owncast_response(online=False)]

        self.assertTrue(realtime_services.get_owncast_public_status()["online"])
        self.assertFalse(realtime_services.get_owncast_public_status(force_refresh=True)["online"])
        self.assertEqual(len(_status_calls(mock_urlopen)), 2)


class BroadcastEgressStatusTests(SimpleTestCase):
    @patch("apps.realtime.services._twirp_post")
    def test_status_names_and_numbers_are_normalized(self, mock_twirp_post):
        cases = [
            ({"egress_id": "EG_1", "status": "EGRESS_ACTIVE"}, True, "EGRESS_ACTIVE"),
            ({"egress_id": "EG_1", "status": 1}, True, "EGRESS_ACTIVE"),
            ({"egress_id": "EG_1"}, True, "EGRESS_STARTING"),
            ({"egressId": "EG_1", "status": "EGRESS_FAILED", "error": "rtmp closed"}, False, "EGRESS_FAILED"),
            ({"egress_id": "EG_1", "status": 3}, False, "EGRESS_COMPLETE"),
            ({"egress_id": "EG_1", "status": "EGRESS_SOMETHING_NEW"}, None, "EGRESS_SOMETHING_NEW"),
        ]
        for item, running, status_name in cases:
            with self.subTest(item=item):
                mock_twirp_post.return_value = {"items": [item]}
                result = realtime_services.get_broadcast_egress_status(egress_id="EG_1")
                self.assertIs(result["running"], running)
                self.assertEqual(result["status"], status_name)

        self.assertEqual(mock_twirp_post.call_args.args[0], "livekit.Egress/ListEgress")
        self.assertEqual(mock_twirp_post.call_args.args[1], {"egress_id": "EG_1"})
        self.assertIsNotNone(mock_twirp_post.call_args.kwargs.get("timeout"))

    @patch("apps.realtime.services._twirp_post")
    def test_unknown_egress_is_not_running(self, mock_twirp_post):
        mock_twirp_post.return_value = {"items": []}

        result = realtime_services.get_broadcast_egress_status(egress_id="EG_gone")

        self.assertIs(result["running"], False)
        self.assertEqual(result["status"], "EGRESS_NOT_FOUND")


class LiveBroadcastViewTestCase(APITestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        schedule_patcher = patch(
            "apps.realtime.views.get_live_class_schedule_snapshot",
            return_value={"is_open": True, "label": "Friday 7:00 PM to 8:00 PM IST"},
        )
        schedule_patcher.start()
        self.addCleanup(schedule_patcher.stop)
        self.host = User.objects.create_user(
            email="host-hardening@test.com",
            password="StrongPass@123",
            full_name="Host User",
            role=User.ROLE_INSTRUCTOR,
        )
        self.viewer = User.objects.create_user(
            email="viewer-hardening@test.com",
            password="StrongPass@123",
            full_name="Viewer User",
            role=User.ROLE_STUDENT,
        )
        accepted_at = timezone.now()
        for user in (self.host, self.viewer):
            user.terms_accepted_version = TERMS_VERSION
            user.terms_accepted_at = accepted_at
            user.notifications_consent_version = TERMS_VERSION
            user.notifications_consented_at = accepted_at
            user.save()
        self.course = Course.objects.create(
            title="Hardening Course",
            description="Course for live broadcast hardening tests.",
            price=Decimal("999.00"),
            instructor=self.host,
            is_published=True,
        )
        self.live_class = LiveClass.objects.create(
            title="Hardening Live Class",
            description="Live class for broadcast hardening tests.",
            level=LiveClass.LEVEL_BEGINNER,
            month_number=1,
            is_active=True,
            linked_course=self.course,
        )
        LiveClassEnrollment.objects.create(
            user=self.viewer,
            live_class=self.live_class,
            status=LiveClassEnrollment.STATUS_APPROVED,
        )

    def login(self, user):
        response = self.client.post(
            reverse("auth-login"),
            {"email": user.email, "password": "StrongPass@123"},
            format="json",
        )
        self.assertEqual(response.status_code, 200)

    def make_session(self, **overrides):
        values = {
            "title": "Live Broadcast",
            "description": "Broadcast under test",
            "host": self.host,
            "session_type": RealtimeSession.TYPE_BROADCASTING,
            "status": RealtimeSession.STATUS_LIVE,
            "linked_live_class": self.live_class,
            "linked_course": self.course,
        }
        values.update(overrides)
        return RealtimeSession.objects.create(**values)


@override_settings(
    OWNCAST_BASE_URL="http://owncast:8080",
    OWNCAST_ADMIN_API_BASE_URL="",
    OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
)
class StudentJoinOwncastLoadTests(LiveBroadcastViewTestCase):
    @patch("apps.realtime.services.urlopen")
    def test_class_joining_at_once_costs_one_owncast_status_call(self, mock_urlopen):
        mock_urlopen.return_value = _owncast_response(online=True)
        session = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            stream_status=RealtimeSession.STREAM_LIVE,
            stream_embed_url="https://stream.example.com/embed/video",
            chat_embed_url="https://stream.example.com/embed/chat/readwrite",
        )
        self.login(self.viewer)

        for _ in range(3):
            response = self.client.post(
                reverse("realtime-session-join", kwargs={"pk": session.id}),
                {"display_name": "Viewer User"},
                format="json",
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data["data"]["mode"], "broadcast")

        self.assertEqual(len(_status_calls(mock_urlopen)), 1)

    @patch("apps.realtime.views.refresh_obs_session_stream_health")
    def test_join_reads_the_cached_owncast_status(self, mock_refresh):
        mock_refresh.return_value = {"stream_status": "live", "online": True, "changed": False}
        session = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            stream_status=RealtimeSession.STREAM_LIVE,
        )
        self.login(self.viewer)

        self.client.post(
            reverse("realtime-session-join", kwargs={"pk": session.id}),
            {"display_name": "Viewer User"},
            format="json",
        )

        self.assertTrue(mock_refresh.called)
        for call in mock_refresh.call_args_list:
            self.assertFalse(call.kwargs.get("force_refresh", False))


@override_settings(
    OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
    OWNCAST_OBS_STREAM_SERVER_URL="rtmp://obs.example.com:1935/live",
)
class ObsRePrepareWhileLiveTests(LiveBroadcastViewTestCase):
    def setUp(self):
        super().setUp()
        self.session = self.make_session(
            stream_service=RealtimeSession.STREAM_SERVICE_OBS,
            stream_status=RealtimeSession.STREAM_LIVE,
            obs_stream_key="default-key",
        )
        self.login(self.host)

    def start(self):
        return self.client.post(
            reverse("realtime-session-stream-start", kwargs={"pk": self.session.id}),
            {},
            format="json",
        )

    @patch("apps.realtime.views.sync_owncast_stream_key")
    @patch("apps.realtime.views.refresh_obs_session_stream_health")
    def test_prepare_while_obs_is_publishing_is_an_idempotent_200(self, mock_refresh, mock_sync_key):
        mock_refresh.return_value = {"stream_status": "live", "online": True, "changed": False}

        response = self.start()

        self.assertEqual(response.status_code, 200)
        self.assertIn("already live", response.data["message"])
        mock_sync_key.assert_not_called()
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)

    @patch("apps.realtime.views.sync_owncast_stream_key")
    @patch("apps.realtime.views.refresh_obs_session_stream_health")
    def test_prepare_during_offline_grace_re_prepares_without_a_500(self, mock_refresh, mock_sync_key):
        # Owncast offline but still inside the grace window: the session stays live.
        mock_refresh.return_value = {"stream_status": "live", "online": False, "changed": False, "grace_active": True}
        mock_sync_key.return_value = {"success": True}

        response = self.start()

        self.assertEqual(response.status_code, 200)
        self.assertIn("re-prepared", response.data["message"])
        mock_sync_key.assert_called_once_with("default-key")
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)

    @patch("apps.realtime.views.sync_owncast_stream_key")
    @patch("apps.realtime.views.refresh_obs_session_stream_health")
    def test_key_sync_failure_while_live_keeps_the_class_live(self, mock_refresh, mock_sync_key):
        mock_refresh.return_value = {"stream_status": "live", "online": None, "changed": False}
        mock_sync_key.side_effect = realtime_services.OwncastAdminError("owncast admin down")

        response = self.start()

        self.assertEqual(response.status_code, 400)
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertIn("owncast admin down", self.session.livekit_egress_error)

    def test_start_on_an_ended_session_is_a_409(self):
        self.session.status = RealtimeSession.STATUS_ENDED
        self.session.save(update_fields=["status", "updated_at"])

        response = self.start()

        self.assertEqual(response.status_code, 409)


@override_settings(**LIVEKIT_SETTINGS)
class HostStudioStartLiveTests(LiveBroadcastViewTestCase):
    def setUp(self):
        super().setUp()
        self.login(self.host)

    def start(self, session):
        return self.client.post(
            reverse("realtime-session-stream-start", kwargs={"pk": session.id}),
            {},
            format="json",
        )

    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_running_egress_answers_already_live(self, mock_status, mock_start):
        mock_status.return_value = {"running": True, "status": "EGRESS_ACTIVE", "error": ""}
        session = self.make_session(stream_status=RealtimeSession.STREAM_LIVE, livekit_egress_id="EG_alive")

        response = self.start(session)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["message"], "Stream already live.")
        mock_status.assert_called_once_with(egress_id="EG_alive")
        mock_start.assert_not_called()

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_dead_egress_is_restarted_instead_of_answering_already_live(self, mock_status, mock_start, mock_stop):
        mock_status.return_value = {"running": False, "status": "EGRESS_FAILED", "error": "rtmp closed"}
        mock_start.return_value = "EG_new"
        session = self.make_session(stream_status=RealtimeSession.STREAM_LIVE, livekit_egress_id="EG_dead")

        response = self.start(session)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["message"], "Live stream started.")
        mock_stop.assert_called_once_with(egress_id="EG_dead")
        mock_start.assert_called_once()
        self.assertEqual(mock_start.call_args.kwargs["session_id"], session.id)
        self.assertEqual(
            mock_start.call_args.kwargs["participant_identity"],
            f"host-{self.host.id}-session-{session.id}",
        )
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertEqual(session.livekit_egress_id, "EG_new")

    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_unverifiable_egress_does_not_start_a_duplicate(self, mock_status, mock_start):
        mock_status.side_effect = realtime_services.LiveKitEgressError("Egress network error")
        session = self.make_session(stream_status=RealtimeSession.STREAM_LIVE, livekit_egress_id="EG_maybe")

        response = self.start(session)

        self.assertEqual(response.status_code, 200)
        self.assertIn("did not confirm", response.data["message"])
        mock_start.assert_not_called()

    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_live_without_an_egress_id_starts_one(self, mock_start):
        mock_start.return_value = "EG_first"
        session = self.make_session(stream_status=RealtimeSession.STREAM_LIVE, livekit_egress_id="")

        response = self.start(session)

        self.assertEqual(response.status_code, 200)
        session.refresh_from_db()
        self.assertEqual(session.livekit_egress_id, "EG_first")

    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_egress_start_failure_is_a_clear_400(self, mock_start):
        mock_start.side_effect = realtime_services.LiveKitEgressError("participant not found")
        session = self.make_session(stream_status=RealtimeSession.STREAM_IDLE)

        response = self.start(session)

        self.assertEqual(response.status_code, 400)
        self.assertIn("participant not found", response.data["errors"]["detail"])
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_FAILED)

    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_concurrent_start_while_another_request_holds_the_lock_is_a_409(self, mock_start):
        session = self.make_session(stream_status=RealtimeSession.STREAM_IDLE)
        cache.set(f"realtime:host-egress:{session.id}:lock", "1", timeout=60)

        response = self.start(session)

        self.assertEqual(response.status_code, 409)
        mock_start.assert_not_called()


@override_settings(REALTIME_HOST_EGRESS_CHECK_INTERVAL_SECONDS=10, **LIVEKIT_SETTINGS)
class HostStudioHeartbeatTests(LiveBroadcastViewTestCase):
    def setUp(self):
        super().setUp()
        self.session = self.make_session(stream_status=RealtimeSession.STREAM_LIVE, livekit_egress_id="EG_live")
        self.login(self.host)

    def heartbeat(self, publishing=True, session=None):
        return self.client.post(
            reverse("realtime-session-stream-heartbeat", kwargs={"pk": (session or self.session).id}),
            {"publishing": publishing},
            format="json",
        )

    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_running_egress_is_checked_at_most_once_per_interval(self, mock_status, mock_start):
        mock_status.return_value = {"running": True, "status": "EGRESS_ACTIVE", "error": ""}

        first = self.heartbeat()
        second = self.heartbeat()

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.data["data"]["egress"]["status"], "EGRESS_ACTIVE")
        self.assertFalse(first.data["data"]["restarted"])
        self.assertEqual(second.data["data"]["egress"]["status"], "EGRESS_ACTIVE")
        self.assertEqual(mock_status.call_count, 1)
        mock_start.assert_not_called()

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_dead_egress_is_restarted_while_the_host_publishes(self, mock_status, mock_start, mock_stop):
        mock_status.return_value = {"running": False, "status": "EGRESS_ABORTED", "error": "participant left"}
        mock_start.return_value = "EG_revived"

        response = self.heartbeat(publishing=True)

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["data"]["restarted"])
        self.assertEqual(response.data["data"]["session"]["stream_status"], RealtimeSession.STREAM_LIVE)
        self.session.refresh_from_db()
        self.assertEqual(self.session.livekit_egress_id, "EG_revived")
        mock_stop.assert_called_once_with(egress_id="EG_live")

    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_dead_egress_without_a_publisher_marks_the_stream_failed(self, mock_status, mock_start):
        mock_status.return_value = {"running": False, "status": "EGRESS_COMPLETE", "error": ""}

        response = self.heartbeat(publishing=False)

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["data"]["restarted"])
        mock_start.assert_not_called()
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_FAILED)
        self.assertIn("Live delivery stopped", self.session.livekit_egress_error)

    @override_settings(REALTIME_HOST_EGRESS_MAX_AUTO_RESTARTS=1)
    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_automatic_restarts_are_capped(self, mock_status, mock_start, mock_stop):
        mock_status.return_value = {"running": False, "status": "EGRESS_FAILED", "error": "crash loop"}
        mock_start.side_effect = ["EG_retry_1", "EG_retry_2"]

        first = self.heartbeat()
        second = self.heartbeat()

        self.assertTrue(first.data["data"]["restarted"])
        self.assertFalse(second.data["data"]["restarted"])
        self.assertEqual(mock_start.call_count, 1)
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_FAILED)
        self.assertIn("repeatedly", self.session.livekit_egress_error)

    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_heartbeat_for_a_stream_that_is_not_live_does_not_touch_livekit(self, mock_status):
        session = self.make_session(stream_status=RealtimeSession.STREAM_STOPPED)

        response = self.heartbeat(session=session)

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data["data"]["egress"])
        mock_status.assert_not_called()

    def test_students_cannot_send_heartbeats(self):
        self.client.post(reverse("auth-logout"), {}, format="json")
        self.login(self.viewer)

        response = self.heartbeat()

        self.assertEqual(response.status_code, 403)


@override_settings(REALTIME_HOST_EGRESS_CHECK_INTERVAL_SECONDS=10, **LIVEKIT_SETTINGS)
class HostStudioEgressRestartRaceTests(LiveBroadcastViewTestCase):
    """The heartbeat/Start Live restart is a compare-and-set on the judged egress."""

    def setUp(self):
        super().setUp()
        self.session = self.make_session(stream_status=RealtimeSession.STREAM_LIVE, livekit_egress_id="EG_1")
        self.login(self.host)

    def heartbeat(self, publishing=True):
        return self.client.post(
            reverse("realtime-session-stream-heartbeat", kwargs={"pk": self.session.id}),
            {"publishing": publishing},
            format="json",
        )

    def stop_in_db(self):
        RealtimeSession.objects.filter(pk=self.session.pk).update(
            stream_status=RealtimeSession.STREAM_STOPPED, livekit_egress_id=""
        )

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_stop_during_the_livekit_check_is_not_revived(self, mock_status, mock_start, mock_stop):
        def host_presses_stop_while_livekit_is_queried(**kwargs):
            self.stop_in_db()
            return {"running": False, "status": "EGRESS_COMPLETE", "error": ""}

        mock_status.side_effect = host_presses_stop_while_livekit_is_queried
        mock_start.return_value = "EG_zombie"

        response = self.heartbeat()

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["data"]["restarted"])
        mock_start.assert_not_called()
        mock_stop.assert_not_called()
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_STOPPED)
        self.assertEqual(self.session.livekit_egress_id, "")

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_stop_while_the_new_egress_starts_stops_the_new_egress(self, mock_status, mock_start, mock_stop):
        mock_status.return_value = {"running": False, "status": "EGRESS_ABORTED", "error": ""}

        def host_presses_stop_while_livekit_starts_egress(**kwargs):
            self.stop_in_db()
            return "EG_new"

        mock_start.side_effect = host_presses_stop_while_livekit_starts_egress

        response = self.heartbeat()

        self.assertFalse(response.data["data"]["restarted"])
        self.assertEqual(response.data["data"]["session"]["stream_status"], RealtimeSession.STREAM_STOPPED)
        stopped = [call.kwargs.get("egress_id") for call in mock_stop.call_args_list]
        self.assertEqual(stopped, ["EG_1", "EG_new"])
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_STOPPED)
        self.assertEqual(self.session.livekit_egress_id, "")

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_session_ended_during_restart_does_not_go_back_on_air(self, mock_status, mock_start, mock_stop):
        mock_status.return_value = {"running": False, "status": "EGRESS_ABORTED", "error": ""}

        def class_ended_while_livekit_starts_egress(**kwargs):
            RealtimeSession.objects.filter(pk=self.session.pk).update(status=RealtimeSession.STATUS_ENDED)
            return "EG_new"

        mock_start.side_effect = class_ended_while_livekit_starts_egress

        self.heartbeat()

        self.assertIn("EG_new", [call.kwargs.get("egress_id") for call in mock_stop.call_args_list])
        self.session.refresh_from_db()
        self.assertEqual(self.session.livekit_egress_id, "EG_1")

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_restart_already_done_by_another_heartbeat_is_not_duplicated(self, mock_status, mock_start, mock_stop):
        def other_tab_already_restarted(**kwargs):
            # Another heartbeat finished its restart (EG_2) while this one asked LiveKit about EG_1.
            RealtimeSession.objects.filter(pk=self.session.pk).update(livekit_egress_id="EG_2")
            return {"running": False, "status": "EGRESS_ABORTED", "error": ""}

        mock_status.side_effect = other_tab_already_restarted
        mock_start.return_value = "EG_3"

        response = self.heartbeat()

        self.assertFalse(response.data["data"]["restarted"])
        mock_start.assert_not_called()
        self.assertNotIn("EG_2", [call.kwargs.get("egress_id") for call in mock_stop.call_args_list])
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertEqual(self.session.livekit_egress_id, "EG_2")

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_two_concurrent_restarters_leave_exactly_one_egress(self, mock_status, mock_start, mock_stop):
        """The loser of the final compare-and-set stops the egress it started."""
        mock_status.return_value = {"running": False, "status": "EGRESS_ABORTED", "error": ""}

        def other_restarter_won_while_this_one_started(**kwargs):
            RealtimeSession.objects.filter(pk=self.session.pk).update(livekit_egress_id="EG_2")
            return "EG_3"

        mock_start.side_effect = other_restarter_won_while_this_one_started

        response = self.heartbeat()

        self.assertFalse(response.data["data"]["restarted"])
        self.assertEqual(mock_start.call_count, 1)
        stopped = [call.kwargs.get("egress_id") for call in mock_stop.call_args_list]
        self.assertIn("EG_3", stopped)
        self.assertNotIn("EG_2", stopped)
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_LIVE)
        self.assertEqual(self.session.livekit_egress_id, "EG_2")
        self.assertIsNone(cache.get(f"realtime:host-egress:{self.session.id}:lock"))

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    @patch("apps.realtime.views.get_broadcast_egress_status")
    def test_not_publishing_heartbeat_does_not_mark_a_stopped_stream_failed(self, mock_status, mock_start, mock_stop):
        def host_presses_stop_while_livekit_is_queried(**kwargs):
            self.stop_in_db()
            return {"running": False, "status": "EGRESS_COMPLETE", "error": ""}

        mock_status.side_effect = host_presses_stop_while_livekit_is_queried

        self.heartbeat(publishing=False)

        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_STOPPED)
        self.assertEqual(self.session.livekit_egress_error, "")

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    @patch("apps.realtime.views.start_room_broadcast_egress")
    def test_stop_during_start_live_stops_the_new_egress_and_answers_409(self, mock_start, mock_stop):
        session = self.make_session(stream_status=RealtimeSession.STREAM_STOPPED)

        def stop_pressed_while_starting(**kwargs):
            RealtimeSession.objects.filter(pk=session.pk).update(stream_status=RealtimeSession.STREAM_STOPPED)
            return "EG_new"

        mock_start.side_effect = stop_pressed_while_starting

        response = self.client.post(
            reverse("realtime-session-stream-start", kwargs={"pk": session.id}), {}, format="json"
        )

        self.assertEqual(response.status_code, 409)
        mock_stop.assert_called_once_with(egress_id="EG_new")
        session.refresh_from_db()
        self.assertEqual(session.stream_status, RealtimeSession.STREAM_STOPPED)
        self.assertEqual(session.livekit_egress_id, "")

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    def test_stop_stops_the_egress_recorded_under_the_row_lock(self, mock_stop):
        # The first read is stale (EG_1); a restart committed EG_2 before Stop took the row lock.
        stale = RealtimeSession.objects.get(pk=self.session.pk)
        RealtimeSession.objects.filter(pk=self.session.pk).update(livekit_egress_id="EG_2")
        with patch("apps.realtime.views.get_object_or_404", return_value=stale):
            response = self.client.post(
                reverse("realtime-session-stream-stop", kwargs={"pk": self.session.id}), {}, format="json"
            )

        self.assertEqual(response.status_code, 200)
        mock_stop.assert_called_once_with(egress_id="EG_2")
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_STOPPED)
        self.assertEqual(self.session.livekit_egress_id, "")

    @patch("apps.realtime.views.stop_room_broadcast_egress")
    def test_stop_failure_keeps_the_egress_id_for_a_retry(self, mock_stop):
        mock_stop.side_effect = realtime_services.LiveKitEgressError("twirp timeout")

        response = self.client.post(
            reverse("realtime-session-stream-stop", kwargs={"pk": self.session.id}), {}, format="json"
        )

        self.assertEqual(response.status_code, 400)
        self.session.refresh_from_db()
        self.assertEqual(self.session.stream_status, RealtimeSession.STREAM_FAILED)
        self.assertEqual(self.session.livekit_egress_id, "EG_1")
        self.assertIn("twirp timeout", self.session.livekit_egress_error)
