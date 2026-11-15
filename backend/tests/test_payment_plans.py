"""Admin-configurable payment cards, end to end.

Admin config (Course change form) -> course API cards -> create-order charges the
configured price -> Razorpay verify (mocked gateway) -> provisioning grants the
plan's access -> refund webhook revokes it. Plus the price-change rule: an
order's amount is fixed when it is created; later catalog edits never change,
double-charge or reject it.
"""

import hashlib
import hmac
import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from apps.courses.access import user_has_course_access
from apps.courses.models import Course, Enrollment
from apps.payments import plans
from apps.payments.models import BatchPass, Payment
from apps.payments.provisioning import provision_paid_payment
from apps.payments.serializers import CreateOrderSerializer
from apps.users.models import User
from django import forms
from django.core.exceptions import ValidationError
from django.test import Client, SimpleTestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from tests import test_api as api_tests
from tests.test_api import BaseAPITestCase, mark_terms_accepted, razorpay_created_order

WEBHOOK_SECRET = "whsec_payment_plans"
PAYMENT_SETTINGS = {
    "DIRECT_COURSE_PAYMENTS_ENABLED": True,
    "RAZORPAY_KEY_ID": "rzp_test_public",
    "RAZORPAY_KEY_SECRET": "test-secret",
    "RAZORPAY_WEBHOOK_SECRET": WEBHOOK_SECRET,
}


def admin_form_post_data(response):
    """The change form's current values, as the browser would submit them."""
    form = response.context["adminform"].form
    data = {}
    for bound in form:
        field = bound.field
        if isinstance(field, forms.FileField):
            continue
        value = bound.value()
        widget = field.widget
        if isinstance(widget, forms.MultiWidget):
            parts = value if isinstance(value, (list, tuple)) else widget.decompress(value)
            for index, part in enumerate(parts):
                data[f"{bound.html_name}_{index}"] = "" if part is None else str(part)
            continue
        if isinstance(field, forms.BooleanField):
            if value:
                data[bound.html_name] = "on"
            continue
        data[bound.html_name] = "" if value is None else str(value)
    for inline in response.context["inline_admin_formsets"]:
        formset = inline.formset
        data[f"{formset.prefix}-TOTAL_FORMS"] = "0"
        data[f"{formset.prefix}-INITIAL_FORMS"] = "0"
        data[f"{formset.prefix}-MIN_NUM_FORMS"] = "0"
        data[f"{formset.prefix}-MAX_NUM_FORMS"] = "1000"
    return data


class PaymentPlanTestMixin:
    checkout_payload = api_tests.PaymentVerificationTests.checkout_payload

    def configure_batch_iv(self, course=None):
        course = course or self.course
        course.price = Decimal("3500.00")
        course.full_payment_enabled = True
        course.installment_payment_enabled = True
        course.monthly_price = Decimal("1500.00")
        course.installments_required = 3
        course.installment_access_days = 30
        course.batch_pass_payment_enabled = True
        course.batch_pass_price = Decimal("4500.00")
        course.included_in_batch_pass = True
        course.save()
        return course

    def course_detail(self, client=None, course=None):
        response = (client or self.client).get(reverse("course-detail", args=[(course or self.course).pk]))
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["data"]

    def card(self, plan, client=None):
        cards = {card["plan"]: card for card in self.course_detail(client)["payment_plans"]}
        return cards[plan]

    # -- admin -------------------------------------------------------------

    def admin_client(self):
        if not hasattr(self, "_admin_client"):
            superuser = User.objects.create_superuser(
                email="plans-admin@example.com", password="StrongAdmin@123", full_name="Plans Admin"
            )
            self._admin_client = Client()
            self._admin_client.force_login(superuser)
        return self._admin_client

    def admin_change_url(self, course=None):
        return reverse("admin:courses_course_change", args=[(course or self.course).pk])

    def admin_post(self, changes, course=None):
        client = self.admin_client()
        page = client.get(self.admin_change_url(course))
        self.assertEqual(page.status_code, 200)
        data = admin_form_post_data(page)
        for name, value in changes.items():
            if value is False or value is None:
                data.pop(name, None)
            elif value is True:
                data[name] = "on"
            else:
                data[name] = str(value)
        data["_save"] = "Save"
        return client.post(self.admin_change_url(course), data)

    def assert_admin_saved(self, response):
        if response.status_code != 302:
            form = response.context["adminform"].form
            self.fail(f"admin save failed: {form.errors.as_data()}")

    def admin_errors(self, response):
        self.assertEqual(response.status_code, 200)
        form = response.context["adminform"].form
        return form.errors

    # -- gateway -----------------------------------------------------------

    def create_order(self, plan, key, **overrides):
        return self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(plan=plan, **overrides),
            format="json",
            HTTP_IDEMPOTENCY_KEY=key,
        )

    def verify(self, payment, payment_id, *, captured_paise=None):
        captured = {
            "id": payment_id,
            "order_id": payment.razorpay_order_id,
            "status": "captured",
            "amount": int(payment.amount * 100) if captured_paise is None else captured_paise,
            "currency": "INR",
            "method": "upi",
        }
        with patch("apps.payments.views.verify_razorpay_signature", return_value=True), patch(
            "apps.payments.views.fetch_razorpay_payment", return_value=captured
        ):
            return self.client.post(
                reverse("payment-verify"),
                {
                    "course_id": payment.course_id,
                    "checkout_reference": str(payment.internal_reference),
                    "razorpay_order_id": payment.razorpay_order_id,
                    "razorpay_payment_id": payment_id,
                    "razorpay_signature": f"sig_{payment_id}",
                },
                format="json",
            )

    def refund_webhook(self, payment):
        amount_paise = int(Decimal(payment.amount) * 100)
        payload = {
            "entity": "event",
            "event": "refund.processed",
            "payload": {
                "refund": {
                    "entity": {
                        "id": f"rfnd_{payment.razorpay_payment_id}",
                        "entity": "refund",
                        "amount": amount_paise,
                        "currency": "INR",
                        "payment_id": payment.razorpay_payment_id,
                        "status": "processed",
                    }
                },
                "payment": {
                    "entity": {
                        "id": payment.razorpay_payment_id,
                        "entity": "payment",
                        "order_id": payment.razorpay_order_id,
                        "amount": amount_paise,
                        "currency": "INR",
                        "status": "refunded",
                        "amount_refunded": amount_paise,
                        "refund_status": "full",
                        "captured": True,
                    }
                },
            },
        }
        body = json.dumps(payload).encode("utf-8")
        signature = hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()
        return self.client.post(
            reverse("payment-webhook"),
            data=body,
            content_type="application/json",
            HTTP_X_RAZORPAY_SIGNATURE=signature,
            HTTP_X_RAZORPAY_EVENT_ID=f"evt_refund_{payment.razorpay_payment_id}",
        )


