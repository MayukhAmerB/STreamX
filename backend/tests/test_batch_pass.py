from decimal import Decimal
from unittest.mock import patch

from django.contrib import admin as django_admin
from django.contrib.messages.storage.fallback import FallbackStorage
from django.test import RequestFactory, override_settings
from django.urls import reverse
from django.utils import timezone

from apps.courses.access import user_has_course_access
from apps.courses.admin import CourseAdmin, CourseAdminForm
from apps.courses.models import Course, Enrollment
from apps.payments.admin import BatchPassAdmin
from apps.payments.models import BatchPass, Payment
from apps.payments.provisioning import provision_paid_payment
from apps.payments.refunds import record_refund
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


def _offer_batch_iv_pass(course):
    course.monthly_price = Decimal("1500.00")
    course.installments_required = 3
    course.price = Decimal("3500.00")
    course.batch_pass_payment_enabled = True
    course.batch_pass_price = Decimal("4500.00")
    course.included_in_batch_pass = True
    course.save()


def _paid(plan, *, user, course, amount, buyer_email="buyer@example.com"):
    number = Payment.objects.count() + 1
    payment = Payment.objects.create(
        user=user,
        course=course,
        amount=Decimal(amount),
        plan=plan,
        status=Payment.STATUS_PAID,
        paid_at=timezone.now(),
        razorpay_order_id=f"order_{plan}_{number}",
        razorpay_payment_id=f"pay_{plan}_{number}",
        buyer_name="Test Student",
        buyer_email=buyer_email,
    )
    provision_paid_payment(payment)
    payment.refresh_from_db()
    return payment


