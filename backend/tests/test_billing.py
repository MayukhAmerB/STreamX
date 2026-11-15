"""apps.billing: catalogue, versioned prices, checkout, capture, entitlements and hooks.

Razorpay is always mocked (``apps.payments.gateway.create_razorpay_order``).
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import timedelta
from decimal import Decimal
from io import StringIO
from unittest.mock import patch

from django.contrib.auth.models import Permission
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase

from apps import billing
from apps.billing.management.commands.seed_batch_pricing import seed_batch_pricing
from apps.billing.models import EntitlementGrant, EntitlementKey, Plan, PlanEntitlement, Price, Product, Purchase
from apps.courses.access import active_enrollment_q
from apps.courses.models import Enrollment
from apps.payments.models import Payment
from tests import factories as f
from tests.test_api import razorpay_created_order

KEYS = {"RAZORPAY_KEY_ID": "rzp_test_public", "RAZORPAY_KEY_SECRET": "test-secret", "RAZORPAY_WEBHOOK_SECRET": "whsec"}
_order_counter = {"n": 0}


def fake_order(*, amount_paise, currency="INR", receipt=""):
    _order_counter["n"] += 1
    return razorpay_created_order(f"order_BILL{_order_counter['n']}", amount_paise=amount_paise, currency=currency,
                                  receipt=receipt)


def make_plan(*, amount="1000.00", billing_type=Price.RECURRING, days=30, keys=("free_ctfs",), key=None):
    product, _ = Product.objects.get_or_create(key="test-product", defaults={"name": "Test product"})
    price = Price.objects.create(
        product=product,
        amount=Decimal(amount),
        billing_type=billing_type,
        interval=Price.MONTH if billing_type == Price.RECURRING else "",
        access_days=days,
    )
    plan = Plan.objects.create(product=product, price=price, key=key or f"plan-{price.pk}", name=f"Plan {price.pk}")
    for item in keys:
        PlanEntitlement.objects.create(plan=plan, key=item)
    return plan


def capture(purchase, *, payment_id="pay_1"):
    return billing.on_payment_captured(
        billing.CapturedPayment(order_id=purchase["order_id"] if isinstance(purchase, dict) else purchase.provider_order_id,
                                payment_id=payment_id)
    )


@override_settings(**KEYS)
@patch("apps.payments.gateway.create_razorpay_order", side_effect=fake_order)
class CheckoutAndCaptureTests(TestCase):
    def setUp(self):
        self.user = f.make_user()

    def test_quote_is_read_from_the_server_price(self, _order):
        plan = make_plan(amount="1000.00")
        quote = billing.quote(plan.pk, self.user)
        self.assertEqual(quote.amount, "1000.00")
        self.assertEqual(quote.amount_paise, 100000)
        self.assertEqual(billing.quote(plan.key, self.user).plan_id, plan.pk)

    def test_price_change_applies_instantly_and_old_purchases_keep_their_snapshot(self, order):
        plan = make_plan(amount="1000.00")
        first = billing.start_checkout(self.user, plan.pk)
        capture(first)
        old_purchase = Purchase.objects.get(pk=first["purchase_id"])

        price = plan.price
        price.amount = Decimal("1200.00")
        price.save()  # an admin edit: no restart, no cache

        self.assertEqual(billing.quote(plan.pk).amount, "1200.00")
        other = f.make_user()
        second = billing.start_checkout(other, plan.pk)
        self.assertEqual(second["amount_paise"], 120000)
        self.assertEqual(order.call_args.kwargs["amount_paise"], 120000)

        old_purchase.refresh_from_db()
        self.assertEqual(old_purchase.amount, Decimal("1000.00"))
        # Versioned: the old purchase now points at an archived copy of the old price.
        self.assertNotEqual(old_purchase.price_id, plan.price_id)
        self.assertEqual(old_purchase.price.amount, Decimal("1000.00"))
        self.assertFalse(old_purchase.price.is_active)
        self.assertEqual(old_purchase.price.superseded_by_id, plan.price_id)
        plan.price.refresh_from_db()
        self.assertEqual(plan.price.version, 2)

    def test_capture_is_idempotent_and_creates_grants(self, _order):
        plan = make_plan(keys=("free_ctfs", "easy_ctfs"))
        checkout = billing.start_checkout(self.user, plan.pk)
        purchase, changed = capture(checkout)
        self.assertTrue(changed)
        again, changed_again = capture(checkout)
        self.assertFalse(changed_again)
        self.assertEqual(again.pk, purchase.pk)
        self.assertEqual(purchase.status, Purchase.STATUS_PAID)
        self.assertEqual(EntitlementGrant.objects.filter(purchase=purchase).count(), 2)
        self.assertTrue(billing.has_entitlement(self.user, "easy_ctfs"))

    def test_capture_rejects_a_wrong_amount(self, _order):
        plan = make_plan(amount="1000.00")
        checkout = billing.start_checkout(self.user, plan.pk)
        with self.assertRaises(billing.BillingError):
            billing.on_payment_captured({"order_id": checkout["order_id"], "payment_id": "p", "amount_paise": 100})
        self.assertFalse(billing.has_entitlement(self.user, "free_ctfs"))

    def test_open_checkout_is_reused_not_duplicated(self, order):
        plan = make_plan()
        first = billing.start_checkout(self.user, plan.pk)
        second = billing.start_checkout(self.user, plan.pk)
        self.assertEqual(first["order_id"], second["order_id"])
        self.assertEqual(order.call_count, 1)

    def test_monthly_renewal_extends_from_the_current_end(self, _order):
        plan = make_plan(days=30)
        capture(billing.start_checkout(self.user, plan.pk), payment_id="pay_a")
        first_end = EntitlementGrant.objects.get(user=self.user).ends_at
        Purchase.objects.update(created_at=timezone.now() - timedelta(hours=1))  # no reuse of the paid order
        capture(billing.start_checkout(self.user, plan.pk), payment_id="pay_b")
        grants = list(EntitlementGrant.objects.filter(user=self.user).order_by("starts_at"))
        self.assertEqual(len(grants), 2)
        self.assertEqual(grants[1].starts_at, first_end)
        self.assertEqual(grants[1].ends_at, first_end + timedelta(days=30))
        window = billing.entitlement_window(self.user, "free_ctfs")
        self.assertEqual(window["ends_at"], first_end + timedelta(days=30))
        # Still covered after the first month, through the renewal.
        self.assertTrue(billing.has_entitlement(self.user, "free_ctfs", at=first_end + timedelta(days=1)))

    def test_lifetime_plan_cannot_be_bought_twice(self, _order):
        plan = make_plan(billing_type=Price.ONE_TIME, days=None)
        capture(billing.start_checkout(self.user, plan.pk))
        with self.assertRaises(billing.BillingError) as ctx:
            billing.start_checkout(self.user, plan.pk)
        self.assertEqual(ctx.exception.code, "already_owned")

    def test_hidden_plan_is_not_listed_or_sold(self, _order):
        plan = make_plan()
        self.assertIn(plan, billing.list_plans())
        plan.is_active = False
        plan.save()
        self.assertNotIn(plan, billing.list_plans())
        with self.assertRaises(billing.BillingError):
            billing.start_checkout(self.user, plan.pk)


class EntitlementWindowTests(TestCase):
    def setUp(self):
        self.user = f.make_user()

    def test_time_windows_and_revocation(self):
        now = timezone.now()
        grant = billing.grant_manually(self.user, "resources", starts_at=now + timedelta(days=1),
                                       ends_at=now + timedelta(days=5))
        self.assertFalse(billing.has_entitlement(self.user, "resources"))
        self.assertTrue(billing.has_entitlement(self.user, "resources", at=now + timedelta(days=2)))
        self.assertFalse(billing.has_entitlement(self.user, "resources", at=now + timedelta(days=6)))
        billing.revoke_grant(grant, reason="test")
        self.assertFalse(billing.has_entitlement(self.user, "resources", at=now + timedelta(days=2)))

    def test_lifetime_grant_and_entitlements_for(self):
        billing.grant_manually(self.user, "all_labs")
        rows = billing.entitlements_for(self.user)
        self.assertEqual([row["key"] for row in rows], ["all_labs"])
        self.assertTrue(rows[0]["lifetime"])
        self.assertFalse(billing.has_entitlement(f.make_user(), "all_labs"))

    def test_unknown_keys_are_rejected_until_registered_in_the_admin(self):
        with self.assertRaises(billing.BillingError):
            billing.grant_manually(self.user, "vip_lounge")
        EntitlementKey.objects.create(key="vip_lounge", label="VIP lounge")
        billing.grant_manually(self.user, "vip_lounge")
        self.assertTrue(billing.has_entitlement(self.user, "vip_lounge"))
        with self.assertRaises(billing.BillingError):
            billing.grant_manually(self.user, "course_access")  # needs an argument


@override_settings(**KEYS)
@patch("apps.payments.gateway.create_razorpay_order", side_effect=fake_order)
class CourseEnrollmentHookTests(TestCase):
    def setUp(self):
        self.user = f.make_user()
        self.course = f.make_course()

    def _enrollment(self):
        return Enrollment.objects.get(user=self.user, course=self.course)

    def test_monthly_plan_creates_a_time_limited_enrollment(self, _order):
        plan = make_plan(days=30, keys=(f"course_access:{self.course.pk}",))
        purchase, _ = capture(billing.start_checkout(self.user, plan.pk))
        enrollment = self._enrollment()
        self.assertEqual(enrollment.payment_status, Enrollment.STATUS_PAID)
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_INSTALLMENT)
        self.assertEqual(enrollment.access_expires_at, purchase.period_end)
        self.assertTrue(enrollment.has_active_access())

        Purchase.objects.update(created_at=timezone.now() - timedelta(hours=1))
        renewal, _ = capture(billing.start_checkout(self.user, plan.pk), payment_id="pay_2")
        self.assertEqual(self._enrollment().access_expires_at, renewal.period_end)
        self.assertEqual(renewal.period_end, purchase.period_end + timedelta(days=30))

    def test_one_time_plan_gives_lifetime_and_refund_revokes(self, _order):
        plan = make_plan(billing_type=Price.ONE_TIME, days=None, keys=(f"course_access:{self.course.pk}",))
        purchase, _ = capture(billing.start_checkout(self.user, plan.pk))
        self.assertEqual(self._enrollment().access_type, Enrollment.ACCESS_LIFETIME)
        billing.on_payment_refunded(purchase)
        self.assertFalse(self._enrollment().has_active_access())
        self.assertFalse(Enrollment.objects.filter(active_enrollment_q(), user=self.user).exists())

    def test_refund_keeps_access_paid_for_in_the_course_flow(self, _order):
        f.make_payment(user=self.user, course=self.course, status=Payment.STATUS_PAID, plan=Payment.PLAN_FULL)
        plan = make_plan(billing_type=Price.ONE_TIME, days=None, keys=(f"course_access:{self.course.pk}",))
        purchase, _ = capture(billing.start_checkout(self.user, plan.pk))
        billing.on_payment_refunded(purchase)
        self.assertTrue(self._enrollment().has_active_access())

    def test_course_flow_resync_keeps_billing_access(self, _order):
        from apps.payments.entitlements import resync_enrollment_access

        plan = make_plan(days=30, keys=(f"course_access:{self.course.pk}",))
        capture(billing.start_checkout(self.user, plan.pk))
        resync_enrollment_access(self.user.pk, self.course)
        self.assertTrue(self._enrollment().has_active_access())


def _sign(body: bytes) -> str:
    return hmac.new(b"whsec", body, hashlib.sha256).hexdigest()


@override_settings(**KEYS)
@patch("apps.payments.gateway.create_razorpay_order", side_effect=fake_order)
class BillingApiTests(APITestCase):
    def setUp(self):
        self.user = f.make_user()
        self.course = f.make_course()
        seed_batch_pricing(self.course.pk, apply=True)

    def test_plans_list_filters_by_course(self, _order):
        response = self.client.get(reverse("billing-plans"), {"course": self.course.pk})
        self.assertEqual(response.status_code, 200)
        plans = response.json()["data"]["plans"]
        self.assertEqual([p["price"]["amount"] for p in plans], ["1000.00", "1500.00", "3500.00", "4500.00"])
        other = f.make_course()
        self.assertEqual(self.client.get(reverse("billing-plans"), {"course": other.pk}).json()["data"]["plans"], [])

    def test_checkout_uses_the_server_amount_not_the_client_one(self, _order):
        self.client.force_authenticate(self.user)
        plan = Plan.objects.get(key=f"batch-{self.course.pk}-monthly-all")
        response = self.client.post(reverse("billing-checkout"), {"plan_id": plan.pk, "amount": "1.00"}, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["data"]["amount_paise"], 150000)
        quote = self.client.post(reverse("billing-quote"), {"plan_id": plan.key}, format="json")
        self.assertEqual(quote.json()["data"]["amount"], "1500.00")

    def test_anonymous_cannot_checkout(self, _order):
        response = self.client.post(reverse("billing-checkout"), {"plan_id": 1}, format="json")
        self.assertIn(response.status_code, (401, 403))

    def test_verify_with_signature_grants_and_lists_entitlements(self, _order):
        self.client.force_authenticate(self.user)
        plan = Plan.objects.get(key=f"batch-{self.course.pk}-once-course")
        order_id = self.client.post(reverse("billing-checkout"), {"plan_id": plan.pk}, format="json").json()["data"]["order_id"]
        bad = self.client.post(reverse("billing-checkout-verify"),
                               {"order_id": order_id, "payment_id": "pay_X", "signature": "nope"}, format="json")
        self.assertEqual(bad.status_code, 400)
        signature = hmac.new(b"test-secret", f"{order_id}|pay_X".encode(), hashlib.sha256).hexdigest()
        ok = self.client.post(reverse("billing-checkout-verify"),
                              {"order_id": order_id, "payment_id": "pay_X", "signature": signature}, format="json")
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["data"]["status"], "paid")
        mine = self.client.get(reverse("billing-entitlements")).json()["data"]["entitlements"]
        self.assertEqual([row["key"] for row in mine], [f"course_access:{self.course.pk}"])
        self.assertTrue(Enrollment.objects.filter(active_enrollment_q(), user=self.user, course=self.course).exists())

    def test_razorpay_webhook_captures_and_refunds_billing_orders(self, _order):
        plan = Plan.objects.get(key=f"batch-{self.course.pk}-monthly-core")
        checkout = billing.start_checkout(self.user, plan.pk)
        payload = {
            "event": "payment.captured",
            "payload": {"payment": {"entity": {"id": "pay_W1", "order_id": checkout["order_id"], "amount": 100000,
                                               "currency": "INR", "status": "captured"}}},
        }
        body = json.dumps(payload).encode()
        response = self.client.post(reverse("payment-webhook"), data=body, content_type="application/json",
                                    HTTP_X_RAZORPAY_SIGNATURE=_sign(body), HTTP_X_RAZORPAY_EVENT_ID="evt_1")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json()["data"]["processed"])
        self.assertTrue(billing.has_entitlement(self.user, "easy_ctfs"))
        self.assertFalse(Payment.objects.exists())  # the course flow was not involved

        refund = {
            "event": "refund.processed",
            "payload": {
                "payment": {"entity": {"id": "pay_W1", "order_id": checkout["order_id"], "amount_refunded": 100000}},
                "refund": {"entity": {"payment_id": "pay_W1", "amount": 100000}},
            },
        }
        body = json.dumps(refund).encode()
        response = self.client.post(reverse("payment-webhook"), data=body, content_type="application/json",
                                    HTTP_X_RAZORPAY_SIGNATURE=_sign(body), HTTP_X_RAZORPAY_EVENT_ID="evt_2")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(billing.has_entitlement(self.user, "easy_ctfs"))
        self.assertEqual(Purchase.objects.get().status, Purchase.STATUS_REFUNDED)

    def test_labs_and_ctf_eligibility_include_billing_entitlements(self, _order):
        billing.grant_manually(self.user, "all_labs")
        self.client.force_authenticate(self.user)
        labs = self.client.get(reverse("labs-entitlement")).json()["data"]
        self.assertEqual([row["key"] for row in labs["entitlements"]], ["all_labs"])
        self.assertTrue(labs["ctf_labs"]["active"])
        self.assertEqual(labs["ctf_labs"]["source"], "billing")
        ctf = self.client.get(reverse("ctf-eligibility"))
        self.assertEqual(ctf.status_code, 200)
        self.assertEqual([row["key"] for row in ctf.json()["data"]["entitlements"]], ["all_labs"])


class SeedCommandTests(TestCase):
    def test_dry_run_writes_nothing_and_apply_creates_the_four_plans(self):
        course = f.make_course()
        out = StringIO()
        call_command("seed_batch_pricing", "--course", str(course.pk), stdout=out)
        self.assertIn("DRY RUN", out.getvalue())
        self.assertFalse(Plan.objects.exists())
        self.assertFalse(Product.objects.exists())

        call_command("seed_batch_pricing", "--course", str(course.pk), "--apply", stdout=StringIO())
        plans = {plan.key: plan for plan in Plan.objects.select_related("price")}
        prefix = f"batch-{course.pk}"
        self.assertEqual(
            {key: (plan.price.amount, plan.price.billing_type, plan.price.period_days()) for key, plan in plans.items()},
            {
                f"{prefix}-monthly-core": (Decimal("1000.00"), Price.RECURRING, 30),
                f"{prefix}-monthly-all": (Decimal("1500.00"), Price.RECURRING, 30),
                f"{prefix}-once-course": (Decimal("3500.00"), Price.ONE_TIME, None),
                f"{prefix}-once-all": (Decimal("4500.00"), Price.ONE_TIME, None),
            },
        )
        course_key = f"course_access:{course.pk}"
        self.assertEqual(set(plans[f"{prefix}-monthly-core"].entitlement_keys()),
                         {course_key, "free_ctfs", "easy_ctfs", "side_courses"})
        self.assertEqual(set(plans[f"{prefix}-once-course"].entitlement_keys()), {course_key})
        everything = {course_key, "free_ctfs", "easy_ctfs", "side_courses", "weekly_challenges", "special_ctfs",
                      "resources", "all_labs"}
        self.assertEqual(set(plans[f"{prefix}-monthly-all"].entitlement_keys()), everything)
        self.assertEqual(set(plans[f"{prefix}-once-all"].entitlement_keys()), everything)

        # Idempotent, and never overwrites an amount the admin changed.
        price = plans[f"{prefix}-monthly-core"].price
        price.amount = Decimal("999.00")
        price.save()
        out = StringIO()
        call_command("seed_batch_pricing", "--course", str(course.pk), "--apply", stdout=out)
        self.assertNotIn("create", out.getvalue())
        self.assertEqual(Plan.objects.count(), 4)
        price.refresh_from_db()
        self.assertEqual(price.amount, Decimal("999.00"))

    def test_unknown_course_fails(self):
        from django.core.management.base import CommandError

        with self.assertRaises(CommandError):
            call_command("seed_batch_pricing", "--course", "999999", stdout=StringIO())


class BillingAdminTests(TestCase):
    URLS = ("product", "price", "plan", "purchase", "entitlementgrant", "entitlementkey")

    def test_only_permitted_staff_reach_the_billing_admin(self):
        student = f.make_user()
        self.client.force_login(student)
        response = self.client.get(reverse("admin:billing_plan_changelist"))
        self.assertEqual(response.status_code, 302)  # not staff: sent to the admin login

        staff = f.make_user(is_staff=True)
        self.client.force_login(staff)
        self.assertEqual(self.client.get(reverse("admin:billing_plan_changelist")).status_code, 403)
        staff.user_permissions.add(Permission.objects.get(codename="view_plan", content_type__app_label="billing"))
        self.assertEqual(self.client.get(reverse("admin:billing_plan_changelist")).status_code, 200)
        self.assertEqual(self.client.get(reverse("admin:billing_purchase_changelist")).status_code, 403)

    def test_superuser_sees_every_billing_screen_and_can_grant_manually(self):
        admin_user = f.make_admin()
        self.client.force_login(admin_user)
        course = f.make_course()
        seed_batch_pricing(course.pk, apply=True)
        for name in self.URLS:
            self.assertEqual(self.client.get(reverse(f"admin:billing_{name}_changelist")).status_code, 200, name)
        plan = Plan.objects.first()
        self.assertEqual(self.client.get(reverse("admin:billing_plan_change", args=[plan.pk])).status_code, 200)
        self.assertEqual(self.client.get(reverse("admin:billing_product_change", args=[plan.product_id])).status_code,
                         200)
        self.assertEqual(self.client.get(reverse("admin:billing_purchase_add")).status_code, 403)

        student = f.make_user()
        now = timezone.now()
        response = self.client.post(
            reverse("admin:billing_entitlementgrant_add"),
            {
                "user": student.pk,
                "key": f"course_access:{course.pk}",
                "starts_at_0": now.strftime("%Y-%m-%d"),
                "starts_at_1": (now - timedelta(minutes=1)).strftime("%H:%M:%S"),
                "ends_at_0": "",
                "ends_at_1": "",
                "note": "Scholarship",
            },
        )
        self.assertEqual(response.status_code, 302, getattr(response, "context_data", {}) and response.context_data.get("errors"))
        grant = EntitlementGrant.objects.get(user=student)
        self.assertEqual(grant.granted_by, admin_user)
        self.assertTrue(Enrollment.objects.filter(active_enrollment_q(), user=student, course=course).exists())

        response = self.client.post(
            reverse("admin:billing_entitlementgrant_changelist"),
            {"action": "revoke_selected", "_selected_action": [grant.pk]},
        )
        self.assertEqual(response.status_code, 302)
        grant.refresh_from_db()
        self.assertIsNotNone(grant.revoked_at)
        self.assertEqual(grant.revoked_by, admin_user)
        self.assertFalse(Enrollment.objects.filter(active_enrollment_q(), user=student, course=course).exists())

    def test_price_edited_in_the_admin_applies_to_the_next_quote(self):
        admin_user = f.make_admin()
        self.client.force_login(admin_user)
        plan = make_plan(amount="1000.00")
        price = plan.price
        response = self.client.post(
            reverse("admin:billing_price_change", args=[price.pk]),
            {
                "product": price.product_id,
                "label": "",
                "amount": "1100.00",
                "currency": "INR",
                "billing_type": Price.RECURRING,
                "interval": Price.MONTH,
                "interval_count": 1,
                "access_days": 30,
                "is_active": "on",
                "valid_from_0": "",
                "valid_from_1": "",
                "valid_to_0": "",
                "valid_to_1": "",
                "sort_order": 0,
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(billing.quote(plan.pk).amount, "1100.00")