@override_settings(**PAYMENT_SETTINGS)
class PaymentCardDefaultsTests(PaymentPlanTestMixin, BaseAPITestCase):
    """Courses never configured in the new admin section render today's cards."""

    def setUp(self):
        super().setUp()
        self.configure_batch_iv()

    def test_default_cards_reproduce_the_previous_plan_picker(self):
        data = self.course_detail()

        self.assertEqual(data["payment_cards_per_row"], 3)
        feature_titles = [item["title"] for item in self.course.course_card_features][:4]
        self.assertEqual(
            data["payment_plans"],
            [
                {
                    "plan": "monthly",
                    "title": "Monthly",
                    "subtitle": "3 monthly payments",
                    "amount": "1500.00",
                    "currency": "INR",
                    "price_label": "₹1,500 / month",
                    "total_label": "₹4,500 total over 3 months",
                    "installments": 3,
                    "access_label": "30-day access per installment",
                    "features": feature_titles,
                    "badge": None,
                    "highlighted": False,
                    "cta_label": "Enroll Now",
                    "order": 1,
                    "available": True,
                    "unavailable_reason": None,
                },
                {
                    "plan": "full",
                    "title": "One-Time",
                    "subtitle": "Paid once",
                    "amount": "3500.00",
                    "currency": "INR",
                    "price_label": "₹3,500 one payment",
                    "total_label": None,
                    "installments": None,
                    "access_label": "Lifetime access",
                    "features": feature_titles,
                    "badge": "Lifetime access",
                    "highlighted": True,
                    "cta_label": "Enroll Now",
                    "order": 2,
                    "available": True,
                    "unavailable_reason": None,
                },
                {
                    "plan": "batch_pass",
                    "title": "All Future Batches",
                    "subtitle": "Paid once",
                    "amount": "4500.00",
                    "currency": "INR",
                    "price_label": "₹4,500 one payment",
                    "total_label": None,
                    "installments": None,
                    "access_label": "Lifetime access + every future batch",
                    "features": feature_titles,
                    "badge": None,
                    "highlighted": False,
                    "cta_label": "Enroll Now",
                    "order": 3,
                    "available": True,
                    "unavailable_reason": None,
                },
            ],
        )
        # Backward compatibility: the fields older clients read are unchanged.
        self.assertEqual(data["price"], "3500.00")
        self.assertEqual(data["monthly_price"], "1500.00")
        self.assertTrue(data["purchase_available"])
        self.assertEqual(data["purchase_unavailable_reason"], "")

    def test_bundle_card_defaults_follow_its_access_window(self):
        self.course.bundle_payment_enabled = True
        self.course.bundle_price = Decimal("10999.00")
        self.course.bundle_installments = 2
        self.course.bundle_access_days = 90
        self.course.save()

        bundle = self.card("bundle")
        self.assertEqual(bundle["title"], "3-Month Bundle")
        self.assertEqual(bundle["subtitle"], "2 bundle payments")
        self.assertEqual(bundle["price_label"], "₹10,999 / installment")
        self.assertEqual(bundle["total_label"], "₹21,998 total over 2 installments")
        self.assertEqual(bundle["installments"], 2)
        self.assertEqual(bundle["access_label"], "90-day access window")
        self.assertEqual(bundle["order"], 3)
        self.assertEqual(self.course_detail()["payment_cards_per_row"], 4)

        self.course.bundle_access_days = 60
        self.course.save()
        self.assertEqual(self.card("bundle")["title"], "60-Day Bundle")

    def test_course_without_catalog_features_uses_the_fallback_bullets(self):
        Course.objects.filter(pk=self.course.pk).update(course_card_features=[])

        self.assertEqual(self.card("full")["features"], list(plans.FALLBACK_CARD_FEATURES))

    def test_disabled_and_unpriced_plans_are_not_shown(self):
        Course.objects.filter(pk=self.course.pk).update(batch_pass_price=Decimal("0.00"))

        data = self.course_detail()
        self.assertEqual([card["plan"] for card in data["payment_plans"]], ["monthly", "full"])
        self.assertEqual(data["payment_cards_per_row"], 2)

    def test_no_cards_means_pricing_will_be_announced(self):
        Course.objects.filter(pk=self.course.pk).update(
            full_payment_enabled=False, installment_payment_enabled=False, batch_pass_payment_enabled=False
        )

        data = self.course_detail()
        self.assertEqual(data["payment_plans"], [])
        self.assertEqual(data["payment_cards_per_row"], 2)
        self.assertFalse(data["purchase_available"])
        self.assertEqual(data["purchase_unavailable_reason"], "price_not_configured")


