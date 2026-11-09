from decimal import Decimal
from unittest.mock import patch

from django.test import override_settings
from django.urls import reverse
from django.utils import timezone

from apps.courses.models import Course, Enrollment
from apps.payments.models import BatchPass, Payment
from apps.payments.provisioning import provision_paid_payment
from apps.users.models import User
from tests import test_api as api_tests
from tests.test_api import BaseAPITestCase, mark_terms_accepted, razorpay_created_order


@override_settings(
    DIRECT_COURSE_PAYMENTS_ENABLED=True,
    RAZORPAY_KEY_ID="rzp_test_public",
    RAZORPAY_KEY_SECRET="test-secret",
    PAYMENT_SUPPORT_WHATSAPP_NUMBER="919970875040",
)
class BatchIVPaymentPlansTests(BaseAPITestCase):
    """Batch IV: 1500 x 3 EMI, 3500 lifetime, 4500 lifetime + every future batch."""

    checkout_payload = api_tests.PaymentVerificationTests.checkout_payload

    def setUp(self):
        super().setUp()
        self.client.defaults["HTTP_IDEMPOTENCY_KEY"] = f"test-checkout-{self._testMethodName}"
        self.course.monthly_price = Decimal("1500.00")
        self.course.installments_required = 3
        self.course.price = Decimal("3500.00")
        self.course.batch_pass_payment_enabled = True
        self.course.batch_pass_price = Decimal("4500.00")
        self.course.included_in_batch_pass = True
        self.course.save()

    def make_course(self, title, **fields):
        defaults = {
            "description": "Future batch",
            "price": Decimal("3500.00"),
            "is_published": True,
            "instructor": self.instructor,
        }
        defaults.update(fields)
        return Course.objects.create(title=title, **defaults)

    def paid_payment(self, plan, user=None, course=None, amount="4500.00"):
        return Payment.objects.create(
            user=user or self.student,
            course=course or self.course,
            amount=Decimal(amount),
            plan=plan,
            status=Payment.STATUS_PAID,
            paid_at=timezone.now(),
            razorpay_order_id=f"order_{plan}_{Payment.objects.count()}",
            razorpay_payment_id=f"pay_{plan}_{Payment.objects.count()}",
            buyer_name="Test Student",
            buyer_email="buyer@example.com",
        )

    @patch("apps.payments.views.create_razorpay_order")
    def test_each_plan_charges_its_admin_price(self, mock_create_order):
        mock_create_order.side_effect = lambda **kwargs: razorpay_created_order("order_plan", **kwargs)
        expected = {"monthly": 150000, "full": 350000, "batch_pass": 450000}

        for plan, paise in expected.items():
            buyer = User.objects.create_user(
                email=f"{plan}@test.com", password="StrongPass@123", full_name="Buyer", role=User.ROLE_STUDENT
            )
            mark_terms_accepted(buyer)
            self.login(buyer.email)
            self.client.defaults["HTTP_IDEMPOTENCY_KEY"] = f"batch-iv-{plan}"
            response = self.client.post(reverse("payment-create-order"), self.checkout_payload(plan=plan), format="json")
            self.assertEqual(response.status_code, 201, (plan, response.data))
            self.assertEqual(response.data["data"]["amount"], paise)

    def test_pass_plan_is_refused_when_not_offered(self):
        self.course.batch_pass_payment_enabled = False
        self.course.save(update_fields=["batch_pass_payment_enabled"])
        self.login(self.student.email)

        response = self.client.post(
            reverse("payment-create-order"), self.checkout_payload(plan="batch_pass"), format="json"
        )

        self.assertEqual(response.status_code, 400)

    def test_monthly_emi_becomes_lifetime_after_the_third_payment(self):
        for _ in range(3):
            provision_paid_payment(self.paid_payment(Payment.PLAN_MONTHLY, amount="1500.00"))
            enrollment = Enrollment.objects.get(user=self.student, course=self.course)

        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_LIFETIME)
        self.assertEqual(enrollment.installments_paid, 3)
        self.assertFalse(BatchPass.objects.exists())

    def test_one_time_plan_does_not_include_future_batches(self):
        provision_paid_payment(self.paid_payment(Payment.PLAN_FULL, amount="3500.00"))
        with self.captureOnCommitCallbacks(execute=True):
            batch_v = self.make_course("OSINT Batch V", included_in_batch_pass=True)

        self.assertTrue(Enrollment.objects.get(user=self.student, course=self.course).has_active_access())
        self.assertFalse(Enrollment.objects.filter(user=self.student, course=batch_v).exists())

    def test_pass_grants_this_batch_and_existing_included_batches(self):
        earlier = self.make_course("OSINT Batch III", included_in_batch_pass=True)
        excluded = self.make_course("Web Pentesting", included_in_batch_pass=False)

        provision_paid_payment(self.paid_payment(Payment.PLAN_BATCH_PASS))

        self.assertTrue(BatchPass.objects.filter(user=self.student, is_active=True).exists())
        for course in (self.course, earlier):
            enrollment = Enrollment.objects.get(user=self.student, course=course)
            self.assertEqual(enrollment.access_type, Enrollment.ACCESS_LIFETIME)
        self.assertFalse(Enrollment.objects.filter(user=self.student, course=excluded).exists())

    def test_future_batch_unlocks_for_holders_when_published(self):
        provision_paid_payment(self.paid_payment(Payment.PLAN_BATCH_PASS))
        with self.captureOnCommitCallbacks(execute=True):
            batch_v = self.make_course("OSINT Batch V", included_in_batch_pass=True, is_published=False)
        self.assertFalse(Enrollment.objects.filter(user=self.student, course=batch_v).exists())

        batch_v.is_published = True
        with self.captureOnCommitCallbacks(execute=True):
            batch_v.save()

        enrollment = Enrollment.objects.get(user=self.student, course=batch_v)
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_LIFETIME)
        self.assertTrue(enrollment.has_active_access())

    def test_pass_upgrades_a_running_emi_to_lifetime(self):
        provision_paid_payment(self.paid_payment(Payment.PLAN_MONTHLY, amount="1500.00"))
        self.assertEqual(Enrollment.objects.get(user=self.student, course=self.course).access_type, Enrollment.ACCESS_INSTALLMENT)

        provision_paid_payment(self.paid_payment(Payment.PLAN_BATCH_PASS))

        enrollment = Enrollment.objects.get(user=self.student, course=self.course)
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_LIFETIME)
        self.assertIsNone(enrollment.access_expires_at)

    def test_deactivated_pass_stops_granting_new_batches(self):
        provision_paid_payment(self.paid_payment(Payment.PLAN_BATCH_PASS))
        BatchPass.objects.update(is_active=False)
        with self.captureOnCommitCallbacks(execute=True):
            batch_v = self.make_course("OSINT Batch V", included_in_batch_pass=True)

        self.assertFalse(Enrollment.objects.filter(user=self.student, course=batch_v).exists())

    def test_provisioning_retries_do_not_duplicate_the_pass(self):
        payment = self.paid_payment(Payment.PLAN_BATCH_PASS)
        provision_paid_payment(payment)
        provision_paid_payment(payment)

        self.assertEqual(BatchPass.objects.filter(payment=payment).count(), 1)

    @patch("apps.payments.views.create_razorpay_order")
    def test_lifetime_students_may_upgrade_but_pass_holders_are_already_enrolled(self, mock_create_order):
        mock_create_order.side_effect = lambda **kwargs: razorpay_created_order("order_upgrade", **kwargs)
        provision_paid_payment(self.paid_payment(Payment.PLAN_FULL, amount="3500.00"))
        self.login(self.student.email)

        upgrade = self.client.post(reverse("payment-create-order"), self.checkout_payload(plan="batch_pass"), format="json")
        self.assertEqual(upgrade.status_code, 201)

        provision_paid_payment(self.paid_payment(Payment.PLAN_BATCH_PASS))
        self.client.defaults["HTTP_IDEMPOTENCY_KEY"] = "after-pass"
        again = self.client.post(reverse("payment-create-order"), self.checkout_payload(plan="batch_pass"), format="json")
        self.assertTrue(again.data["data"]["already_enrolled"])
