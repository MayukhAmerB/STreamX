import hashlib
import hmac
import json
from unittest.mock import patch

from django.core import mail
from django.test import override_settings
from django.urls import reverse
from rest_framework.test import APITestCase

from apps.users.async_jobs import run_pending_jobs
from apps.users.models import AsyncJob


class MetricsEndpointTests(APITestCase):
    def test_metrics_endpoint_returns_payload_when_unprotected(self):
        response = self.client.get(reverse("metrics"))
        self.assertIn(response.status_code, (200, 503))
        body = response.content.decode("utf-8")
        if response.status_code == 200:
            self.assertIn("streamx_http_requests_total", body)
        else:
            self.assertIn("prometheus_client is not installed", body)

    @override_settings(METRICS_AUTH_TOKEN="metrics-secret")
    def test_metrics_endpoint_requires_token(self):
        denied = self.client.get(reverse("metrics"))
        self.assertEqual(denied.status_code, 403)

        allowed_header = self.client.get(
            reverse("metrics"),
            HTTP_X_METRICS_TOKEN="metrics-secret",
        )
        self.assertIn(allowed_header.status_code, (200, 503))

        allowed_bearer = self.client.get(
            reverse("metrics"),
            HTTP_AUTHORIZATION="Bearer metrics-secret",
        )
        self.assertIn(allowed_bearer.status_code, (200, 503))

    @override_settings(DEBUG=False, METRICS_AUTH_TOKEN="")
    def test_metrics_endpoint_blocks_public_requests_when_token_missing(self):
        denied = self.client.get(
            reverse("metrics"),
            REMOTE_ADDR="8.8.8.8",
            HTTP_X_FORWARDED_FOR="8.8.8.8",
        )
        self.assertEqual(denied.status_code, 403)


@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    DEFAULT_FROM_EMAIL="noreply@test.com",
    CONTACT_RECEIVER_EMAIL="contact@test.com",
    ASYNC_JOBS_ENABLED=True,
    ASYNC_EMAIL_MAX_ATTEMPTS=3,
)
class AsyncEmailQueueTests(APITestCase):
    def test_contact_message_enqueues_email_and_worker_sends_it(self):
        response = self.client.post(
            reverse("auth-contact"),
            {
                "name": "Visitor",
                "email": "visitor@test.com",
                "subject": "Need help",
                "message": "Please share details.",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(AsyncJob.objects.filter(job_type=AsyncJob.TYPE_EMAIL_SEND).count(), 1)
        self.assertEqual(len(mail.outbox), 0)

        stats = run_pending_jobs(batch_size=10)
        self.assertEqual(stats["succeeded"], 1)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("[Contact] Need help", mail.outbox[0].subject)


@override_settings(
    RAZORPAY_WEBHOOK_SECRET="test_webhook_secret",
    ASYNC_JOBS_ENABLED=True,
    ASYNC_WEBHOOK_RETRY_MAX_ATTEMPTS=4,
)
class WebhookRetryQueueTests(APITestCase):
    def _build_signature(self, body):
        return hmac.new(
            b"test_webhook_secret",
            msg=body,
            digestmod=hashlib.sha256,
        ).hexdigest()

    def test_payment_webhook_failure_gets_queued_for_retry(self):
        payload = {
            "event": "payment.captured",
            "payload": {
                "payment": {
                    "entity": {
                        "id": "pay_test",
                        "order_id": "order_test",
                        "status": "captured",
                        "amount": 10000,
                    }
                }
            },
        }
        body = json.dumps(payload).encode("utf-8")
        signature = self._build_signature(body)

        with patch(
            "apps.payments.views.process_payment_webhook_payload",
            side_effect=RuntimeError("transient failure"),
        ):
            response = self.client.post(
                reverse("payment-webhook"),
                data=body,
                content_type="application/json",
                HTTP_X_RAZORPAY_SIGNATURE=signature,
            )

        self.assertEqual(response.status_code, 202)
        self.assertTrue(response.data["data"]["queued"])
        job = AsyncJob.objects.get(job_type=AsyncJob.TYPE_PAYMENT_WEBHOOK_RETRY)
        self.assertEqual(job.status, AsyncJob.STATUS_PENDING)

        with patch(
            "apps.payments.views.process_payment_webhook_payload",
            return_value={
                "success": True,
                "status_code": 200,
                "message": "Webhook processed.",
                "data": {"processed": True, "payment_id": 1, "status": "paid"},
            },
        ):
            stats = run_pending_jobs(batch_size=10)
        self.assertEqual(stats["succeeded"], 1)
        job.refresh_from_db()
        self.assertEqual(job.status, AsyncJob.STATUS_SUCCEEDED)
