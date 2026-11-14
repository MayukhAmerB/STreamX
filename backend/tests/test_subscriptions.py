"""Razorpay Subscriptions for memberships: gates, checkout, webhook lifecycle, reconcile (mocked gateway)."""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.cache import cache
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.core import features
from apps.courses.models import Course, Enrollment
from apps.osint_labs.access import labs_entitlements
from apps.payments import platform_plans, subscriptions
from apps.payments.models import Payment, PaymentWebhookEvent, PlatformPlan, PlatformSubscription
from apps.payments.recording_access import user_has_recording_access
from tests import factories as f
from tests.test_platform_plans import confirm_and_enable, seed_plans

WEBHOOK_SECRET = "whsec_subscriptions"
SETTINGS = {
    "RAZORPAY_KEY_ID": "rzp_test_public",
    "RAZORPAY_KEY_SECRET": "test-secret",
    "RAZORPAY_WEBHOOK_SECRET": WEBHOOK_SECRET,
    "SUBSCRIPTION_GRACE_DAYS": 3,
}


def remote_subscription(sub_id="sub_TEST1", plan_id="plan_TEST123", **extra):
    payload = {"id": sub_id, "entity": "subscription", "plan_id": plan_id, "status": "created", "total_count": 120,
               "short_url": "https://rzp.io/i/x"}
    payload.update(extra)
    return payload


def unix(dt):
    return int(dt.timestamp())


