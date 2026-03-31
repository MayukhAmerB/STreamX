from django.conf import settings
from django.test import TestCase
from django.urls import reverse


class HealthEndpointTests(TestCase):
    def test_liveness_endpoint_returns_ok(self):
        response = self.client.get(reverse("health-live"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_readiness_endpoint_returns_ok_for_default_local_stack(self):
        response = self.client.get(reverse("health-ready"))
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertIn("database", body["checks"])

    def test_request_id_header_is_always_attached(self):
        response = self.client.get(reverse("health-live"))
        self.assertTrue(response.has_header("X-Request-ID"))
        self.assertGreaterEqual(len(response["X-Request-ID"]), 8)


class MediaUploadPermissionSettingsTests(TestCase):
    def test_local_upload_permissions_are_explicitly_configured(self):
        self.assertEqual(settings.FILE_UPLOAD_PERMISSIONS, 0o644)
        self.assertEqual(settings.FILE_UPLOAD_DIRECTORY_PERMISSIONS, 0o755)
