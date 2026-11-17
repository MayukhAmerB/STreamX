"""Payments hardening pass: resilience, replay protection, refunds, reconciliation.

Razorpay is always mocked. Every test resets the shared ``razorpay`` circuit
breaker and the cache so state never leaks between tests.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import timedelta
from decimal import Decimal
from io import StringIO
from unittest.mock import MagicMock, patch

import requests
from apps import billing
from apps.billing.models import EntitlementGrant, Purchase
from apps.core import features
from apps.core.circuit import STATE_OPEN, get_breaker
from apps.core.models import OutboxEvent
from apps.courses.models import Course, Enrollment
from apps.payments import reconciliation, services
from apps.payments.models import (
    Payment,
    PaymentIdempotencyRecord,
    PaymentWebhookEvent,
    PlatformGrant,
)
from apps.payments.services import (
    RazorpayServiceError,
    RazorpayUnavailable,
    create_razorpay_order,
    create_razorpay_subscription,
    ensure_gateway_available,
    fetch_razorpay_order,
    fetch_razorpay_payment,
)
from django.core.cache import cache
from django.core.management import call_command
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from tests import factories as f
from tests.test_api import razorpay_created_order
from tests.test_billing import fake_order, make_plan
from tests.test_platform_plans import confirm_and_enable, seed_plans

KEYS = {
    "RAZORPAY_KEY_ID": "rzp_test_public",
    "RAZORPAY_KEY_SECRET": "test-secret",
    "RAZORPAY_WEBHOOK_SECRET": "whsec",
}


def reset_razorpay_breaker():
    get_breaker("razorpay").reset()


def open_razorpay_breaker():
    breaker = get_breaker("razorpay")
    breaker.cache.set(breaker._opened_key, timezone.now().timestamp(), timeout=600)  # noqa: SLF001
    assert breaker.state() == STATE_OPEN


def http_error(status_code):
    response = MagicMock()
    response.status_code = status_code
    return requests.HTTPError(f"{status_code} error", response=response)


def ok_response(payload):
    response = MagicMock()
    response.status_code = 200
    response.raise_for_status.return_value = None
    response.json.return_value = payload
    return response


def sign(body: bytes, secret: bytes = b"whsec") -> str:
    return hmac.new(secret, body, hashlib.sha256).hexdigest()


def checkout_signature(order_id, payment_id):
    return hmac.new(b"test-secret", f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()


class BreakerIsolationMixin:
    def setUp(self):
        super().setUp()
        cache.clear()
        reset_razorpay_breaker()
        self.addCleanup(reset_razorpay_breaker)
        self.addCleanup(cache.clear)
        sleeper = patch("apps.payments.services.time.sleep")
        self.sleep = sleeper.start()
        self.addCleanup(sleeper.stop)
        # Safety net: no test in this module may reach the real Razorpay API.
        network = patch.object(services._TimeoutSession, "request", side_effect=AssertionError("real Razorpay call"))  # noqa: SLF001
        network.start()
        self.addCleanup(network.stop)


# ---------------------------------------------------------------------------
# Razorpay client: timeouts, retries with backoff, circuit breaker
# ---------------------------------------------------------------------------
@override_settings(**KEYS, RAZORPAY_HTTP_TIMEOUT_SECONDS=7, RAZORPAY_HTTP_MAX_ATTEMPTS=3,
                   RAZORPAY_HTTP_RETRY_DEADLINE_SECONDS=60)
class RazorpayClientResilienceTests(BreakerIsolationMixin, SimpleTestCase):
    @patch("apps.payments.services._TimeoutSession")
    def test_get_is_retried_after_a_5xx_then_succeeds(self, session_class):
        request = session_class.return_value.request
        failing = MagicMock()
        failing.raise_for_status.side_effect = http_error(503)
        request.side_effect = [failing, ok_response({"id": "pay_1", "status": "captured"})]
        self.assertEqual(fetch_razorpay_payment(razorpay_payment_id="pay_1")["status"], "captured")
        self.assertEqual(request.call_count, 2)
        self.sleep.assert_called_once()
        self.assertLessEqual(self.sleep.call_args.args[0], 2.0)  # bounded, jittered backoff

    @patch("apps.payments.services._TimeoutSession")
    def test_get_gives_up_after_max_attempts_with_a_transient_error(self, session_class):
        session_class.return_value.request.side_effect = requests.ConnectionError("down")
        with self.assertRaises(RazorpayUnavailable) as ctx:
            fetch_razorpay_order(razorpay_order_id="order_1")
        self.assertEqual(session_class.return_value.request.call_count, 3)
        self.assertEqual(ctx.exception.reason, "connection_error")
        # The caller-specific message is kept and the type stays "transient".
        self.assertIn("Failed to confirm order status", str(ctx.exception))

    @override_settings(RAZORPAY_HTTP_RETRY_DEADLINE_SECONDS=5)
    @patch("apps.payments.services._TimeoutSession")
    def test_no_retry_is_started_that_cannot_finish_inside_the_deadline(self, session_class):
        # timeout 7s > deadline 5s: a timed-out call is never retried (the
        # payment worker would be killed by gunicorn at 30s otherwise).
        session_class.return_value.request.side_effect = requests.ReadTimeout("slow")
        with self.assertRaises(RazorpayUnavailable) as ctx:
            fetch_razorpay_payment(razorpay_payment_id="pay_slow")
        self.assertEqual(session_class.return_value.request.call_count, 1)
        self.assertEqual(ctx.exception.reason, "timeout")

    @patch("apps.payments.services._TimeoutSession")
    def test_client_errors_are_not_retried_and_never_trip_the_breaker(self, session_class):
        failing = MagicMock()
        failing.raise_for_status.side_effect = http_error(400)
        session_class.return_value.request.return_value = failing
        for _ in range(5):
            with self.assertRaises(RazorpayServiceError) as ctx:
                fetch_razorpay_payment(razorpay_payment_id="pay_bad")
            self.assertNotIsInstance(ctx.exception, RazorpayUnavailable)
        self.assertEqual(session_class.return_value.request.call_count, 5)
        self.assertNotEqual(get_breaker("razorpay").state(), STATE_OPEN)

    @patch("apps.payments.services._TimeoutSession")
    def test_order_creation_is_retried_on_5xx_because_an_orphan_order_is_harmless(self, session_class):
        failing = MagicMock()
        failing.raise_for_status.side_effect = http_error(502)
        session_class.return_value.request.side_effect = [failing, ok_response({"id": "order_ok"})]
        self.assertEqual(create_razorpay_order(amount_paise=100, receipt="r")["id"], "order_ok")
        self.assertEqual(session_class.return_value.request.call_count, 2)

    @patch("apps.payments.services._TimeoutSession")
    def test_subscription_creation_is_not_retried_after_the_request_may_have_been_sent(self, session_class):
        failing = MagicMock()
        failing.raise_for_status.side_effect = http_error(503)
        session_class.return_value.request.return_value = failing
        with self.assertRaises(RazorpayUnavailable):
            create_razorpay_subscription(plan_id="plan_ABC", total_count=12)
        self.assertEqual(session_class.return_value.request.call_count, 1)

    @patch("apps.payments.services._TimeoutSession")
    def test_any_call_is_retried_when_the_connection_never_opened(self, session_class):
        session_class.return_value.request.side_effect = [
            requests.ConnectTimeout("no route"),
            ok_response({"id": "sub_1", "entity": "subscription", "plan_id": "plan_ABC"}),
        ]
        self.assertEqual(create_razorpay_subscription(plan_id="plan_ABC", total_count=12)["id"], "sub_1")
        self.assertEqual(session_class.return_value.request.call_count, 2)

    @override_settings(RAZORPAY_HTTP_MAX_ATTEMPTS=1)
    @patch("apps.payments.services._TimeoutSession")
    def test_circuit_opens_after_repeated_outages_and_short_circuits(self, session_class):
        session_class.return_value.request.side_effect = requests.ConnectionError("down")
        for _ in range(3):  # CIRCUIT_BREAKERS["razorpay"]["failure_threshold"]
            with self.assertRaises(RazorpayUnavailable):
                fetch_razorpay_payment(razorpay_payment_id="pay_x")
        self.assertEqual(get_breaker("razorpay").state(), STATE_OPEN)
        session_class.return_value.request.reset_mock()
        with self.assertRaises(RazorpayUnavailable) as ctx:
            fetch_razorpay_payment(razorpay_payment_id="pay_x")
        self.assertEqual(ctx.exception.reason, "circuit_open")
        session_class.return_value.request.assert_not_called()
        with self.assertRaises(RazorpayUnavailable):
            ensure_gateway_available()

    @patch("apps.payments.services._TimeoutSession")
    def test_breaker_fails_open_when_redis_is_down(self, session_class):
        session_class.return_value.request.return_value = ok_response({"id": "pay_1"})
        broken = MagicMock()
        broken.get.side_effect = ConnectionError("redis down")
        broken.add.side_effect = ConnectionError("redis down")
        with patch("apps.core.circuit.CircuitBreaker.cache", new=broken):
            ensure_gateway_available()  # no exception
            self.assertEqual(fetch_razorpay_payment(razorpay_payment_id="pay_1")["id"], "pay_1")

    def test_missing_credentials_never_count_as_an_outage(self):
        with override_settings(RAZORPAY_KEY_ID="", RAZORPAY_KEY_SECRET=""):
            for _ in range(5):
                with self.assertRaises(RazorpayServiceError):
                    fetch_razorpay_payment(razorpay_payment_id="pay_1")
        self.assertNotEqual(get_breaker("razorpay").state(), STATE_OPEN)


# ---------------------------------------------------------------------------
# Course checkout: circuit open, verify during an outage, idempotency codes
# ---------------------------------------------------------------------------
@override_settings(DIRECT_COURSE_PAYMENTS_ENABLED=True, **KEYS)
class CourseCheckoutHardeningTests(BreakerIsolationMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.student = f.make_user()
        self.course = f.make_course(
            price=Decimal("3500.00"),
            monthly_price=Decimal("1500.00"),
            launch_status=Course.STATUS_LIVE,
        )
        self.client.force_authenticate(self.student)

    def payload(self, **overrides):
        data = {
            "course_id": self.course.id,
            "plan": Payment.PLAN_FULL,
            "buyer_name": "Hardening Buyer",
            "buyer_email": self.student.email,
            "whatsapp_number": "+91 98765 43210",
        }
        data.update(overrides)
        return data

    def create(self, key="checkout-hardening-key-0001", **overrides):
        with patch("apps.payments.views.create_razorpay_order") as gateway:
            gateway.side_effect = lambda **kw: razorpay_created_order("order_HARD1", **kw)
            response = self.client.post(
                reverse("payment-create-order"), self.payload(**overrides), format="json", HTTP_IDEMPOTENCY_KEY=key
            )
            return response, gateway

    def test_open_circuit_refuses_checkout_before_writing_anything(self):
        open_razorpay_breaker()
        response, gateway = self.create()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["errors"]["code"], "payment_gateway_unavailable")
        self.assertIn("Retry-After", response)
        gateway.assert_not_called()
        self.assertFalse(Payment.objects.exists())
        self.assertFalse(PaymentIdempotencyRecord.objects.exists())
        # The same key works as soon as Razorpay is back.
        reset_razorpay_breaker()
        response, _ = self.create()
        self.assertEqual(response.status_code, 201, response.data)

    def test_double_submit_with_one_key_creates_one_order(self):
        first, gateway = self.create()
        payment = Payment.objects.get()
        provider_order = {
            **razorpay_created_order(
                "order_HARD1", amount_paise=350000, currency="INR", receipt=f"p-{payment.internal_reference.hex[:24]}"
            ),
        }
        with patch("apps.payments.views.fetch_razorpay_order", return_value=provider_order):
            second, gateway2 = self.create()
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.data["data"]["razorpay_order_id"], first.data["data"]["razorpay_order_id"])
        gateway2.assert_not_called()
        self.assertEqual(Payment.objects.count(), 1)

    def test_key_reused_for_another_plan_tells_the_client_to_rotate(self):
        self.create()
        response, gateway = self.create(plan=Payment.PLAN_MONTHLY)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["errors"]["code"], "idempotency_key_reused")
        self.assertTrue(response.data["data"]["rotate_checkout_key"])
        gateway.assert_not_called()

    def test_in_flight_request_answers_retry_later(self):
        from apps.payments.idempotency import IdempotencyInFlightConflict

        with patch("apps.payments.views.claim_create_order", side_effect=IdempotencyInFlightConflict("busy")):
            response, _ = self.create()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["errors"]["code"], "idempotency_in_progress")
        self.assertEqual(response["Retry-After"], "3")
        self.assertIsNone(response.data["data"])

    def _pending_payment(self):
        return Payment.objects.create(
            user=self.student,
            course=self.course,
            razorpay_order_id="order_VERIFY1",
            amount=self.course.price,
            currency="INR",
            status=Payment.STATUS_CREATED,
        )

    def verify(self, payment, signature=None):
        return self.client.post(
            reverse("payment-verify"),
            {
                "course_id": self.course.id,
                "razorpay_order_id": payment.razorpay_order_id,
                "razorpay_payment_id": "pay_VERIFY1",
                "razorpay_signature": signature or checkout_signature(payment.razorpay_order_id, "pay_VERIFY1"),
            },
            format="json",
        )

    def captured(self, payment):
        return {
            "id": "pay_VERIFY1",
            "order_id": payment.razorpay_order_id,
            "status": "captured",
            "amount": int(payment.amount * 100),
            "currency": "INR",
        }

    def test_verify_during_a_razorpay_outage_answers_503_and_recovers_on_retry(self):
        payment = self._pending_payment()
        with patch("apps.payments.views.fetch_razorpay_payment", side_effect=RazorpayUnavailable(reason="timeout")):
            response = self.verify(payment)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["errors"]["code"], "payment_gateway_unavailable")
        self.assertTrue(response.data["data"]["retry_verify"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)  # nothing half-recorded
        with patch("apps.payments.views.fetch_razorpay_payment", return_value=self.captured(payment)):
            response = self.verify(payment)
        self.assertEqual(response.status_code, 200, response.data)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertTrue(Enrollment.objects.filter(user=self.student, course=self.course).exists())

    def test_signature_mismatch_is_still_a_client_error(self):
        payment = self._pending_payment()
        with patch("apps.payments.views.fetch_razorpay_payment") as fetch:
            response = self.verify(payment, signature="0" * 64)
        self.assertEqual(response.status_code, 400)
        fetch.assert_not_called()

    def test_amount_tampering_in_the_gateway_answer_is_refused(self):
        payment = self._pending_payment()
        tampered = {**self.captured(payment), "amount": 100}
        with patch("apps.payments.views.fetch_razorpay_payment", return_value=tampered):
            response = self.verify(payment)
        self.assertEqual(response.status_code, 409)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)

    def test_redis_outage_during_provisioning_does_not_undo_the_payment(self):
        payment = self._pending_payment()
        with (
            patch("apps.payments.views.fetch_razorpay_payment", return_value=self.captured(payment)),
            patch("apps.realtime.domain.cache.delete_many", side_effect=ConnectionError("redis down")),
        ):
            response = self.verify(payment)
        self.assertEqual(response.status_code, 200, response.data)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        enrollment = Enrollment.objects.get(user=self.student, course=self.course)
        self.assertEqual(enrollment.payment_status, Enrollment.STATUS_PAID)

    def test_payment_throttles_fail_open_when_redis_is_down(self):
        with patch("rest_framework.throttling.SimpleRateThrottle.cache") as broken:
            broken.get.side_effect = ConnectionError("redis down")
            response, _ = self.create()
        self.assertEqual(response.status_code, 201, response.data)

    def test_per_ip_ceiling_applies_across_accounts(self):
        rates = {"payment_ip": "2/minute", "payment_create": "100/minute"}
        with patch("apps.payments.throttles.FailOpenThrottleMixin.get_rate",
                   lambda throttle: rates.get(throttle.scope, "100/minute")):
            codes = []
            for index in range(3):
                user = f.make_user()
                self.client.force_authenticate(user)
                response, _ = self.create(key=f"checkout-ip-ceiling-{index:04d}", buyer_email=user.email)
                codes.append(response.status_code)
        self.assertEqual(codes[:2], [201, 201])
        self.assertEqual(codes[2], 429)


# ---------------------------------------------------------------------------
# Webhook: replay protection, stale events, malformed bodies, ordering
# ---------------------------------------------------------------------------
@override_settings(DIRECT_COURSE_PAYMENTS_ENABLED=True, ASYNC_JOBS_ENABLED=False, **KEYS)
class WebhookHardeningTests(BreakerIsolationMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.student = f.make_user()
        self.course = f.make_course(price=Decimal("3500.00"), launch_status=Course.STATUS_LIVE)
        self.payment = Payment.objects.create(
            user=self.student,
            course=self.course,
            razorpay_order_id="order_WH1",
            amount=self.course.price,
            currency="INR",
            status=Payment.STATUS_CREATED,
        )

    def post(self, payload, event_id, *, raw=None):
        body = raw if raw is not None else json.dumps(payload).encode()
        return self.client.post(
            reverse("payment-webhook"),
            data=body,
            content_type="application/json",
            HTTP_X_RAZORPAY_SIGNATURE=sign(body),
            HTTP_X_RAZORPAY_EVENT_ID=event_id,
        )

    def captured(self, **extra):
        return {
            "event": "payment.captured",
            "payload": {"payment": {"entity": {
                "id": "pay_WH1", "order_id": "order_WH1", "amount": 350000, "currency": "INR", "status": "captured",
            }}},
            **extra,
        }

    def test_capture_webhook_before_verify_then_verify_is_idempotent(self):
        response = self.post(self.captured(), "evt_cap_1")
        self.assertEqual(response.status_code, 200, response.content)
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_PAID)
        self.client.force_authenticate(self.student)
        verify = self.client.post(
            reverse("payment-verify"),
            {
                "course_id": self.course.id,
                "razorpay_order_id": "order_WH1",
                "razorpay_payment_id": "pay_WH1",
                "razorpay_signature": checkout_signature("order_WH1", "pay_WH1"),
            },
            format="json",
        )
        self.assertEqual(verify.status_code, 200, verify.data)
        self.assertEqual(Enrollment.objects.filter(user=self.student, course=self.course).count(), 1)
        self.assertEqual(Payment.objects.get(pk=self.payment.pk).invoice_number, self.payment.invoice_number)

    def test_same_signed_body_under_another_event_id_is_a_replay(self):
        self.post(self.captured(), "evt_original")
        with patch("apps.payments.views.process_payment_webhook_payload") as process:
            response = self.post(self.captured(), "evt_forged_new_id")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["data"]["duplicate"])
        process.assert_not_called()
        self.assertFalse(PaymentWebhookEvent.objects.filter(event_id="evt_forged_new_id").exists())

    def test_same_event_delivered_twice_is_processed_once(self):
        self.post(self.captured(), "evt_twice")
        with patch("apps.payments.views.process_payment_webhook_payload") as process:
            response = self.post(self.captured(), "evt_twice")
        self.assertTrue(response.json()["data"]["duplicate"])
        process.assert_not_called()

    @override_settings(PAYMENT_WEBHOOK_MAX_AGE_SECONDS=3600)
    def test_signed_event_older_than_the_replay_window_is_ignored(self):
        old = int((timezone.now() - timedelta(days=2)).timestamp())
        response = self.post(self.captured(created_at=old), "evt_stale")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["reason"], "stale_event")
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_CREATED)
        self.assertEqual(PaymentWebhookEvent.objects.get(event_id="evt_stale").status, PaymentWebhookEvent.STATUS_IGNORED)

    @override_settings(PAYMENT_WEBHOOK_MAX_AGE_SECONDS=3600)
    def test_fresh_event_inside_the_window_is_processed(self):
        response = self.post(self.captured(created_at=int(timezone.now().timestamp()) - 60), "evt_fresh")
        self.assertEqual(response.status_code, 200)
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_PAID)

    def test_signed_but_non_object_json_is_a_400_not_a_500(self):
        response = self.post(None, "evt_list", raw=b"[1, 2, 3]")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["errors"]["code"], "invalid_payload")

    def test_bad_signature_is_rejected_and_not_recorded(self):
        body = json.dumps(self.captured()).encode()
        response = self.client.post(
            reverse("payment-webhook"), data=body, content_type="application/json",
            HTTP_X_RAZORPAY_SIGNATURE=sign(body, b"wrong"), HTTP_X_RAZORPAY_EVENT_ID="evt_forged",
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(PaymentWebhookEvent.objects.exists())
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_CREATED)

    def test_failed_event_after_capture_never_downgrades(self):
        self.post(self.captured(), "evt_c")
        failed = {"event": "payment.failed", "payload": {"payment": {"entity": {
            "id": "pay_WH2", "order_id": "order_WH1", "amount": 350000, "currency": "INR", "status": "failed",
        }}}}
        self.post(failed, "evt_f")
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_PAID)

    def test_webhook_throttle_has_its_own_budget_and_fails_open(self):
        from apps.payments.views import PaymentWebhookView

        self.assertEqual([t.__name__ for t in PaymentWebhookView.throttle_classes], ["PaymentWebhookThrottle"])
        with patch("rest_framework.throttling.SimpleRateThrottle.cache") as broken:
            broken.get.side_effect = ConnectionError("redis down")
            response = self.post(self.captured(), "evt_redis_down")
        self.assertEqual(response.status_code, 200)


# ---------------------------------------------------------------------------
# Platform one-time plans: refunds, duplicates, late captures, circuit
# ---------------------------------------------------------------------------
@override_settings(**KEYS, ASYNC_JOBS_ENABLED=False)
class PlatformOrderHardeningTests(BreakerIsolationMixin, APITestCase):
    def setUp(self):
        super().setUp()
        features.invalidate_cache()
        from apps.payments import platform_plans

        self.student = f.make_user()
        self.client.force_authenticate(self.student)
        for slug in platform_plans.FOUNDATIONS_SLUGS:
            f.make_course(slug=slug, category=Course.CATEGORY_WEB_PENTESTING)
        self.plan = confirm_and_enable(seed_plans()["pentesting_bootcamp"])

    def create(self, order_id="order_PLAT1"):
        with patch("apps.payments.platform_orders.create_razorpay_order") as gateway:
            gateway.side_effect = lambda **kw: razorpay_created_order(order_id, **kw)
            return self.client.post("/api/payment/platform/orders/", {"plan_key": self.plan.key}, format="json")

    def webhook(self, payload, event_id):
        body = json.dumps(payload).encode()
        return self.client.post(reverse("payment-webhook"), data=body, content_type="application/json",
                                HTTP_X_RAZORPAY_SIGNATURE=sign(body), HTTP_X_RAZORPAY_EVENT_ID=event_id)

    def pay(self, order_id="order_PLAT1", payment_id="pay_PLAT1"):
        return self.webhook({"event": "payment.captured", "payload": {"payment": {"entity": {
            "id": payment_id, "order_id": order_id, "amount": 164900, "currency": "INR", "status": "captured",
        }}}}, f"evt_cap_{payment_id}")

    def refund(self, *, payment_id, amount_refunded, refund_amount, event_id, order_id="order_PLAT1"):
        return self.webhook({"event": "refund.processed", "payload": {
            "payment": {"entity": {"id": payment_id, "order_id": order_id, "amount_refunded": amount_refunded}},
            "refund": {"entity": {"payment_id": payment_id, "amount": refund_amount}},
        }}, event_id)

    def test_open_circuit_refuses_before_creating_a_payment_row(self):
        open_razorpay_breaker()
        response = self.create()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["errors"]["code"], "payment_gateway_unavailable")
        self.assertFalse(Payment.objects.exists())

    def test_refund_of_another_payment_on_the_order_does_not_revoke(self):
        self.create()
        self.pay()
        response = self.refund(payment_id="pay_LATE_DUPLICATE", amount_refunded=164900, refund_amount=164900,
                               event_id="evt_rf_other")
        self.assertEqual(response.status_code, 200)
        payment = Payment.objects.get()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertTrue(PlatformGrant.objects.get(payment=payment).is_active)

    def test_two_partial_refunds_add_up_to_a_full_refund(self):
        self.create()
        self.pay()
        self.refund(payment_id="pay_PLAT1", amount_refunded=80000, refund_amount=80000, event_id="evt_rf_1")
        payment = Payment.objects.get()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(payment.amount_refunded, Decimal("800.00"))
        # Second partial refund: the refund entity says 84900, the payment's cumulative total 164900.
        self.refund(payment_id="pay_PLAT1", amount_refunded=164900, refund_amount=84900, event_id="evt_rf_2")
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        self.assertFalse(PlatformGrant.objects.get(payment=payment).is_active)

    def test_late_capture_after_a_refund_never_regrants(self):
        self.create()
        self.pay()
        self.refund(payment_id="pay_PLAT1", amount_refunded=164900, refund_amount=164900, event_id="evt_rf_full")
        response = self.webhook({"event": "order.paid", "payload": {"payment": {"entity": {
            "id": "pay_PLAT1", "order_id": "order_PLAT1", "amount": 164900, "currency": "INR", "status": "captured",
        }}}}, "evt_late_capture")
        self.assertEqual(response.status_code, 200)
        payment = Payment.objects.get()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        self.assertFalse(PlatformGrant.objects.get(payment=payment).is_active)

    def test_second_paid_order_for_a_held_plan_is_flagged_for_refund(self):
        self.create("order_TAB1")
        self.create("order_TAB2")  # second tab, before either was paid
        self.pay("order_TAB1", "pay_TAB1")
        self.pay("order_TAB2", "pay_TAB2")
        first = Payment.objects.get(razorpay_order_id="order_TAB1")
        second = Payment.objects.get(razorpay_order_id="order_TAB2")
        self.assertEqual(first.provisioning_status, Payment.PROVISION_CREDENTIALS_ISSUED)
        self.assertEqual(second.status, Payment.STATUS_PAID)
        self.assertEqual(second.provisioning_status, Payment.PROVISION_DUPLICATE)

    def test_checkout_throttle_is_now_actually_applied(self):
        with patch("apps.payments.throttles.FailOpenThrottleMixin.get_rate",
                   lambda throttle: {"plan_checkout": "1/hour"}.get(throttle.scope, "100/minute")):
            first = self.create("order_T1")
            second = self.create("order_T2")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(second.status_code, 429)


# ---------------------------------------------------------------------------
# Billing: refunds of other payments, circuit, idempotent checkout
# ---------------------------------------------------------------------------
@override_settings(**KEYS, ASYNC_JOBS_ENABLED=False)
@patch("apps.payments.gateway.create_razorpay_order", side_effect=fake_order)
class BillingHardeningTests(BreakerIsolationMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.user = f.make_user()
        self.plan = make_plan(amount="1000.00", keys=("easy_ctfs",))

    def webhook(self, payload, event_id):
        body = json.dumps(payload).encode()
        return self.client.post(reverse("payment-webhook"), data=body, content_type="application/json",
                                HTTP_X_RAZORPAY_SIGNATURE=sign(body), HTTP_X_RAZORPAY_EVENT_ID=event_id)

    def test_refund_of_another_payment_on_the_order_keeps_the_grants(self, _order):
        checkout = billing.start_checkout(self.user, self.plan.pk)
        self.webhook({"event": "payment.captured", "payload": {"payment": {"entity": {
            "id": "pay_B1", "order_id": checkout["order_id"], "amount": 100000, "currency": "INR", "status": "captured",
        }}}}, "evt_b_cap")
        self.assertTrue(billing.has_entitlement(self.user, "easy_ctfs"))
        self.webhook({"event": "refund.processed", "payload": {
            "payment": {"entity": {"id": "pay_B_DUP", "order_id": checkout["order_id"], "amount_refunded": 100000}},
            "refund": {"entity": {"payment_id": "pay_B_DUP", "amount": 100000}},
        }}, "evt_b_refund_other")
        self.assertTrue(billing.has_entitlement(self.user, "easy_ctfs"))
        self.assertEqual(Purchase.objects.get().status, Purchase.STATUS_PAID)

    def test_open_circuit_refuses_before_creating_a_purchase(self, order):
        open_razorpay_breaker()
        self.client.force_authenticate(self.user)
        response = self.client.post(reverse("billing-checkout"), {"plan_id": self.plan.pk}, format="json")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["errors"]["code"], "payment_gateway_unavailable")
        self.assertFalse(Purchase.objects.exists())
        order.assert_not_called()

    def test_checkout_double_submit_with_a_key_replays_one_order(self, order):
        self.client.force_authenticate(self.user)
        first = self.client.post(reverse("billing-checkout"), {"plan_id": self.plan.pk}, format="json",
                                 HTTP_IDEMPOTENCY_KEY="billing-double-submit-0001")
        second = self.client.post(reverse("billing-checkout"), {"plan_id": self.plan.pk}, format="json",
                                  HTTP_IDEMPOTENCY_KEY="billing-double-submit-0001")
        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.json()["data"]["order_id"], first.json()["data"]["order_id"])
        self.assertEqual(Purchase.objects.count(), 1)
        self.assertEqual(order.call_count, 1)

    def test_renewal_before_expiry_extends_from_the_current_end(self, _order):
        first = billing.start_checkout(self.user, self.plan.pk)
        purchase, _ = billing.on_payment_captured({"order_id": first["order_id"], "payment_id": "pay_R1"})
        Purchase.objects.filter(pk=purchase.pk).update(created_at=timezone.now() - timedelta(hours=1))
        second = billing.start_checkout(self.user, self.plan.pk)
        self.assertNotEqual(second["order_id"], first["order_id"])
        renewal, _ = billing.on_payment_captured({"order_id": second["order_id"], "payment_id": "pay_R2"})
        self.assertEqual(renewal.period_start, purchase.period_end)
        self.assertEqual(renewal.period_end, purchase.period_end + timedelta(days=30))

    def test_renewal_after_expiry_starts_now(self, _order):
        first = billing.start_checkout(self.user, self.plan.pk)
        purchase, _ = billing.on_payment_captured({"order_id": first["order_id"], "payment_id": "pay_E1"})
        EntitlementGrant.objects.filter(purchase=purchase).update(
            starts_at=timezone.now() - timedelta(days=40), ends_at=timezone.now() - timedelta(days=10)
        )
        self.assertFalse(billing.has_entitlement(self.user, "easy_ctfs"))
        second = billing.start_checkout(self.user, self.plan.pk)
        renewal, _ = billing.on_payment_captured({"order_id": second["order_id"], "payment_id": "pay_E2"})
        self.assertLess(abs((renewal.period_start - timezone.now()).total_seconds()), 60)
        self.assertTrue(billing.has_entitlement(self.user, "easy_ctfs"))


# ---------------------------------------------------------------------------
# Stuck-payment reconciliation
# ---------------------------------------------------------------------------
def remote_order(order_id, amount_paise, status, currency="INR"):
    paid = amount_paise if status == "paid" else 0
    return {"id": order_id, "entity": "order", "amount": amount_paise, "amount_paid": paid,
            "amount_due": amount_paise - paid, "currency": currency, "status": status}


def remote_payment(order_id, payment_id, amount_paise, status="captured"):
    return {"id": payment_id, "entity": "payment", "order_id": order_id, "amount": amount_paise,
            "currency": "INR", "status": status}


@override_settings(DIRECT_COURSE_PAYMENTS_ENABLED=True, ASYNC_JOBS_ENABLED=False, **KEYS)
class ReconciliationTests(BreakerIsolationMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.student = f.make_user()
        self.course = f.make_course(price=Decimal("3500.00"), launch_status=Course.STATUS_LIVE)

    def stuck(self, *, order_id="order_STUCK1", age=timedelta(hours=2), user=None, email="", **extra):
        payment = Payment.objects.create(
            user=user if user is not None else self.student,
            course=self.course,
            razorpay_order_id=order_id,
            amount=self.course.price,
            currency="INR",
            status=Payment.STATUS_CREATED,
            buyer_email=email or self.student.email,
            **extra,
        )
        Payment.objects.filter(pk=payment.pk).update(created_at=timezone.now() - age)
        return payment

    def fakes(self, orders, payments):
        fetch_order = MagicMock(side_effect=lambda razorpay_order_id: orders[razorpay_order_id])
        fetch_payments = MagicMock(side_effect=lambda razorpay_order_id: {"items": payments.get(razorpay_order_id, [])})
        return {"fetch_order": fetch_order, "fetch_payments": fetch_payments}

    def test_captured_but_never_verified_payment_is_finalized_only_with_apply(self):
        payment = self.stuck()
        fakes = self.fakes({"order_STUCK1": remote_order("order_STUCK1", 350000, "paid")},
                           {"order_STUCK1": [remote_payment("order_STUCK1", "pay_STUCK1", 350000)]})
        dry = reconciliation.reconcile_stuck_payments(**fakes)
        self.assertEqual((dry.checked, dry.captured, dry.finalized), (1, 1, 0))
        self.assertEqual(dry.rows[0]["result"], "would_finalize")
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)

        report = reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        self.assertEqual(report.finalized, 1)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(payment.razorpay_payment_id, "pay_STUCK1")
        self.assertTrue(Enrollment.objects.filter(user=self.student, course=self.course, payment_status="paid").exists())
        # Running again finds nothing open.
        self.assertEqual(reconciliation.reconcile_stuck_payments(apply=True, **fakes).checked, 0)

    def test_too_young_orders_are_left_to_the_browser(self):
        self.stuck(age=timedelta(minutes=5))
        fakes = self.fakes({}, {})
        self.assertEqual(reconciliation.reconcile_stuck_payments(apply=True, **fakes).checked, 0)
        fakes["fetch_order"].assert_not_called()

    def test_old_never_attempted_order_is_closed_so_the_buyer_can_check_out_again(self):
        payment = self.stuck(age=timedelta(hours=30))
        fakes = self.fakes({"order_STUCK1": remote_order("order_STUCK1", 350000, "created")}, {})
        dry = reconciliation.reconcile_stuck_payments(**fakes)
        self.assertEqual(dry.rows[0]["result"], "would_supersede")
        report = reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        self.assertEqual(report.superseded, 1)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_FAILED)
        self.assertEqual(payment.gateway_status, "superseded")
        fakes["fetch_payments"].assert_not_called()

        # The buyer is no longer blocked by "an unfinished payment exists".
        from rest_framework.test import APIClient

        client = APIClient()
        client.force_authenticate(self.student)
        with patch("apps.payments.views.create_razorpay_order") as gateway:
            gateway.side_effect = lambda **kw: razorpay_created_order("order_FRESH1", **kw)
            response = client.post(reverse("payment-create-order"), {
                "course_id": self.course.id, "plan": "full", "buyer_name": "Returning Buyer",
                "buyer_email": self.student.email, "whatsapp_number": "+91 98765 43210",
            }, format="json", HTTP_IDEMPOTENCY_KEY="checkout-after-supersede-0001")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["data"]["razorpay_order_id"], "order_FRESH1")

    def test_superseded_order_still_finalizes_if_a_capture_arrives_later(self):
        payment = self.stuck(age=timedelta(hours=30))
        fakes = self.fakes({"order_STUCK1": remote_order("order_STUCK1", 350000, "created")}, {})
        reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        from apps.payments.views import process_payment_webhook_payload

        process_payment_webhook_payload(payload={"event": "payment.captured", "payload": {"payment": {
            "entity": remote_payment("order_STUCK1", "pay_LATE1", 350000)}}})
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)

    def test_young_unpaid_order_is_kept(self):
        payment = self.stuck(age=timedelta(hours=2))
        fakes = self.fakes({"order_STUCK1": remote_order("order_STUCK1", 350000, "created")}, {})
        report = reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        self.assertEqual((report.unpaid, report.superseded), (1, 0))
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)

    def test_payment_in_progress_is_never_closed(self):
        payment = self.stuck(age=timedelta(hours=30))
        fakes = self.fakes({"order_STUCK1": remote_order("order_STUCK1", 350000, "attempted")},
                           {"order_STUCK1": [remote_payment("order_STUCK1", "pay_A", 350000, status="authorized")]})
        report = reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        self.assertEqual((report.in_progress, report.superseded), (1, 0))
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)

    def test_only_failed_attempts_count_as_dead(self):
        payment = self.stuck(age=timedelta(hours=30))
        fakes = self.fakes({"order_STUCK1": remote_order("order_STUCK1", 350000, "attempted")},
                           {"order_STUCK1": [remote_payment("order_STUCK1", "pay_F", 350000, status="failed")]})
        reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_FAILED)

    def test_ambiguous_or_mismatched_orders_go_to_review(self):
        self.stuck(order_id="order_TWO")
        self.stuck(order_id="order_AMT", user=f.make_user())
        fakes = self.fakes(
            {"order_TWO": remote_order("order_TWO", 350000, "paid"), "order_AMT": remote_order("order_AMT", 100, "paid")},
            {"order_TWO": [remote_payment("order_TWO", "pay_1", 350000), remote_payment("order_TWO", "pay_2", 350000)]},
        )
        report = reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        self.assertEqual(report.needs_review, 2)
        self.assertFalse(Payment.objects.filter(status=Payment.STATUS_PAID).exists())

    def test_open_circuit_stops_the_run_before_any_call(self):
        self.stuck()
        open_razorpay_breaker()
        fakes = self.fakes({}, {})
        report = reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        self.assertEqual((report.stopped, report.checked), ("circuit_open", 0))
        fakes["fetch_order"].assert_not_called()

    def test_outage_mid_run_stops_instead_of_hammering(self):
        self.stuck(order_id="order_A1")
        self.stuck(order_id="order_A2", user=f.make_user())
        fetch_order = MagicMock(side_effect=RazorpayUnavailable(reason="timeout"))
        report = reconciliation.reconcile_stuck_payments(apply=True, fetch_order=fetch_order, fetch_payments=MagicMock())
        self.assertEqual(fetch_order.call_count, 1)
        self.assertEqual(report.stopped, "timeout")

    @patch("apps.payments.gateway.create_razorpay_order", side_effect=fake_order)
    def test_billing_purchase_captured_while_the_tab_was_closed(self, _order):
        plan = make_plan(amount="1000.00", keys=("easy_ctfs",))
        checkout = billing.start_checkout(self.student, plan.pk)
        Purchase.objects.update(created_at=timezone.now() - timedelta(hours=1))
        order_id = checkout["order_id"]
        fakes = self.fakes({order_id: remote_order(order_id, 100000, "paid")},
                           {order_id: [remote_payment(order_id, "pay_BILL_RC", 100000)]})
        report = reconciliation.reconcile_stuck_payments(apply=True, **fakes)
        self.assertEqual(report.finalized, 1)
        self.assertEqual(Purchase.objects.get().status, Purchase.STATUS_PAID)
        self.assertTrue(billing.has_entitlement(self.student, "easy_ctfs"))

    def test_periodic_hook_is_off_by_default_and_publishes_one_event_when_on(self):
        self.stuck()
        self.assertIsNone(reconciliation.schedule_reconcile())
        with override_settings(PAYMENT_RECONCILE_ENABLED=True):
            event = reconciliation.schedule_reconcile()
            again = reconciliation.schedule_reconcile()
        self.assertIsNotNone(event)
        self.assertEqual(event.pk, again.pk)
        self.assertEqual(OutboxEvent.objects.filter(event_type=reconciliation.EVENT_RECONCILE).count(), 1)

    def test_outbox_handler_runs_an_applying_batch_only_when_enabled(self):
        from apps.payments.outbox_handlers import handle_reconcile

        with patch("apps.payments.outbox_handlers.reconcile_stuck_payments") as run:
            handle_reconcile(MagicMock(payload={}))
            run.assert_not_called()
            with override_settings(PAYMENT_RECONCILE_ENABLED=True):
                run.return_value = reconciliation.ReconcileReport(apply=True)
                handle_reconcile(MagicMock(payload={}))
            run.assert_called_once_with(apply=True)

    def test_periodic_hook_is_registered(self):
        from apps.core import worker

        self.assertIn("payments.reconcile", worker._periodic_hooks)  # noqa: SLF001

    def test_management_command_is_a_dry_run_by_default(self):
        payment = self.stuck()
        out = StringIO()
        fakes = self.fakes({"order_STUCK1": remote_order("order_STUCK1", 350000, "paid")},
                           {"order_STUCK1": [remote_payment("order_STUCK1", "pay_CMD", 350000)]})
        real = reconciliation.reconcile_stuck_payments

        def with_fakes(**kwargs):
            return real(**kwargs, **fakes)

        with patch("apps.payments.management.commands.reconcile_payments.reconcile_stuck_payments", side_effect=with_fakes):
            call_command("reconcile_payments", stdout=out)
        self.assertIn("[DRY RUN]", out.getvalue())
        self.assertIn("would_finalize", out.getvalue())
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)
        with patch("apps.payments.management.commands.reconcile_payments.reconcile_stuck_payments", side_effect=with_fakes):
            call_command("reconcile_payments", "--apply", stdout=StringIO())
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)


# ---------------------------------------------------------------------------
# Access days: IST calendar anchoring
# ---------------------------------------------------------------------------
@override_settings(**KEYS)
class AccessDaysTimezoneTests(BreakerIsolationMixin, TestCase):
    def test_batch_start_date_anchors_at_ist_midnight_not_utc(self):
        from apps.payments.provisioning import provision_paid_payment

        student = f.make_user()
        course = f.make_course(price=Decimal("3500.00"), monthly_price=Decimal("1500.00"))
        payment = Payment.objects.create(
            user=student,
            course=course,
            razorpay_order_id="order_TZ1",
            razorpay_payment_id="pay_TZ1",
            amount=Decimal("1500.00"),
            currency="INR",
            status=Payment.STATUS_PAID,
            plan=Payment.PLAN_MONTHLY,
            paid_at=timezone.now(),
            terms_snapshot={"installments": 3, "access_days": 30, "start_date": "2099-01-01"},
        )
        provision_paid_payment(payment)
        payment.refresh_from_db()
        # 2099-01-01 00:00 IST == 2098-12-31 18:30 UTC, plus 30 days.
        expected = timezone.datetime(2098, 12, 31, 18, 30, tzinfo=timezone.get_fixed_timezone(0)) + timedelta(days=30)
        self.assertEqual(payment.access_expires_at, expected)
