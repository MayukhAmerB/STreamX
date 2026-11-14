"""Platform plans: shipped disabled, price confirmation, one-time orders and grants (BUILD_PLAN §4)."""

from __future__ import annotations

import hashlib
import hmac
from decimal import Decimal
from unittest.mock import patch

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.test import TestCase, override_settings
from rest_framework.test import APITestCase

from apps.core import features
from apps.courses.models import Course, Enrollment
from apps.payments import platform_plans
from apps.payments.models import Payment, PlatformGrant, PlatformPlan
from apps.payments.platform_orders import deactivate_grant
from tests import factories as f
from tests.test_api import razorpay_created_order

KEYS = {"RAZORPAY_KEY_ID": "rzp_test_public", "RAZORPAY_KEY_SECRET": "test-secret"}


def seed_plans():
    platform_plans.seed_platform_plans(apply=True)
    return {plan.key: plan for plan in PlatformPlan.objects.all()}


def confirm_and_enable(plan, *, razorpay_plan_id="plan_TEST123"):
    admin = f.make_admin()
    plan = platform_plans.confirm_price(plan, by=admin)
    if plan.is_subscription:
        plan.razorpay_plan_id = razorpay_plan_id
    plan.is_enabled = True
    plan.full_clean()
    plan.save()
    plan.refresh_from_db()
    return plan


class PlanInvariantTests(TestCase):
    def test_seed_ships_every_plan_disabled_and_unconfirmed_at_half_price(self):
        plans = seed_plans()
        self.assertEqual(
            set(plans),
            {"ctf_starter_monthly", "ctf_labs_monthly", "pentesting_bootcamp", "pentesting_membership_monthly",
             "pentesting_membership_yearly", "pentesting_lifetime"},
        )
        self.assertFalse(any(plan.is_enabled for plan in plans.values()))
        self.assertFalse(any(plan.price_is_confirmed for plan in plans.values()))
        self.assertEqual(plans["pentesting_bootcamp"].price_inr, Decimal("1649.00"))
        self.assertEqual(plans["pentesting_membership_monthly"].price_inr, Decimal("1649.00"))
        self.assertEqual(plans["pentesting_lifetime"].price_inr, Decimal("8399.00"))
        self.assertEqual(plans["ctf_labs_monthly"].price_inr, Decimal("1649.00"))
        self.assertEqual(plans["ctf_starter_monthly"].price_inr, Decimal("500.00"))
        # Second run creates nothing.
        self.assertEqual(platform_plans.seed_platform_plans(apply=True)["create"], [])

    def test_enabling_needs_a_confirmed_price(self):
        plan = seed_plans()["pentesting_bootcamp"]
        plan.is_enabled = True
        with self.assertRaises(ValidationError):
            plan.full_clean()
        plan.save()
        plan.refresh_from_db()
        self.assertFalse(plan.is_enabled, "save() never stores an enabled plan with blockers")

    def test_price_edit_unconfirms_and_switches_off(self):
        plan = confirm_and_enable(seed_plans()["pentesting_bootcamp"])
        self.assertTrue(plan.is_enabled)
        self.assertTrue(plan.price_is_confirmed)
        plan.price_inr = Decimal("1999.00")
        plan.save()
        plan.refresh_from_db()
        self.assertFalse(plan.is_enabled)
        self.assertFalse(plan.price_is_confirmed)
        self.assertIsNone(plan.price_confirmed_at)

    def test_period_edit_clears_the_razorpay_plan_id(self):
        plan = confirm_and_enable(seed_plans()["ctf_labs_monthly"])
        self.assertEqual(plan.razorpay_plan_id, "plan_TEST123")
        plan.billing_period = PlatformPlan.PERIOD_YEARLY
        plan.save()
        plan.refresh_from_db()
        self.assertEqual(plan.razorpay_plan_id, "")
        self.assertFalse(plan.is_enabled)

    def test_one_highlighted_plan_per_group(self):
        plans = seed_plans()
        highlighted = PlatformPlan.objects.filter(highlighted=True)
        self.assertEqual(sorted(highlighted.values_list("catalog_group", flat=True)), ["osint", "pentesting"])
        other = plans["pentesting_lifetime"]
        other.highlighted = True
        with self.assertRaises(ValidationError):
            other.full_clean()

    def test_starter_needs_a_batch_before_it_can_sell(self):
        plan = seed_plans()["ctf_starter_monthly"]
        self.assertIn("Choose the batch whose recordings this Starter plan includes.", plan.enable_blockers())