@override_settings(**SETTINGS)
class SubscriptionFlowTests(APITestCase):
    def setUp(self):
        cache.clear()
        features.invalidate_cache()
        self.admin = f.make_admin()
        self.student = f.make_user()
        self.client.force_authenticate(self.student)
        self.plans = seed_plans()
        self.plan = self.plans["ctf_labs_monthly"]

    def tearDown(self):
        features.invalidate_cache()

    def memberships_on(self):
        features.set_feature("memberships", True, by=self.admin)

    def subscribe(self, key="ctf_labs_monthly"):
        with patch("apps.payments.subscriptions.create_razorpay_subscription") as gateway:
            gateway.side_effect = lambda **kw: remote_subscription(plan_id=kw["plan_id"])
            return self.client.post("/api/payment/subscriptions/", {"plan_key": key}, format="json")

    def webhook(self, event, *, sub_id="sub_TEST1", event_id=None, created_at=None, entity=None, payment=None):
        body = {
            "event": event,
            "created_at": created_at or unix(timezone.now()),
            "payload": {"subscription": {"entity": {"id": sub_id, **(entity or {})}}},
        }
        if payment:
            body["payload"]["payment"] = {"entity": payment}
        raw = json.dumps(body).encode()
        signature = hmac.new(WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
        self.client.force_authenticate(None)
        response = self.client.post(
            "/api/payment/webhook/",
            data=raw,
            content_type="application/json",
            HTTP_X_RAZORPAY_SIGNATURE=signature,
            HTTP_X_RAZORPAY_EVENT_ID=event_id or f"evt_{event}_{timezone.now().timestamp()}",
        )
        self.client.force_authenticate(self.student)
        return response

    # -- gates -----------------------------------------------------------------
    @override_settings(FEATURE_DEFAULT_OVERRIDES={})
    def test_memberships_switch_off_refuses_with_feature_disabled(self):
        confirm_and_enable(self.plan)
        response = self.subscribe()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "feature_disabled")
        self.assertEqual(response.json()["errors"]["feature"], "memberships")
        self.assertFalse(PlatformSubscription.objects.exists())

    def test_unconfirmed_plan_is_refused_even_with_the_switch_on(self):
        self.memberships_on()
        response = self.subscribe()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["errors"]["code"], "plan_unavailable")

    # -- lifecycle --------------------------------------------------------------
    def start(self):
        self.memberships_on()
        confirm_and_enable(self.plan)
        response = self.subscribe()
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["data"]["subscription_id"], "sub_TEST1")
        return PlatformSubscription.objects.get()

    def test_create_is_resumable_and_unique(self):
        first = self.start()
        response = self.subscribe()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(PlatformSubscription.objects.count(), 1)
        self.assertEqual(first.status, "created")

    def test_verify_checks_signature_and_gives_provisional_access(self):
        self.start()
        bad = self.client.post(
            "/api/payment/subscriptions/verify/",
            {"razorpay_payment_id": "pay_1", "razorpay_subscription_id": "sub_TEST1", "razorpay_signature": "0" * 64},
            format="json",
        )
        self.assertEqual(bad.status_code, 400)
        signature = hmac.new(b"test-secret", b"pay_1|sub_TEST1", hashlib.sha256).hexdigest()
        with patch("apps.payments.subscriptions.fetch_razorpay_subscription", side_effect=subscriptions.RazorpayServiceError("down")):
            ok = self.client.post(
                "/api/payment/subscriptions/verify/",
                {"razorpay_payment_id": "pay_1", "razorpay_subscription_id": "sub_TEST1", "razorpay_signature": signature},
                format="json",
            )
        self.assertEqual(ok.status_code, 200, ok.content)
        sub = PlatformSubscription.objects.get()
        self.assertEqual(sub.status, "authenticated")
        self.assertTrue(sub.has_access())

    def test_every_webhook_transition_and_access_with_grace(self):
        sub = self.start()
        now = timezone.now()
        start, end = now, now + timedelta(days=30)
        self.assertEqual(self.webhook("subscription.authenticated").status_code, 200)
        sub.refresh_from_db()
        self.assertEqual(sub.status, "authenticated")
        self.assertFalse(sub.has_access(), "no access before the first charge")

        charge = {"id": "pay_CHARGE1", "amount": 164900, "currency": "INR", "status": "captured", "method": "upi"}
        entity = {"current_start": unix(start), "current_end": unix(end), "paid_count": 1, "status": "active"}
        self.assertEqual(self.webhook("subscription.charged", entity=entity, payment=charge, event_id="evt_c1").status_code, 200)
        sub.refresh_from_db()
        self.assertEqual(sub.status, "active")
        self.assertEqual(sub.paid_count, 1)
        self.assertAlmostEqual(sub.access_until.timestamp(), (end + timedelta(days=3)).timestamp(), delta=2)
        self.assertEqual(Payment.objects.filter(plan=Payment.PLAN_PLATFORM_SUBSCRIPTION).count(), 1)
        self.assertTrue(labs_entitlements(self.student)["ctf_labs"]["active"])

        # Replay of the same event id: de-duplicated upstream, no second Payment.
        self.webhook("subscription.charged", entity=entity, payment=charge, event_id="evt_c1")
        # Same charge under a new event id: idempotent on the payment id.
        self.webhook("subscription.charged", entity=entity, payment=charge, event_id="evt_c1b")
        self.assertEqual(Payment.objects.filter(plan=Payment.PLAN_PLATFORM_SUBSCRIPTION).count(), 1)

        for event, status in (("subscription.pending", "pending"), ("subscription.halted", "halted"),
                              ("subscription.resumed", "active"), ("subscription.paused", "paused"),
                              ("subscription.cancelled", "cancelled")):
            self.webhook(event)
            sub.refresh_from_db()
            self.assertEqual(sub.status, status)
            self.assertTrue(sub.has_access(), f"paid time is never cut short ({event})")
        self.assertIsNotNone(sub.ended_at)

    def test_out_of_order_event_does_not_rewind_status(self):
        sub = self.start()
        now = timezone.now()
        self.webhook("subscription.cancelled", created_at=unix(now))
        self.webhook("subscription.activated", created_at=unix(now - timedelta(minutes=5)))
        sub.refresh_from_db()
        self.assertEqual(sub.status, "cancelled")

    def test_cancel_at_cycle_end_keeps_access(self):
        sub = self.start()
        now = timezone.now()
        self.webhook("subscription.charged", entity={"current_start": unix(now), "current_end": unix(now + timedelta(days=30)),
                                                     "paid_count": 1}, payment={"id": "pay_C2", "amount": 164900, "currency": "INR"})
        with patch("apps.payments.subscriptions.cancel_razorpay_subscription") as cancel:
            response = self.client.post(f"/api/payment/subscriptions/{sub.pk}/cancel/", {"at_cycle_end": False}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        cancel.assert_called_once()
        self.assertTrue(cancel.call_args.kwargs["at_cycle_end"], "students always cancel at cycle end")
        sub.refresh_from_db()
        self.assertTrue(sub.cancel_at_cycle_end)
        self.assertTrue(sub.has_access())
        mine = self.client.get("/api/payment/subscriptions/mine/").json()["data"]["subscriptions"]
        self.assertEqual(mine[0]["plan_key"], "ctf_labs_monthly")

    def test_reconcile_applies_missed_webhooks_with_a_mocked_client(self):
        sub = self.start()
        PlatformSubscription.objects.filter(pk=sub.pk).update(updated_at=timezone.now() - timedelta(hours=30))
        now = timezone.now()
        remote = remote_subscription(status="active", paid_count=1, current_start=unix(now),
                                     current_end=unix(now + timedelta(days=30)))
        report = subscriptions.reconcile(apply=False, fetch=lambda **kw: remote)
        self.assertEqual(report["changed"], 1)
        sub.refresh_from_db()
        self.assertEqual(sub.status, "created", "dry run writes nothing")
        subscriptions.reconcile(apply=True, fetch=lambda **kw: remote)
        sub.refresh_from_db()
        self.assertEqual(sub.status, "active")
        self.assertTrue(sub.has_access())
        out = StringIO()
        with patch("apps.payments.subscriptions.fetch_razorpay_subscription", return_value=remote):
            call_command("reconcile_subscriptions", stdout=out)
        self.assertIn("reconcile_subscriptions [DRY RUN]", out.getvalue())

    def test_unknown_subscription_webhook_is_ignored(self):
        response = self.webhook("subscription.activated", sub_id="sub_UNKNOWN")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(PaymentWebhookEvent.objects.exists())


@override_settings(**SETTINGS)
class MembershipEntitlementTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.student = f.make_user()
        self.plans = seed_plans()

    def active_sub(self, plan, days=10):
        now = timezone.now()
        return PlatformSubscription.objects.create(
            user=self.student, plan=plan, razorpay_subscription_id=f"sub_{plan.key[:20]}", status="active",
            paid_count=1, current_end=now + timedelta(days=days), access_until=now + timedelta(days=days + 3),
        )

    def test_pentesting_membership_extends_enrollments_to_access_until(self):
        course = f.make_course(category=Course.CATEGORY_WEB_PENTESTING)
        sub = self.active_sub(self.plans["pentesting_membership_monthly"])
        subscriptions.sync_subscription_enrollments(sub)
        enrollment = Enrollment.objects.get(user=self.student, course=course)
        self.assertTrue(enrollment.has_active_access())
        self.assertEqual(enrollment.access_expires_at, sub.access_until)

    def test_starter_plays_only_its_batch_and_labs_gets_the_bundle(self):
        batch = f.make_course(category=Course.CATEGORY_OSINT)
        other = f.make_course(category=Course.CATEGORY_OSINT)
        always = f.make_course(category=Course.CATEGORY_OSINT, membership_always_included=True)
        starter = self.plans["ctf_starter_monthly"]
        starter.starter_course = batch
        starter.save()
        self.active_sub(starter)
        self.assertTrue(user_has_recording_access(self.student, batch.pk))
        self.assertFalse(user_has_recording_access(self.student, other.pk))
        self.assertEqual(labs_entitlements(self.student)["ctf_starter"]["active"], True)

        labs_user = f.make_user()
        PlatformSubscription.objects.create(
            user=labs_user, plan=self.plans["ctf_labs_monthly"], razorpay_subscription_id="sub_labs1", status="active",
            paid_count=1, access_until=timezone.now() + timedelta(days=5),
        )
        bundle = platform_plans.copy_previous_bundle(platform_plans.ist_month_start())
        bundle.courses.set([other])
        self.assertFalse(user_has_recording_access(labs_user, other.pk), "draft bundles grant nothing")
        platform_plans.publish_bundle(bundle)
        self.assertTrue(user_has_recording_access(labs_user, other.pk))
        self.assertTrue(user_has_recording_access(labs_user, always.pk))
        self.assertFalse(user_has_recording_access(labs_user, batch.pk))
        self.assertFalse(Enrollment.objects.filter(user=labs_user).exists(), "recordings only, no enrollment")

    def test_plan_kinds(self):
        self.assertTrue(self.plans["ctf_labs_monthly"].is_subscription)
        self.assertFalse(self.plans["pentesting_lifetime"].is_subscription)
        self.assertEqual(PlatformPlan.objects.filter(is_enabled=True).count(), 0)