class BatchPassInclusionAdminTests(api_tests.BaseAPITestCase):
    """Ticking or unticking 'Included in batch pass' is deliberate and reversible."""

    def setUp(self):
        super().setUp()
        _offer_batch_iv_pass(self.course)
        self.holder = self.student
        _paid(Payment.PLAN_BATCH_PASS, user=self.holder, course=self.course, amount="4500.00")
        self.paying_holder = User.objects.create_user(
            email="paying-holder@test.com", password="StrongPass@123", full_name="Paying Holder", role=User.ROLE_STUDENT
        )
        _paid(Payment.PLAN_BATCH_PASS, user=self.paying_holder, course=self.course, amount="4500.00")
        with self.captureOnCommitCallbacks(execute=True):
            self.batch_v = Course.objects.create(
                title="OSINT Batch V",
                description="Future batch",
                price=Decimal("3500.00"),
                is_published=True,
                instructor=self.instructor,
                included_in_batch_pass=True,
            )
        _paid(Payment.PLAN_FULL, user=self.paying_holder, course=self.batch_v, amount="3500.00")
        self.superuser = User.objects.create_superuser(
            email="pass-admin@example.com", password="StrongAdmin@123", full_name="Pass Admin"
        )

    def form(self, course, **data):
        return CourseAdminForm(data=data, instance=course)

    def admin_save(self, course, form):
        request = RequestFactory().post("/admin/courses/course/")
        request.user = self.superuser
        request.session = {}
        request._messages = FallbackStorage(request)
        with self.captureOnCommitCallbacks(execute=True):
            CourseAdmin(Course, django_admin.site).save_model(request, course, form, change=True)

    def test_ticking_requires_confirmation_naming_current_holders(self):
        course = Course.objects.create(
            title="OSINT Batch VI", description="Next", price=Decimal("3500.00"), instructor=self.instructor
        )

        unconfirmed = self.form(course, included_in_batch_pass="on")
        confirmed = self.form(course, included_in_batch_pass="on", confirm_batch_pass_change="on")

        self.assertEqual(unconfirmed.fields["confirm_batch_pass_change"].label, "Grant this course to 2 current pass holders")
        self.assertIn("confirm_batch_pass_change", unconfirmed.errors)
        self.assertNotIn("confirm_batch_pass_change", confirmed.errors)

    def test_creating_an_included_course_requires_confirmation(self):
        form = CourseAdminForm(data={"included_in_batch_pass": "on"})

        self.assertIn("confirm_batch_pass_change", form.errors)

    def test_unticking_requires_confirmation(self):
        unconfirmed = self.form(self.batch_v)
        confirmed = self.form(self.batch_v, confirm_batch_pass_change="on")

        self.assertEqual(unconfirmed.fields["confirm_batch_pass_change"].label, "Revoke this course from 2 current pass holders")
        self.assertIn("confirm_batch_pass_change", unconfirmed.errors)
        self.assertNotIn("confirm_batch_pass_change", confirmed.errors)

    def test_no_confirmation_needed_without_pass_holders_or_changes(self):
        BatchPass.objects.update(is_active=False)
        self.assertNotIn("confirm_batch_pass_change", self.form(self.batch_v).errors)

        BatchPass.objects.update(is_active=True)
        self.assertNotIn("confirm_batch_pass_change", self.form(self.batch_v, included_in_batch_pass="on").errors)

    def test_unticking_revokes_only_pass_backed_enrollments_and_is_reversible(self):
        self.assertTrue(user_has_course_access(self.holder, self.batch_v.id))
        form = self.form(self.batch_v, confirm_batch_pass_change="on")
        self.batch_v.included_in_batch_pass = False

        with patch("apps.courses.admin.log_security_event") as log_event:
            self.admin_save(self.batch_v, form)

        self.assertFalse(user_has_course_access(self.holder, self.batch_v.id))
        self.assertEqual(
            Enrollment.objects.get(user=self.holder, course=self.batch_v).payment_status, Enrollment.STATUS_FAILED
        )
        self.assertTrue(user_has_course_access(self.paying_holder, self.batch_v.id))
        self.assertTrue(user_has_course_access(self.holder, self.course.id))
        log_event.assert_called_once()
        self.assertEqual(log_event.call_args.args[0], "admin.batch_pass_course_excluded")
        self.assertEqual(log_event.call_args.kwargs["course_id"], self.batch_v.id)
        self.assertEqual(log_event.call_args.kwargs["revoked"], 1)
        self.assertEqual(log_event.call_args.kwargs["request"].user, self.superuser)

        self.batch_v.included_in_batch_pass = True
        regrant_form = self.form(self.batch_v, included_in_batch_pass="on", confirm_batch_pass_change="on")
        with patch("apps.courses.admin.log_security_event") as log_event:
            self.admin_save(self.batch_v, regrant_form)

        self.assertTrue(user_has_course_access(self.holder, self.batch_v.id))
        self.assertEqual(log_event.call_args.args[0], "admin.batch_pass_course_included")
        self.assertEqual(log_event.call_args.kwargs["granted"], 1)

    def test_unticking_keeps_emi_access_the_student_paid_for(self):
        emi_holder = User.objects.create_user(
            email="emi-holder@test.com", password="StrongPass@123", full_name="EMI Holder", role=User.ROLE_STUDENT
        )
        self.batch_v.monthly_price = Decimal("1500.00")
        self.batch_v.save(update_fields=["monthly_price"])
        installment = _paid(Payment.PLAN_MONTHLY, user=emi_holder, course=self.batch_v, amount="1500.00")
        _paid(Payment.PLAN_BATCH_PASS, user=emi_holder, course=self.course, amount="4500.00")
        self.assertEqual(
            Enrollment.objects.get(user=emi_holder, course=self.batch_v).access_type, Enrollment.ACCESS_LIFETIME
        )

        self.batch_v.included_in_batch_pass = False
        self.admin_save(self.batch_v, self.form(self.batch_v, confirm_batch_pass_change="on"))

        enrollment = Enrollment.objects.get(user=emi_holder, course=self.batch_v)
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_INSTALLMENT)
        self.assertEqual(enrollment.access_expires_at, installment.access_expires_at)

    def test_ending_a_pass_in_admin_revokes_pass_only_courses(self):
        batch_pass = BatchPass.objects.get(user=self.holder)
        batch_pass.is_active = False
        request = RequestFactory().post("/admin/payments/batchpass/")
        request.user = self.superuser

        BatchPassAdmin(BatchPass, django_admin.site).save_model(request, batch_pass, None, change=True)

        self.assertFalse(user_has_course_access(self.holder, self.batch_v.id))
        # The pass payment itself is still paid, so its source course stays.
        self.assertTrue(user_has_course_access(self.holder, self.course.id))