@override_settings(FEATURE_DEFAULT_OVERRIDES={})
class PublicPlanTests(TestCase):
    def setUp(self):
        cache.clear()
        features.invalidate_cache()

    def test_public_payload_hides_unconfirmed_prices_and_lists_free_first(self):
        seed_plans()
        payload = platform_plans.public_plans()
        self.assertEqual(payload[0]["key"], "free")
        self.assertEqual(payload[0]["state"], "available")
        self.assertEqual(payload[0]["href"], "/osint/free")
        for plan in payload[1:]:
            self.assertIsNone(plan["price"])
            self.assertEqual(plan["price_label"], "Price at launch")
            self.assertNotEqual(plan["state"], "available")
            self.assertTrue(plan["reason"])
        bootcamp = next(p for p in payload if p["key"] == "pentesting_bootcamp")
        self.assertEqual((bootcamp["state"], bootcamp["code"]), ("coming_soon", "feature_disabled"))
        labs = next(p for p in payload if p["key"] == "ctf_labs_monthly")
        self.assertEqual(labs["code"], "feature_disabled")  # memberships switch
        self.assertEqual(labs["entitlements"], ["ctf_labs"])
        self.assertIsNotNone(labs["included_this_month"])

    def test_confirmed_price_is_shown(self):
        plan = seed_plans()["pentesting_lifetime"]
        platform_plans.confirm_price(plan, by=f.make_admin())
        payload = {p["key"]: p for p in platform_plans.public_plans()}
        self.assertEqual(payload["pentesting_lifetime"]["price"], "8399.00")
        self.assertEqual(payload["pentesting_lifetime"]["price_label"], "₹8,399")


@override_settings(**KEYS)
class PlatformOrderTests(APITestCase):
    """Pentesting switch ON (the test default); plans enabled explicitly."""

    def setUp(self):
        cache.clear()
        features.invalidate_cache()
        self.student = f.make_user()
        self.client.force_authenticate(self.student)
        self.foundations = [
            f.make_course(slug=slug, category=Course.CATEGORY_WEB_PENTESTING)
            for slug in platform_plans.FOUNDATIONS_SLUGS
        ]
        self.plans = seed_plans()
        self.plan = self.plans["pentesting_bootcamp"]

    def create(self, key="pentesting_bootcamp"):
        with patch("apps.payments.platform_orders.create_razorpay_order") as gateway:
            gateway.side_effect = lambda **kw: razorpay_created_order("order_PLATFORM1", **kw)
            return self.client.post("/api/payment/platform/orders/", {"plan_key": key}, format="json")

    def test_disabled_plan_is_refused_with_plan_unavailable(self):
        response = self.create()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["errors"]["code"], "plan_unavailable")
        self.assertFalse(Payment.objects.exists())

    def test_order_amount_is_frozen_and_verify_grants_lifetime_access(self):
        confirm_and_enable(self.plan)
        response = self.create()
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()["data"]
        self.assertEqual(data["amount_paise"], 164900)
        payment = Payment.objects.get()
        self.assertEqual(payment.amount, Decimal("1649.00"))
        # Price edit after the order: the stored order is unchanged.
        self.plan.refresh_from_db()
        self.plan.price_inr = Decimal("1999.00")
        self.plan.save()
        payment.refresh_from_db()
        self.assertEqual(payment.amount, Decimal("1649.00"))

        signature = hmac.new(b"test-secret", b"order_PLATFORM1|pay_ABC123", hashlib.sha256).hexdigest()
        response = self.client.post(
            "/api/payment/platform/orders/verify/",
            {"razorpay_order_id": "order_PLATFORM1", "razorpay_payment_id": "pay_ABC123", "razorpay_signature": signature},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        for course in self.foundations:
            enrollment = Enrollment.objects.get(user=self.student, course=course)
            self.assertEqual(enrollment.access_type, Enrollment.ACCESS_LIFETIME)
        self.assertEqual(PlatformGrant.objects.filter(user=self.student, is_active=True).count(), 1)
        # Second purchase refused.
        confirm_and_enable(self.plan)
        self.assertEqual(self.create().status_code, 409)

    def test_bad_signature_is_refused(self):
        confirm_and_enable(self.plan)
        self.create()
        response = self.client.post(
            "/api/payment/platform/orders/verify/",
            {"razorpay_order_id": "order_PLATFORM1", "razorpay_payment_id": "pay_ABC123", "razorpay_signature": "x" * 64},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["errors"]["code"], "signature_invalid")

    def test_deactivating_a_grant_revokes_only_what_it_justified(self):
        confirm_and_enable(self.plan)
        self.create()
        payment = Payment.objects.get()
        from apps.payments.platform_orders import _mark_paid

        _mark_paid(payment, payment_id="pay_GRANT1")
        grant = PlatformGrant.objects.get()
        deactivate_grant(grant)
        for course in self.foundations:
            self.assertFalse(Enrollment.objects.get(user=self.student, course=course).has_active_access())