@override_settings(**PAYMENT_SETTINGS)
class PaymentCardOverridesTests(PaymentPlanTestMixin, BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.configure_batch_iv()

    def test_stored_overrides_shape_the_cards_and_their_order(self):
        self.course.payment_cards = {
            "batch_pass": {
                "title": "Every Batch Forever",
                "subtitle": "Best for career switchers",
                "features": ["All future OSINT batches", "Lifetime recordings"],
                "badge": "Best value",
                "highlighted": True,
                "order": 1,
                "cta_label": "Get the pass",
            },
            "full": {"highlighted": False, "badge": "", "order": 3},
            "monthly": {"order": 2},
        }
        self.course.full_clean()
        self.course.save()

        data = self.course_detail()
        self.assertEqual([card["plan"] for card in data["payment_plans"]], ["batch_pass", "monthly", "full"])
        self.assertEqual([card["order"] for card in data["payment_plans"]], [1, 2, 3])
        first = data["payment_plans"][0]
        self.assertEqual(first["title"], "Every Batch Forever")
        self.assertEqual(first["subtitle"], "Best for career switchers")
        self.assertEqual(first["features"], ["All future OSINT batches", "Lifetime recordings"])
        self.assertEqual(first["badge"], "Best value")
        self.assertTrue(first["highlighted"])
        self.assertEqual(first["cta_label"], "Get the pass")
        # Prices and labels always come from the charged amount, never from card text.
        self.assertEqual(first["amount"], "4500.00")
        self.assertEqual(first["price_label"], "₹4,500 one payment")
        full = data["payment_plans"][2]
        self.assertIsNone(full["badge"])
        self.assertFalse(full["highlighted"])

    def test_positions_with_gaps_are_renumbered_for_display(self):
        self.course.payment_cards = {"full": {"order": 4}, "batch_pass": {"order": 3}}
        self.course.full_clean()
        self.course.save()

        data = self.course_detail()
        self.assertEqual([card["plan"] for card in data["payment_plans"]], ["monthly", "batch_pass", "full"])
        self.assertEqual([card["order"] for card in data["payment_plans"]], [1, 2, 3])

    def test_invalid_stored_values_fall_back_without_breaking_the_page(self):
        Course.objects.filter(pk=self.course.pk).update(
            payment_cards={
                "full": {"title": "<script>alert(1)</script>", "order": "x", "features": "Line"},
                "monthly": {"highlighted": True},
                "weekly": {"title": "ignored"},
            }
        )

        cards = self.course_detail()["payment_plans"]
        full = next(card for card in cards if card["plan"] == "full")
        self.assertEqual(full["title"], "One-Time")
        self.assertEqual(full["features"], ["Line"])
        # Two highlighted cards in stored data: only the first shown keeps it.
        self.assertEqual([card["plan"] for card in cards if card["highlighted"]], ["monthly"])


class PaymentCardValidationTests(PaymentPlanTestMixin, BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.configure_batch_iv()

    def assert_invalid(self, message_part, **changes):
        for field, value in changes.items():
            setattr(self.course, field, value)
        with self.assertRaises(ValidationError) as caught:
            self.course.full_clean()
        self.assertIn(message_part, " ".join(caught.exception.messages))

    def test_two_to_four_cards_or_none_are_valid(self):
        self.course.full_clean()  # 3 cards
        self.course.bundle_payment_enabled = True
        self.course.bundle_price = Decimal("2000.00")
        self.course.full_clean()  # 4 cards
        self.course.full_payment_enabled = False
        self.course.batch_pass_payment_enabled = False
        self.course.full_clean()  # 2 cards
        self.course.installment_payment_enabled = False
        self.course.bundle_payment_enabled = False
        self.course.full_clean()  # none: online purchase off

    def test_a_single_card_is_rejected(self):
        self.assert_invalid(
            "Show 2 to 4 payment cards",
            installment_payment_enabled=False,
            batch_pass_payment_enabled=False,
        )

    def test_an_enabled_card_needs_a_positive_price(self):
        self.assert_invalid("Bundle card: set a price above ₹0", bundle_payment_enabled=True)

    def test_only_one_card_may_be_highlighted(self):
        self.assert_invalid("Only one payment card can be highlighted", payment_cards={"monthly": {"highlighted": True}})

    def test_positions_must_be_unique_among_shown_cards(self):
        self.assert_invalid("Card position 2 is used by more than one card", payment_cards={"monthly": {"order": 2}})
        # A hidden card may keep any position.
        self.course.payment_cards = {"bundle": {"order": 1}}
        self.course.full_clean()

    def test_card_text_is_validated(self):
        self.assert_invalid("Unknown payment plan", payment_cards={"weekly": {"title": "x"}})
        self.assert_invalid("Unknown payment card setting", payment_cards={"full": {"price": "1"}})
        self.assert_invalid("at most 6 feature bullets", payment_cards={"full": {"features": [f"f{i}" for i in range(7)]}})
        self.assert_invalid("cannot exceed 60 characters", payment_cards={"full": {"title": "x" * 61}})
        self.assert_invalid("Suspicious script", payment_cards={"full": {"subtitle": "<script>alert(1)</script>"}})
        self.assert_invalid("position must be a whole number", payment_cards={"full": {"order": 9}})
        self.assert_invalid("highlighted must be true or false", payment_cards={"full": {"highlighted": "yes"}})

    def test_overrides_are_normalized_on_save(self):
        self.course.payment_cards = {"full": {"title": "  Pay   once  ", "features": ["  A ", "", "B"], "subtitle": ""}}
        self.course.full_clean()
        self.assertEqual(self.course.payment_cards, {"full": {"title": "Pay once", "features": ["A", "B"]}})

    def test_instructor_api_cannot_leave_an_enabled_card_unpriced(self):
        self.login(self.instructor.email)
        response = self.client.patch(
            reverse("course-detail", args=[self.course.pk]), {"price": "0.00"}, format="json"
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("set a price above ₹0", json.dumps(response.data["errors"], ensure_ascii=False))
        self.course.refresh_from_db()
        self.assertEqual(self.course.price, Decimal("3500.00"))


@override_settings(**PAYMENT_SETTINGS)
class CourseDetailContractTests(PaymentPlanTestMixin, BaseAPITestCase):
    def test_response_matches_the_documented_contract(self):
        from apps.courses.serializers import CourseDetailContractSerializer, PaymentPlanCardSerializer

        self.configure_batch_iv()
        data = self.course_detail()

        self.assertLessEqual(set(CourseDetailContractSerializer().fields), set(data))
        for card in data["payment_plans"]:
            self.assertEqual(set(card), set(PaymentPlanCardSerializer().fields))
            self.assertIn(card["plan"], plans.PLAN_IDS)
            self.assertEqual(card["currency"], "INR")
            self.assertRegex(card["amount"], r"^\d+\.\d{2}$")
        self.assertIn(data["payment_cards_per_row"], (2, 3, 4))


class PaymentPlanCatalogTests(SimpleTestCase):
    def test_inr_labels_use_indian_grouping_and_exact_paise(self):
        self.assertEqual(plans.format_inr(Decimal("999")), "₹999")
        self.assertEqual(plans.format_inr(Decimal("1500.00")), "₹1,500")
        self.assertEqual(plans.format_inr(Decimal("100000")), "₹1,00,000")
        self.assertEqual(plans.format_inr(Decimal("12345678.5")), "₹1,23,45,678.50")
        self.assertEqual(plans.to_paise(Decimal("1499.99")), 149999)
        self.assertEqual(plans.to_paise("4500"), 450000)

    def test_catalog_is_the_only_plan_list(self):
        self.assertEqual(set(CreateOrderSerializer().fields["plan"].choices), set(plans.PLAN_IDS))
        self.assertEqual(set(plans.PLAN_IDS), {code for code, _ in Payment.PLAN_CHOICES})
        self.assertEqual(set(plans.PERMANENT_PLANS), {"full", "batch_pass"})
        self.assertEqual(set(plans.INSTALLMENT_PLANS), {"monthly", "bundle"})

    def test_cards_per_row_is_two_to_four(self):
        self.assertEqual([plans.payment_cards_per_row(n) for n in range(6)], [2, 2, 2, 3, 4, 4])


@override_settings(**PAYMENT_SETTINGS)
class PaymentCardAvailabilityTests(PaymentPlanTestMixin, BaseAPITestCase):
    """available/unavailable_reason only ever describe the viewer's own account."""

    def setUp(self):
        super().setUp()
        self.configure_batch_iv()

    def availability(self):
        return {card["plan"]: (card["available"], card["unavailable_reason"]) for card in self.course_detail()["payment_plans"]}

    def give(self, user, plan, amount):
        number = Payment.objects.count() + 1
        payment = Payment.objects.create(
            user=user,
            course=self.course,
            amount=Decimal(amount),
            plan=plan,
            status=Payment.STATUS_PAID,
            paid_at=timezone.now(),
            razorpay_order_id=f"order_avail_{number}",
            razorpay_payment_id=f"pay_avail_{number}",
            buyer_name="Owner",
            buyer_email=user.email,
        )
        provision_paid_payment(payment)

    def test_guests_see_every_card_available_whatever_others_bought(self):
        self.give(self.student, Payment.PLAN_BATCH_PASS, "4500.00")

        self.assertEqual(
            self.availability(),
            {"monthly": (True, None), "full": (True, None), "batch_pass": (True, None)},
        )

    def test_owner_of_lifetime_access_may_only_upgrade_to_the_pass(self):
        self.give(self.student, Payment.PLAN_FULL, "3500.00")
        self.login(self.student.email)

        self.assertEqual(
            self.availability(),
            {
                "monthly": (False, plans.OWNS_LIFETIME_MESSAGE),
                "full": (False, plans.OWNS_COURSE_MESSAGE),
                "batch_pass": (True, None),
            },
        )

    def test_running_installment_plan_may_keep_paying(self):
        self.give(self.student, Payment.PLAN_MONTHLY, "1500.00")
        self.login(self.student.email)

        availability = self.availability()
        self.assertEqual(availability["monthly"], (True, None))
        self.assertEqual(availability["full"], (False, plans.OWNS_COURSE_MESSAGE))

    def test_pass_holder_cannot_buy_the_pass_again(self):
        self.give(self.student, Payment.PLAN_BATCH_PASS, "4500.00")
        self.login(self.student.email)

        self.assertEqual(self.availability()["batch_pass"], (False, plans.OWNS_PASS_MESSAGE))

    def test_instructor_cannot_buy_their_own_course(self):
        self.login(self.instructor.email)

        self.assertEqual(
            set(self.availability().values()), {(False, plans.INSTRUCTOR_OWN_COURSE_MESSAGE)}
        )

    def test_closed_course_cards_explain_why(self):
        Course.objects.filter(pk=self.course.pk).update(registration_closed=True)

        self.assertEqual(set(self.availability().values()), {(False, "Registration for this batch is closed.")})

    @override_settings(DIRECT_COURSE_PAYMENTS_ENABLED=False)
    def test_disabled_checkout_cards_explain_why(self):
        self.assertEqual(
            set(self.availability().values()), {(False, "Online enrollment is temporarily unavailable.")}
        )

    def test_a_signed_in_owner_never_changes_the_public_cached_cards(self):
        self.give(self.student, Payment.PLAN_FULL, "3500.00")
        anonymous = Client()
        self.assertTrue(self.card("full", client=anonymous)["available"])
        self.login(self.student.email)
        self.assertFalse(self.card("full")["available"])

        self.assertTrue(self.card("full", client=anonymous)["available"])


@override_settings(**PAYMENT_SETTINGS)
class PaymentCardAdminTests(PaymentPlanTestMixin, BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.configure_batch_iv()

    def test_change_form_has_one_section_per_card_with_live_count_and_preview(self):
        response = self.admin_client().get(self.admin_change_url())

        self.assertEqual(response.status_code, 200)
        for spec in plans.CATALOG:
            self.assertContains(response, f"Payment card: {spec.admin_label}")
        self.assertContains(response, "3 cards will show")
        self.assertContains(response, "data-payment-cards=")
        self.assertContains(response, "admin/js/course_payment_cards.js")
        self.assertContains(response, "₹1,500 / month")
        self.assertContains(response, "₹4,500 total over 3 months")
        self.assertContains(response, "hidden: Bundle")
        form = response.context["adminform"].form
        # List fields render as editable lines, not Python reprs the parsers reject.
        self.assertIn("live | Live Sessions | ", form["course_card_features"].value())
        self.assertEqual(form.fields["card_full_title"].initial, "One-Time")
        self.assertEqual(form.fields["card_full_badge"].initial, "Lifetime access")
        self.assertTrue(form.fields["card_full_highlighted"].initial)
        self.assertEqual(form.fields["card_monthly_order"].initial, 1)

    def test_admin_creates_a_course_with_default_cards(self):
        client = self.admin_client()
        add_url = reverse("admin:courses_course_add")
        page = client.get(add_url)
        self.assertContains(page, "Save the course to preview its payment cards.")
        data = admin_form_post_data(page)
        data.update(
            {
                "title": "OSINT Batch VI",
                "description": "Next batch",
                "price": "3500.00",
                "monthly_price": "1500.00",
                "_save": "Save",
            }
        )

        response = client.post(add_url, data)

        self.assert_admin_saved(response)
        course = Course.objects.get(title="OSINT Batch VI")
        self.assertEqual(course.payment_cards, {})
        self.assertEqual(
            [card["plan"] for card in self.course_detail(course=course)["payment_plans"]], ["monthly", "full"]
        )

    def test_saving_without_edits_stores_no_overrides(self):
        self.assert_admin_saved(self.admin_post({}))

        self.course.refresh_from_db()
        self.assertEqual(self.course.payment_cards, {})

    def test_admin_configures_price_count_and_every_card_setting(self):
        response = self.admin_post(
            {
                "bundle_payment_enabled": True,
                "bundle_price": "2000.00",
                "bundle_installments": "2",
                "bundle_access_days": "90",
                "card_bundle_title": "Quarter Pass",
                "card_bundle_badge": "Most popular",
                "card_bundle_features": "Two payments\nNinety days each\n\n",
                "card_bundle_cta_label": "Start now",
                "card_bundle_highlighted": True,
                "card_full_highlighted": False,
                "card_full_badge": "",
                "card_batch_pass_order": "3",
                "card_bundle_order": "4",
            }
        )

        self.assert_admin_saved(response)
        self.course.refresh_from_db()
        self.assertEqual(
            self.course.payment_cards,
            {
                "full": {"badge": "", "highlighted": False},
                "bundle": {
                    "title": "Quarter Pass",
                    "features": ["Two payments", "Ninety days each"],
                    "badge": "Most popular",
                    "highlighted": True,
                    "order": 4,
                    "cta_label": "Start now",
                },
                "batch_pass": {"order": 3},
            },
        )
        data = self.course_detail()
        self.assertEqual(data["payment_cards_per_row"], 4)
        self.assertEqual([card["plan"] for card in data["payment_plans"]], ["monthly", "full", "batch_pass", "bundle"])
        bundle = data["payment_plans"][3]
        self.assertEqual(bundle["amount"], "2000.00")
        self.assertEqual(bundle["total_label"], "₹4,000 total over 2 installments")
        self.assertEqual(bundle["badge"], "Most popular")
        self.assertTrue(bundle["highlighted"])
        self.assertIsNone(data["payment_plans"][1]["badge"])

    def test_blank_text_restores_the_automatic_default(self):
        self.assert_admin_saved(self.admin_post({"card_full_title": "Lifetime"}))
        self.assertEqual(self.card("full")["title"], "Lifetime")

        self.assert_admin_saved(self.admin_post({"card_full_title": ""}))

        self.course.refresh_from_db()
        self.assertEqual(self.course.payment_cards, {})
        self.assertEqual(self.card("full")["title"], "One-Time")

    def test_one_card_is_refused_with_a_clear_message(self):
        response = self.admin_post({"installment_payment_enabled": False, "batch_pass_payment_enabled": False})

        errors = self.admin_errors(response)
        self.assertIn("Show 2 to 4 payment cards", " ".join(errors["__all__"]))
        # The preview keeps showing what is saved, not the rejected submission.
        self.assertContains(response, "₹1,500 / month")
        self.course.refresh_from_db()
        self.assertTrue(self.course.installment_payment_enabled)

    def test_switching_every_card_off_turns_online_purchase_off(self):
        self.assert_admin_saved(
            self.admin_post(
                {
                    "installment_payment_enabled": False,
                    "full_payment_enabled": False,
                    "batch_pass_payment_enabled": False,
                }
            )
        )

        self.assertEqual(self.course_detail()["payment_plans"], [])

    def test_admin_errors_name_the_card_and_the_fix(self):
        unpriced = self.admin_errors(self.admin_post({"bundle_payment_enabled": True, "bundle_price": "0"}))
        self.assertIn("Bundle card: set a price above ₹0", " ".join(unpriced["__all__"]))

        two_highlights = self.admin_errors(self.admin_post({"card_monthly_highlighted": True}))
        self.assertIn("Only one payment card can be highlighted", " ".join(two_highlights["__all__"]))

        clash = self.admin_errors(self.admin_post({"card_full_order": "1"}))
        self.assertIn("Card position 1 is used by more than one card", " ".join(clash["__all__"]))

        too_many = self.admin_errors(self.admin_post({"card_full_features": "\n".join(f"Bullet {i}" for i in range(7))}))
        self.assertIn("at most 6 feature bullets", " ".join(too_many["card_full_features"]))

        script = self.admin_errors(self.admin_post({"card_monthly_subtitle": "<script>alert(1)</script>"}))
        self.assertIn("card_monthly_subtitle", script)

        self.course.refresh_from_db()
        self.assertEqual(self.course.payment_cards, {})

    def test_admin_price_edit_reaches_the_public_cached_course_page(self):
        anonymous = Client()
        self.assertEqual(self.card("monthly", client=anonymous)["amount"], "1500.00")

        self.assert_admin_saved(self.admin_post({"monthly_price": "1750.00"}))

        monthly = self.card("monthly", client=anonymous)
        self.assertEqual(monthly["amount"], "1750.00")
        self.assertEqual(monthly["total_label"], "₹5,250 total over 3 months")


@override_settings(**PAYMENT_SETTINGS)
class PaymentPlanPipelineTests(PaymentPlanTestMixin, BaseAPITestCase):
    """Every plan: admin config -> card -> order -> verify -> access -> refund."""

    def setUp(self):
        super().setUp()
        self.configure_batch_iv()
        with self.captureOnCommitCallbacks(execute=True):
            self.next_batch = Course.objects.create(
                title="OSINT Batch V",
                description="Next batch",
                price=Decimal("3500.00"),
                instructor=self.instructor,
                is_published=True,
                included_in_batch_pass=True,
            )
        self.assert_admin_saved(
            self.admin_post(
                {
                    "monthly_price": "1600.00",
                    "installments_required": "3",
                    "installment_access_days": "30",
                    "price": "3900.00",
                    "bundle_payment_enabled": True,
                    "bundle_price": "2100.00",
                    "bundle_installments": "2",
                    "bundle_access_days": "90",
                    "batch_pass_price": "4700.00",
                    "card_batch_pass_title": "Every Future Batch",
                }
            )
        )
        self.login(self.student.email)

    def buy(self, plan):
        card = self.card(plan)
        self.assertTrue(card["available"], card)
        with patch("apps.payments.views.create_razorpay_order") as gateway:
            gateway.side_effect = lambda **kwargs: razorpay_created_order(f"order_{plan}_pipeline", **kwargs)
            order = self.create_order(plan, key=f"pipeline-{plan}-0001")
        self.assertEqual(order.status_code, 201, order.data)
        self.assertEqual(order.data["data"]["amount"], plans.to_paise(card["amount"]))
        self.assertEqual(gateway.call_args.kwargs["amount_paise"], plans.to_paise(card["amount"]))
        payment = Payment.objects.get(razorpay_order_id=f"order_{plan}_pipeline")
        self.assertEqual(payment.amount, Decimal(card["amount"]))
        self.assertEqual(payment.plan, plan)
        self.assertEqual(payment.terms_snapshot["amount"], card["amount"])
        self.assertEqual(payment.terms_snapshot["title"], card["title"])

        verified = self.verify(payment, f"pay_{plan}_pipeline")
        self.assertEqual(verified.status_code, 200, verified.data)
        self.assertEqual(verified.data["data"]["amount"], card["amount"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        return payment

    def assert_refund_revokes(self, payment, *courses):
        response = self.refund_webhook(payment)
        self.assertEqual(response.status_code, 200, response.data)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        for course in courses:
            self.assertFalse(user_has_course_access(self.student, course.id), course.title)

    def test_monthly_installment(self):
        payment = self.buy("monthly")

        enrollment = Enrollment.objects.get(user=self.student, course=self.course)
        self.assertEqual(payment.amount, Decimal("1600.00"))
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_INSTALLMENT)
        self.assertEqual(enrollment.installments_paid, 1)
        self.assertAlmostEqual(
            enrollment.access_expires_at, timezone.now() + timedelta(days=30), delta=timedelta(minutes=5)
        )
        self.assertFalse(BatchPass.objects.exists())
        self.assert_refund_revokes(payment, self.course)

    def test_full_one_time(self):
        payment = self.buy("full")

        enrollment = Enrollment.objects.get(user=self.student, course=self.course)
        self.assertEqual(payment.amount, Decimal("3900.00"))
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_LIFETIME)
        self.assertIsNone(enrollment.access_expires_at)
        self.assertFalse(user_has_course_access(self.student, self.next_batch.id))
        self.assert_refund_revokes(payment, self.course)

    def test_bundle(self):
        payment = self.buy("bundle")

        enrollment = Enrollment.objects.get(user=self.student, course=self.course)
        self.assertEqual(payment.amount, Decimal("2100.00"))
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_INSTALLMENT)
        self.assertAlmostEqual(
            enrollment.access_expires_at, timezone.now() + timedelta(days=90), delta=timedelta(minutes=5)
        )
        self.assert_refund_revokes(payment, self.course)

    def test_batch_pass_all_future_batches(self):
        payment = self.buy("batch_pass")

        self.assertEqual(payment.amount, Decimal("4700.00"))
        self.assertTrue(BatchPass.objects.filter(user=self.student, payment=payment, is_active=True).exists())
        for course in (self.course, self.next_batch):
            enrollment = Enrollment.objects.get(user=self.student, course=course)
            self.assertEqual(enrollment.access_type, Enrollment.ACCESS_LIFETIME)
        # Bought: the card now says so, and only for this account.
        self.assertEqual(self.card("batch_pass")["unavailable_reason"], plans.OWNS_PASS_MESSAGE)
        self.assert_refund_revokes(payment, self.course, self.next_batch)
        self.assertFalse(BatchPass.objects.get(payment=payment).is_active)

    def test_disabled_plan_is_refused_with_a_clear_400(self):
        self.assert_admin_saved(self.admin_post({"bundle_payment_enabled": False}))
        self.assertNotIn("bundle", [card["plan"] for card in self.course_detail()["payment_plans"]])

        with patch("apps.payments.views.create_razorpay_order") as gateway:
            response = self.create_order("bundle", key="pipeline-disabled-0001")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["message"], "Payment plan unavailable.")
        self.assertIn("not offered for this course", response.data["errors"]["detail"])
        self.assertIn("bundle", response.data["errors"]["plan"][0])
        gateway.assert_not_called()
        self.assertFalse(Payment.objects.exists())

    def test_unknown_plan_is_refused(self):
        response = self.create_order("weekly", key="pipeline-unknown-0001")

        self.assertEqual(response.status_code, 400)
        self.assertIn("plan", response.data["errors"])


@override_settings(**PAYMENT_SETTINGS)
class PriceChangeMidCheckoutTests(PaymentPlanTestMixin, BaseAPITestCase):
    """An order's amount is fixed at create-order; later admin edits never touch it."""

    def setUp(self):
        super().setUp()
        self.configure_batch_iv()
        self.login(self.student.email)
        with patch("apps.payments.views.create_razorpay_order") as gateway:
            gateway.side_effect = lambda **kwargs: razorpay_created_order("order_before_edit", **kwargs)
            response = self.create_order("monthly", key="price-change-0001")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["data"]["amount"], 150000)
        self.payment = Payment.objects.get()
        self.assert_admin_saved(self.admin_post({"monthly_price": "2000.00", "installment_access_days": "45"}))
        self.assertEqual(self.card("monthly")["amount"], "2000.00")

    def test_legit_payment_at_the_old_price_is_verified_once(self):
        response = self.verify(self.payment, "pay_before_edit")

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["data"]["amount"], "1500.00")
        self.assertEqual(response.data["data"]["access_duration"], "30 days")
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_PAID)
        self.assertEqual(self.payment.amount, Decimal("1500.00"))
        self.assertEqual(Payment.objects.count(), 1)
        enrollment = Enrollment.objects.get(user=self.student, course=self.course)
        # Access terms come from the order's snapshot (30 days), not the new 45.
        self.assertAlmostEqual(
            enrollment.access_expires_at, timezone.now() + timedelta(days=30), delta=timedelta(minutes=5)
        )
        replay = self.verify(self.payment, "pay_before_edit")
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(Payment.objects.filter(status=Payment.STATUS_PAID).count(), 1)

    def test_capture_at_the_new_price_does_not_match_the_order(self):
        response = self.verify(self.payment, "pay_tampered", captured_paise=200000)

        self.assertEqual(response.status_code, 409)
        self.assertIn("amount does not match", response.data["errors"]["detail"])
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_CREATED)
        self.assertFalse(Enrollment.objects.filter(user=self.student, course=self.course).exists())

    @patch("apps.payments.views.fetch_razorpay_order")
    def test_a_stale_unpaid_order_is_not_resumed_or_duplicated(self, fetch_order):
        fetch_order.return_value = razorpay_created_order(
            self.payment.razorpay_order_id,
            amount_paise=150000,
            currency="INR",
            receipt=f"p-{self.payment.internal_reference.hex[:24]}",
        )
        with patch("apps.payments.views.create_razorpay_order") as gateway:
            response = self.create_order("monthly", key="price-change-0002")

        self.assertEqual(response.status_code, 409)
        self.assertIn("Do not pay this older order", response.data["errors"]["detail"])
        gateway.assert_not_called()
        self.assertEqual(Payment.objects.count(), 1)

    def test_new_checkouts_are_charged_the_new_price(self):
        buyer = User.objects.create_user(
            email="after-edit@test.com", password="StrongPass@123", full_name="After Edit", role=User.ROLE_STUDENT
        )
        mark_terms_accepted(buyer)
        self.login(buyer.email)
        with patch("apps.payments.views.create_razorpay_order") as gateway:
            gateway.side_effect = lambda **kwargs: razorpay_created_order("order_after_edit", **kwargs)
            response = self.create_order("monthly", key="price-change-0003", buyer_email="after-edit@test.com")

        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["data"]["amount"], 200000)
        new_payment = Payment.objects.get(razorpay_order_id="order_after_edit")
        self.assertEqual(new_payment.terms_snapshot["access_days"], 45)
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.amount, Decimal("1500.00"))