@override_settings(
    DIRECT_COURSE_PAYMENTS_ENABLED=True,
    RAZORPAY_KEY_ID="rzp_test_public",
    RAZORPAY_KEY_SECRET="test-secret",
)
class GuestOneTimeEntitlementTests(api_tests.BaseAPITestCase):
    """Guest checkout never discloses what an email owns, and never grants a one-time
    entitlement twice: a captured duplicate is flagged for an admin refund instead."""

    checkout_payload = api_tests.PaymentVerificationTests.checkout_payload

    def setUp(self):
        super().setUp()
        _offer_batch_iv_pass(self.course)
        self.client.defaults["HTTP_IDEMPOTENCY_KEY"] = f"guest-{self._testMethodName}"

    def guest_checkout(self, plan, **overrides):
        return self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(plan=plan, **overrides),
            format="json",
        )

    def guest_purchase(self, plan, amount, email="buyer@example.com", suffix=""):
        payment = Payment.objects.create(
            course=self.course,
            amount=Decimal(amount),
            plan=plan,
            status=Payment.STATUS_PAID,
            paid_at=timezone.now(),
            razorpay_order_id=f"order_guest_{plan}{suffix}",
            razorpay_payment_id=f"pay_guest_{plan}{suffix}",
            buyer_name="Guest Buyer",
            buyer_email=email,
        )
        provision_paid_payment(payment)
        payment.refresh_from_db()
        return payment

    def assert_flagged_duplicate(self, payment, *, users_before, passes_before):
        self.assertEqual(payment.provisioning_status, Payment.PROVISION_DUPLICATE)
        self.assertIsNone(payment.user_id)
        self.assertFalse(payment.invoice_number)
        self.assertEqual(User.objects.count(), users_before, "no second login is minted")
        self.assertEqual(BatchPass.objects.count(), passes_before, "no second pass is granted")

    @patch("apps.payments.views.create_razorpay_order")
    def test_guest_checkout_answers_the_same_whatever_the_email_owns(self, mock_create_order):
        mock_create_order.side_effect = lambda **kwargs: razorpay_created_order(
            f"order_probe_{mock_create_order.call_count}", **kwargs
        )
        self.guest_purchase(Payment.PLAN_BATCH_PASS, "4500.00", email="Owner@Example.com")
        _paid(
            Payment.PLAN_BATCH_PASS,
            user=self.student,
            course=self.course,
            amount="4500.00",
            buyer_email="other@example.com",
        )
        self.guest_purchase(Payment.PLAN_FULL, "3500.00", email="full-owner@example.com", suffix="_full")
        probes = [
            (Payment.PLAN_BATCH_PASS, "OWNER@example.com"),
            (Payment.PLAN_FULL, "full-owner@example.com"),
            (Payment.PLAN_BATCH_PASS, self.student.email),
            (Payment.PLAN_BATCH_PASS, "nobody@example.com"),
            (Payment.PLAN_FULL, "nobody-else@example.com"),
        ]
        shapes = []
        for index, (plan, email) in enumerate(probes):
            response = self.client.post(
                reverse("payment-create-order"),
                self.checkout_payload(plan=plan, buyer_email=email),
                format="json",
                HTTP_IDEMPOTENCY_KEY=f"guest-probe-{index:04d}",
            )
            self.assertEqual(response.status_code, 201, (email, response.data))
            self.assertNotIn("already_enrolled", response.data["data"])
            shapes.append((response.status_code, response.data["message"], sorted(response.data["data"])))
        self.assertEqual(len(set(map(str, shapes))), 1, shapes)

    def test_captured_second_pass_for_the_same_email_is_flagged_not_granted(self):
        self.guest_purchase(Payment.PLAN_BATCH_PASS, "4500.00", email="Buyer@Example.com")
        users_before, passes_before = User.objects.count(), BatchPass.objects.count()

        duplicate = self.guest_purchase(Payment.PLAN_BATCH_PASS, "4500.00", email="BUYER@example.com", suffix="_2")

        self.assert_flagged_duplicate(duplicate, users_before=users_before, passes_before=passes_before)
        # Idempotent: provider retries never grant it later either.
        provision_paid_payment(duplicate)
        duplicate.refresh_from_db()
        self.assert_flagged_duplicate(duplicate, users_before=users_before, passes_before=passes_before)

    def test_account_with_active_pass_flags_a_guest_pass_bought_with_its_email(self):
        _paid(
            Payment.PLAN_BATCH_PASS,
            user=self.student,
            course=self.course,
            amount="4500.00",
            buyer_email="other@example.com",
        )
        users_before, passes_before = User.objects.count(), BatchPass.objects.count()

        duplicate = self.guest_purchase(Payment.PLAN_BATCH_PASS, "4500.00", email=self.student.email, suffix="_2")

        self.assert_flagged_duplicate(duplicate, users_before=users_before, passes_before=passes_before)

    def test_captured_second_full_purchase_of_the_same_course_is_flagged(self):
        self.guest_purchase(Payment.PLAN_FULL, "3500.00")
        users_before, passes_before = User.objects.count(), BatchPass.objects.count()

        duplicate = self.guest_purchase(Payment.PLAN_FULL, "3500.00", suffix="_2")

        self.assert_flagged_duplicate(duplicate, users_before=users_before, passes_before=passes_before)

    def test_pass_holder_buying_an_included_course_again_is_flagged(self):
        self.guest_purchase(Payment.PLAN_BATCH_PASS, "4500.00")
        users_before, passes_before = User.objects.count(), BatchPass.objects.count()

        duplicate = self.guest_purchase(Payment.PLAN_FULL, "3500.00", suffix="_2")

        self.assert_flagged_duplicate(duplicate, users_before=users_before, passes_before=passes_before)

    @patch("apps.payments.views.fetch_razorpay_payment")
    @patch("apps.payments.views.verify_razorpay_signature")
    def test_verify_tells_the_payer_the_duplicate_will_be_refunded(self, mock_verify, mock_fetch_payment):
        self.guest_purchase(Payment.PLAN_FULL, "3500.00")
        payment = Payment.objects.create(
            course=self.course,
            amount=Decimal("3500.00"),
            plan=Payment.PLAN_FULL,
            status=Payment.STATUS_CREATED,
            razorpay_order_id="order_guest_duplicate",
            buyer_name="Guest Buyer",
            buyer_email="buyer@example.com",
        )
        mock_fetch_payment.return_value = {
            "id": "pay_guest_duplicate",
            "order_id": payment.razorpay_order_id,
            "status": "captured",
            "amount": 350000,
            "currency": "INR",
            "method": "upi",
        }

        response = self.client.post(
            reverse("payment-verify"),
            {
                "course_id": self.course.id,
                "checkout_reference": str(payment.internal_reference),
                "razorpay_order_id": payment.razorpay_order_id,
                "razorpay_payment_id": "pay_guest_duplicate",
                "razorpay_signature": "sig_guest_duplicate",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["data"]["duplicate_purchase"])
        self.assertFalse(response.data["data"]["enrolled"])
        self.assertEqual(response.data["data"]["generated_login"], "")
        self.assertIn("refunded", response.data["message"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(payment.provisioning_status, Payment.PROVISION_DUPLICATE)

    def test_refunded_guest_purchase_may_buy_again(self):
        payment = self.guest_purchase(Payment.PLAN_BATCH_PASS, "4500.00")
        record_refund(payment, amount_refunded=payment.amount, full=True)

        again = self.guest_purchase(Payment.PLAN_BATCH_PASS, "4500.00", suffix="_2")

        self.assertEqual(again.provisioning_status, Payment.PROVISION_AWAITING_ADMIN)
        self.assertTrue(again.invoice_number)

    def test_other_emails_and_installments_are_unaffected(self):
        self.guest_purchase(Payment.PLAN_FULL, "3500.00")

        other = self.guest_purchase(Payment.PLAN_FULL, "3500.00", email="someone-else@example.com", suffix="_2")
        monthly = self.guest_purchase(Payment.PLAN_MONTHLY, "1500.00", suffix="_3")

        self.assertEqual(other.provisioning_status, Payment.PROVISION_AWAITING_ADMIN)
        self.assertNotEqual(monthly.provisioning_status, Payment.PROVISION_DUPLICATE)
