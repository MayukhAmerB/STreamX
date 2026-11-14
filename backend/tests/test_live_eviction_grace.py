"""A device evicted mid-class finishes the class, then is signed out (Phase 2, D5).

Owner decision: when a newer sign-in evicts a student's device while it is in
a live class (OBS player, Host Studio viewer or meeting), that device keeps
the class with a banner, no logout and no modal, and is signed out only after
the class ends, with a clear message.
"""

from datetime import timedelta
from unittest.mock import patch

from django.core.cache import cache
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.realtime.models import RealtimeSession
from apps.users.live_grace import LIVE_CLASS_ENDED_REASON, LIVE_GRACE_HEADER, LIVE_GRACE_STATE
from apps.users.models import SessionSlot, SessionSlotLiveGrace, User
from apps.users.session_policy import SESSION_SLOT_CLAIM
from tests.test_api import mark_terms_accepted


PASSWORD = "StrongPass@123"
HEALTH = {"stream_status": "live", "online": True, "changed": False}


def claims_of(raw_token):
    return RefreshToken(raw_token, verify=False).payload


@override_settings(
    MAX_CONCURRENT_SESSIONS_PER_STUDENT=2,
    OWNCAST_BASE_URL="http://owncast:8080",
    OWNCAST_ADMIN_API_BASE_URL="",
    OWNCAST_RTMP_TARGET="rtmp://owncast:1935/live/default-key",
    LIVEKIT_URL="ws://livekit.test",
    LIVEKIT_API_KEY="devkey",
    LIVEKIT_API_SECRET="secret",
)
@patch("apps.realtime.views.get_room_participant_count", return_value=3)
@patch("apps.realtime.views.build_participant_token", return_value="lk.token")
@patch("apps.realtime.views.refresh_obs_session_stream_health", return_value=HEALTH)
class EvictedDeviceFinishesLiveClassTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.student = User.objects.create_user(
            email="grace-student@test.com", full_name="Grace Student", password=PASSWORD, role=User.ROLE_STUDENT
        )
        self.host = User.objects.create_user(
            email="grace-host@test.com", full_name="Grace Host", password=PASSWORD, role=User.ROLE_INSTRUCTOR
        )
        mark_terms_accepted(self.student, self.host)

    # --- helpers -----------------------------------------------------------

    def make_session(self, **overrides):
        values = {
            "title": "Evening class",
            "description": "Live class under test",
            "host": self.host,
            "session_type": RealtimeSession.TYPE_BROADCASTING,
            "stream_service": RealtimeSession.STREAM_SERVICE_OBS,
            "stream_status": RealtimeSession.STREAM_LIVE,
            "stream_embed_url": "https://stream.example.com/embed/video",
            "chat_embed_url": "https://stream.example.com/embed/chat/readwrite",
            "status": RealtimeSession.STATUS_LIVE,
            "started_at": timezone.now(),
        }
        values.update(overrides)
        return RealtimeSession.objects.create(**values)

    def sign_in(self):
        client = self.client_class()
        response = client.post(reverse("auth-login"), {"email": self.student.email, "password": PASSWORD}, format="json")
        self.assertEqual(response.status_code, 200)
        return client

    def slot_of(self, client):
        return claims_of(client.cookies["refresh_token"].value)[SESSION_SLOT_CLAIM]

    def join(self, client, session):
        return client.post(
            reverse("realtime-session-join", kwargs={"pk": session.pk}),
            {"display_name": "Grace Student", "prefer_broadcast": session.session_type == RealtimeSession.TYPE_BROADCASTING},
            format="json",
        )

    def detail(self, client, session):
        return client.get(reverse("realtime-session-detail", kwargs={"pk": session.pk}))

    def refresh(self, client):
        # Past the reuse window, so the refresh really rotates the token.
        OutstandingToken.objects.filter(jti=claims_of(client.cookies["refresh_token"].value)["jti"]).update(
            created_at=timezone.now() - timedelta(minutes=30)
        )
        return client.post(reverse("auth-refresh"), {}, format="json")

    def evict_while_watching(self, session):
        """Device A joins ``session``; two newer sign-ins evict it."""
        device_a = self.sign_in()
        self.assertEqual(self.join(device_a, session).status_code, 200)
        SessionSlot.objects.filter(slot_id=self.slot_of(device_a)).update(
            last_seen_at=timezone.now() - timedelta(hours=1)
        )
        device_b = self.sign_in()
        device_c = self.sign_in()
        self.assertFalse(SessionSlot.objects.filter(slot_id=self.slot_of(device_a)).exists())
        return device_a, device_b, device_c

    def assert_live_grace(self, response):
        self.assertEqual(response.get(LIVE_GRACE_HEADER), LIVE_GRACE_STATE)

    # --- tests -------------------------------------------------------------

    def test_evicted_device_keeps_every_request_of_its_class(self, *_mocks):
        session = self.make_session()
        device_a, device_b, device_c = self.evict_while_watching(session)

        grace = SessionSlotLiveGrace.objects.get(slot_id=self.slot_of(device_a))
        self.assertEqual(grace.session_id, session.pk)
        # The grace never counts against the cap: B and C hold both slots.
        self.assertEqual(SessionSlot.objects.filter(user=self.student).count(), 2)
        for client in (device_b, device_c):
            self.assertEqual(client.get(reverse("auth-user")).status_code, 200)

        detail = self.detail(device_a, session)
        self.assertEqual(detail.status_code, 200)
        self.assert_live_grace(detail)
        rejoin = self.join(device_a, session)
        self.assertEqual(rejoin.status_code, 200, rejoin.content)
        self.assertEqual(rejoin.data["data"]["mode"], "broadcast")
        self.assert_live_grace(rejoin)
        stream = device_a.post(reverse("realtime-session-owncast-stream-launch", kwargs={"pk": session.pk}))
        self.assertEqual(stream.status_code, 200, stream.content)
        self.assert_live_grace(stream)
        sessions = device_a.get(reverse("realtime-session-list-create"))
        self.assertEqual(sessions.status_code, 200)
        me = device_a.get(reverse("auth-user"))
        self.assertEqual(me.status_code, 200)
        self.assert_live_grace(me)
        event = device_a.post(
            reverse("realtime-session-connection-event", kwargs={"pk": session.pk}),
            {"event": "reconnected", "mode": "broadcast"},
            format="json",
        )
        self.assertNotIn(event.status_code, (401, 403), event.content)
        # The device that is active is never flagged.
        self.assertIsNone(self.detail(device_b, session).get(LIVE_GRACE_HEADER))

    def test_evicted_device_is_refused_everything_else_and_told_why(self, *_mocks):
        session = self.make_session()
        other_class = self.make_session(title="Another live class")
        device_a, _b, _c = self.evict_while_watching(session)

        profile = device_a.get(reverse("auth-profile"))
        self.assertEqual(profile.status_code, 401)
        self.assert_live_grace(profile)
        # The grace is bound to the class the device was in.
        other = self.detail(device_a, other_class)
        self.assertEqual(other.status_code, 401)
        self.assertEqual(self.join(device_a, other_class).status_code, 401)
        end = device_a.post(reverse("realtime-session-end", kwargs={"pk": session.pk}))
        self.assertEqual(end.status_code, 401)
        self.assertEqual(RealtimeSession.objects.get(pk=session.pk).status, RealtimeSession.STATUS_LIVE)

    def test_class_keeps_playing_through_a_token_refresh(self, *_mocks):
        session = self.make_session()
        device_a, _b, _c = self.evict_while_watching(session)
        slot_id = self.slot_of(device_a)
        old_refresh = device_a.cookies["refresh_token"].value

        refreshed = self.refresh(device_a)

        self.assertEqual(refreshed.status_code, 200, refreshed.content)
        self.assert_live_grace(refreshed)
        self.assertNotEqual(device_a.cookies["refresh_token"].value, old_refresh)
        self.assertEqual(self.slot_of(device_a), slot_id)
        self.assertEqual(self.detail(device_a, session).status_code, 200)
        self.assertEqual(self.refresh(device_a).status_code, 200)
        self.assertEqual(self.join(device_a, session).status_code, 200)

    def test_device_is_signed_out_when_the_class_ends(self, *_mocks):
        session = self.make_session()
        device_a, device_b, _c = self.evict_while_watching(session)
        session.status = RealtimeSession.STATUS_ENDED
        session.ended_at = timezone.now()
        session.save(update_fields=["status", "ended_at"])

        poll = self.detail(device_a, session)
        self.assertEqual(poll.status_code, 401)
        self.assertIsNone(poll.get(LIVE_GRACE_HEADER))

        rejected = self.refresh(device_a)
        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(rejected.data["errors"]["code"], "session_replaced")
        self.assertEqual(rejected.data["errors"]["reason"], LIVE_CLASS_ENDED_REASON)
        self.assertIn("class has ended", rejected.data["errors"]["detail"])
        self.assertEqual(rejected.cookies["refresh_token"]["max-age"], 0)
        self.assertEqual(rejected.cookies["access_token"]["max-age"], 0)
        # The active devices are untouched.
        self.assertEqual(device_b.get(reverse("auth-user")).status_code, 200)

    def test_abandoned_class_ends_the_grace(self, *_mocks):
        session = self.make_session()
        device_a, _b, _c = self.evict_while_watching(session)
        RealtimeSession.objects.filter(pk=session.pk).update(started_at=timezone.now() - timedelta(hours=48))

        rejected = self.refresh(device_a)

        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(rejected.data["errors"]["reason"], LIVE_CLASS_ENDED_REASON)

    def test_meeting_device_rejoins_after_eviction(self, *_mocks):
        meeting = self.make_session(
            session_type=RealtimeSession.TYPE_MEETING,
            stream_service=RealtimeSession.STREAM_SERVICE_ALSYED,
            stream_status=RealtimeSession.STREAM_IDLE,
            stream_embed_url="",
            chat_embed_url="",
        )
        device_a, _b, _c = self.evict_while_watching(meeting)

        rejoin = self.join(device_a, meeting)

        self.assertEqual(rejoin.status_code, 200, rejoin.content)
        self.assertEqual(rejoin.data["data"]["mode"], "meeting")
        self.assert_live_grace(rejoin)

    def test_device_not_in_a_class_is_signed_out_at_once(self, *_mocks):
        device_a = self.sign_in()
        SessionSlot.objects.filter(slot_id=self.slot_of(device_a)).update(
            last_seen_at=timezone.now() - timedelta(hours=1)
        )
        self.sign_in()
        self.sign_in()

        self.assertFalse(SessionSlotLiveGrace.objects.exists())
        rejected = self.refresh(device_a)
        self.assertEqual(rejected.status_code, 401)
        self.assertEqual(rejected.data["errors"]["code"], "session_replaced")
        self.assertNotIn("reason", rejected.data["errors"])

    def test_class_that_already_ended_gives_no_grace(self, *_mocks):
        session = self.make_session()
        device_a = self.sign_in()
        self.assertEqual(self.join(device_a, session).status_code, 200)
        RealtimeSession.objects.filter(pk=session.pk).update(status=RealtimeSession.STATUS_ENDED)
        SessionSlot.objects.filter(slot_id=self.slot_of(device_a)).update(
            last_seen_at=timezone.now() - timedelta(hours=1)
        )
        self.sign_in()
        self.sign_in()

        self.assertFalse(SessionSlotLiveGrace.objects.exists())
        self.assertEqual(self.refresh(device_a).status_code, 401)

    def test_sign_out_on_the_evicted_device_ends_its_grace(self, *_mocks):
        session = self.make_session()
        device_a, _b, _c = self.evict_while_watching(session)

        self.assertEqual(device_a.post(reverse("auth-logout"), {}, format="json").status_code, 200)

        self.assertFalse(SessionSlotLiveGrace.objects.filter(user=self.student).exists())

    def test_password_change_style_sign_out_everywhere_ends_the_grace(self, *_mocks):
        from apps.users.session_policy import release_all_session_slots

        session = self.make_session()
        device_a, _b, _c = self.evict_while_watching(session)

        release_all_session_slots(self.student)

        self.assertEqual(self.detail(device_a, session).status_code, 401)
        self.assertEqual(self.refresh(device_a).status_code, 401)
