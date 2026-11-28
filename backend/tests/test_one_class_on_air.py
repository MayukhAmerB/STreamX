"""One broadcast class on air: Batch III and Batch IV share one Owncast feed.

Every broadcast class streams through the same Owncast instance with the same
fixed OBS key, so what keeps the batches apart is which class is live. These
tests pin that down: starting a class ends the batch that was live before it,
the stream gate admits only viewers of the class on air (and of its batch),
an ended class is cut off at once, and the next batch gets a clean chat.
"""

from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.core import signing
from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.core.models import OutboxEvent
from apps.courses.models import Course, Enrollment, LiveClass
from apps.realtime import lifecycle
from apps.realtime.models import RealtimeSession
from apps.users.models import User

OBS_SETTINGS = {
    "OWNCAST_RTMP_TARGET": "rtmp://owncast:1935/live/default-key",
    "OWNCAST_OBS_STREAM_SERVER_URL": "rtmp://obs.example.com:1935/live",
}


def _obs_health_live(session, **kwargs):
    session.mark_stream_live("")
    return {"stream_status": RealtimeSession.STREAM_LIVE, "online": True, "changed": True}


class OneClassOnAirTests(APITestCase):
    def setUp(self):
        self.addCleanup(cache.clear)
        cache.clear()
        self.host = User.objects.create_user(
            email="host@example.com", password="StrongPass@123", role=User.ROLE_INSTRUCTOR
        )
        self.batches = {}
        for name in ("III", "IV"):
            course = Course.objects.create(
                title=f"OSINT Batch {name}",
                description=f"Batch {name} course.",
                price=Decimal("999.00"),
                instructor=self.host,
                is_published=True,
            )
            live_class = LiveClass.objects.create(
                title=f"OSINT Batch {name} live",
                description=f"Batch {name} live classes.",
                level=LiveClass.LEVEL_BEGINNER,
                month_number=1,
                is_active=True,
                linked_course=course,
            )
            student = User.objects.create_user(
                email=f"batch{name.lower()}@example.com", password="StrongPass@123", role=User.ROLE_STUDENT
            )
            Enrollment.objects.create(user=student, course=course, payment_status=Enrollment.STATUS_PAID)
            self.batches[name] = {"course": course, "live_class": live_class, "student": student}

    def make_class(self, batch, *, status=RealtimeSession.STATUS_SCHEDULED, started_minutes_ago=None, **extra):
        fields = {
            "title": f"OSINT Batch {batch} · Saturday",
            "description": "Class",
            "host": self.host,
            "session_type": RealtimeSession.TYPE_BROADCASTING,
            "stream_service": RealtimeSession.STREAM_SERVICE_OBS,
            "status": status,
            "linked_course": self.batches[batch]["course"],
            "linked_live_class": self.batches[batch]["live_class"],
        }
        if started_minutes_ago is not None:
            fields["started_at"] = timezone.now() - timedelta(minutes=started_minutes_ago)
        fields.update(extra)
        return RealtimeSession.objects.create(**fields)

    def gate(self, session, user):
        cookie = signing.dumps(
            {"session_id": session.pk, "user_id": user.pk, "issued_at": 0},
            salt="realtime.owncast-stream-access",
            compress=True,
        )
        self.client.cookies["owncast_stream_access"] = cookie
        return self.client.get(reverse("realtime-owncast-stream-access")).status_code

    @override_settings(**OBS_SETTINGS)
    @patch("apps.realtime.views.refresh_obs_session_stream_health", side_effect=_obs_health_live)
    @patch("apps.realtime.views.sync_owncast_stream_key", return_value={"success": True})
    def test_starting_batch_iv_ends_batch_iii_still_live(self, _sync, _health):
        batch3 = self.make_class(
            "III", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=60,
            stream_status=RealtimeSession.STREAM_LIVE,
        )
        batch4 = self.make_class("IV")
        self.client.force_authenticate(user=self.host)

        response = self.client.post(reverse("realtime-session-stream-start", kwargs={"pk": batch4.pk}), {}, format="json")

        self.assertEqual(response.status_code, 200, response.content)
        batch3.refresh_from_db()
        batch4.refresh_from_db()
        self.assertEqual(batch3.status, RealtimeSession.STATUS_ENDED)
        self.assertEqual(batch3.end_reason, lifecycle.END_REASON_SUPERSEDED)
        self.assertEqual(batch4.status, RealtimeSession.STATUS_LIVE)
        self.assertIn(f"Ended '{batch3.title}'", response.json()["message"])

    @override_settings(**OBS_SETTINGS)
    @patch("apps.realtime.views.refresh_obs_session_stream_health", side_effect=_obs_health_live)
    @patch("apps.realtime.views.sync_owncast_stream_key", return_value={"success": True})
    def test_re_preparing_the_class_on_air_ends_nothing(self, _sync, _health):
        batch4 = self.make_class("IV", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=5)
        other_meeting = self.make_class(
            "III", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=10,
            session_type=RealtimeSession.TYPE_MEETING,
        )
        self.client.force_authenticate(user=self.host)

        response = self.client.post(reverse("realtime-session-stream-start", kwargs={"pk": batch4.pk}), {}, format="json")

        self.assertEqual(response.status_code, 200, response.content)
        other_meeting.refresh_from_db()
        self.assertEqual(other_meeting.status, RealtimeSession.STATUS_LIVE)
        self.assertNotIn("Ended", response.json()["message"])

    def test_meetings_are_never_superseded(self):
        meeting = self.make_class(
            "III", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=10,
            session_type=RealtimeSession.TYPE_MEETING,
        )
        batch4 = self.make_class("IV")

        self.assertTrue(lifecycle.open_session_for_start(batch4))

        meeting.refresh_from_db()
        self.assertEqual(meeting.status, RealtimeSession.STATUS_LIVE)
        self.assertEqual(batch4.superseded_sessions, [])

    def test_gate_admits_only_the_batch_of_the_class_on_air(self):
        batch4 = self.make_class("IV", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=1)

        self.assertEqual(self.gate(batch4, self.batches["IV"]["student"]), 204)
        self.assertEqual(self.gate(batch4, self.batches["III"]["student"]), 403)

    def test_gate_refuses_an_older_class_still_marked_live(self):
        # Batch III was never ended; Batch IV went live after it.
        batch3 = self.make_class("III", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=70)
        batch4 = self.make_class("IV", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=5)

        self.assertEqual(self.gate(batch3, self.batches["III"]["student"]), 403)
        self.assertEqual(self.gate(batch4, self.batches["IV"]["student"]), 204)

    def test_ended_class_is_cut_off_despite_the_auth_cache(self):
        batch3 = self.make_class("III", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=50)
        student = self.batches["III"]["student"]
        self.assertEqual(self.gate(batch3, student), 204)
        self.assertEqual(self.gate(batch3, student), 204)  # served from the auth cache

        lifecycle.end_session(batch3.pk, reason=lifecycle.END_REASON_HOST)

        self.assertEqual(self.gate(batch3, student), 401)

    @override_settings(OWNCAST_ADMIN_PASSWORD="secret")
    def test_next_batch_gets_a_clean_chat(self):
        batch3 = self.make_class("III", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=60)
        lifecycle.end_session(batch3.pk, reason=lifecycle.END_REASON_HOST)
        batch3.refresh_from_db()
        batch4 = self.make_class("IV")

        lifecycle.open_session_for_start(batch4)

        event = OutboxEvent.objects.get(event_type=lifecycle.EVENT_CHAT_RESET)
        self.assertEqual(event.payload["session_id"], batch4.pk)
        ended = batch3.ended_at
        messages = [
            {"id": "b3-chat", "visible": True, "timestamp": (ended - timedelta(minutes=10)).isoformat()},
            {"id": "b3-hidden", "visible": False, "timestamp": (ended - timedelta(minutes=9)).isoformat()},
            {"id": "b4-waiting", "visible": True, "timestamp": (ended + timedelta(seconds=30)).isoformat()},
            {"id": "ancient", "visible": True, "timestamp": (ended - timedelta(days=3)).isoformat()},
        ]
        with patch("apps.realtime.services._resolve_owncast_admin_request_context", return_value=("http://owncast", {})), \
                patch("apps.realtime.services.fetch_owncast_chat_messages_admin", return_value=messages), \
                patch("apps.realtime.services._owncast_admin_post_json") as mock_post:
            result = lifecycle.handle_chat_reset(event)

        self.assertEqual(result["hidden"], 1)
        mock_post.assert_called_once()
        self.assertEqual(mock_post.call_args.kwargs["payload"], {"idArray": ["b3-chat"], "visible": False})

    def test_no_chat_reset_without_owncast_admin(self):
        batch3 = self.make_class("III", status=RealtimeSession.STATUS_LIVE, started_minutes_ago=60)
        lifecycle.end_session(batch3.pk, reason=lifecycle.END_REASON_HOST)

        with self.settings(OWNCAST_ADMIN_PASSWORD=""):
            lifecycle.open_session_for_start(self.make_class("IV"))

        self.assertFalse(OutboxEvent.objects.filter(event_type=lifecycle.EVENT_CHAT_RESET).exists())
