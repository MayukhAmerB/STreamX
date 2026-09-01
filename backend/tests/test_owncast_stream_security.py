from decimal import Decimal

from django.test import override_settings
from django.urls import reverse
from django.core import signing
from rest_framework.test import APITestCase

from apps.courses.models import Course, LiveClass
from apps.realtime.models import OwncastChatIdentity, RealtimeSession
from apps.users.models import User


@override_settings(OWNCAST_CHAT_BRIDGE_ENABLED=True)
class OwncastStreamSecurityTests(APITestCase):
    def setUp(self):
        self.host = User.objects.create_user(
            email="host@example.com",
            password="StrongPass@123",
            role=User.ROLE_INSTRUCTOR,
        )
        self.viewer = User.objects.create_user(
            email="viewer@example.com",
            password="StrongPass@123",
            role=User.ROLE_STUDENT,
        )
        self.course = Course.objects.create(
            title="Protected Course",
            description="Course used to gate protected broadcast chat.",
            price=Decimal("999.00"),
            instructor=self.host,
            is_published=True,
        )
        self.live_class = LiveClass.objects.create(
            title="Protected Live Class",
            description="Live class used to gate protected broadcast chat.",
            level=LiveClass.LEVEL_BEGINNER,
            month_number=1,
            is_active=True,
            linked_course=self.course,
        )

    def test_authorized_chat_bridge_sets_stream_access_cookie(self):
        session = RealtimeSession.objects.create(
            title="Chat Cookie Session",
            description="Authorized chat must pass the stream-host gateway.",
            host=self.host,
            session_type=RealtimeSession.TYPE_BROADCASTING,
            linked_live_class=self.live_class,
            linked_course=self.course,
            status=RealtimeSession.STATUS_LIVE,
            chat_enabled=True,
        )
        identity = OwncastChatIdentity.objects.create(
            session=session,
            user=self.viewer,
            platform_user_id=self.viewer.id,
            platform_email=self.viewer.email,
            owncast_display_name="Viewer User",
            access_token_hash=OwncastChatIdentity.hash_access_token("chat-access-token"),
        )
        token = signing.dumps(
            {
                "session_id": session.id,
                "user_id": self.viewer.id,
                "identity_id": identity.id,
                "access_token": "chat-access-token",
                "next_path": "/embed/chat/readwrite/",
            },
            salt="realtime.owncast-chat-bridge",
            compress=True,
        )

        response = self.client.get(
            reverse("realtime-owncast-chat-bridge"),
            {"token": token},
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn("owncast_stream_access", response.cookies)
        cookie = response.cookies["owncast_stream_access"]
        self.assertIn("HttpOnly", cookie.OutputString())
        self.assertEqual(cookie["path"], "/")
