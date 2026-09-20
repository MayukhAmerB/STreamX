from decimal import Decimal
from unittest.mock import patch

from django.urls import reverse
from rest_framework.test import APITestCase

from apps.courses.models import Course
from apps.realtime.models import RealtimeSession
from apps.users.models import User


class RealtimeConnectionTelemetryTests(APITestCase):
    def setUp(self):
        self.host = User.objects.create_user(
            email="telemetry-host@example.com",
            password="StrongPass@123",
            role=User.ROLE_INSTRUCTOR,
        )
        self.viewer = User.objects.create_user(
            email="telemetry-viewer@example.com",
            password="StrongPass@123",
            role=User.ROLE_STUDENT,
        )
        self.course = Course.objects.create(
            title="Telemetry Course",
            description="Course used to authorize realtime diagnostics.",
            price=Decimal("999.00"),
            instructor=self.host,
            is_published=True,
        )
        self.session = RealtimeSession.objects.create(
            title="Telemetry Session",
            description="Meeting connection diagnostics.",
            host=self.host,
            linked_course=self.course,
            session_type=RealtimeSession.TYPE_MEETING,
            status=RealtimeSession.STATUS_LIVE,
        )
        self.url = reverse("realtime-session-connection-event", args=[self.session.id])

    @patch("apps.realtime.views.record_realtime_connection_event")
    def test_authorized_participant_can_report_bounded_event(self, record_event):
        self.client.force_authenticate(user=self.host)

        response = self.client.post(
            self.url,
            {
                "event": "disconnected",
                "reason": "signal_close",
                "transport": "auto",
                "network": "4g",
                "platform": "mobile",
                "quality": "lost",
                "retry_attempt": 2,
                "elapsed_ms": 45000,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 204)
        record_event.assert_called_once_with(
            event="disconnected",
            reason="signal_close",
            transport="auto",
            network="4g",
            platform="mobile",
            quality="lost",
        )

    def test_telemetry_rejects_unbounded_labels(self):
        self.client.force_authenticate(user=self.host)

        response = self.client.post(
            self.url,
            {
                "event": "arbitrary-event-name",
                "reason": "raw browser error containing unbounded data",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)

    def test_telemetry_requires_session_access(self):
        self.client.force_authenticate(user=self.viewer)

        response = self.client.post(
            self.url,
            {"event": "connected"},
            format="json",
        )

        self.assertEqual(response.status_code, 403)

    def test_telemetry_requires_authentication(self):
        response = self.client.post(self.url, {"event": "connected"}, format="json")

        self.assertEqual(response.status_code, 401)
