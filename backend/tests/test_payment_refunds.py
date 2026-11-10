import hashlib
import hmac
import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth.models import Permission
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone

from apps.courses.access import accessible_course_ids_for_user, user_has_course_access
from apps.courses.models import Course, Enrollment
from apps.payments.models import BatchPass, Payment
from apps.payments.provisioning import provision_paid_payment
from apps.users.models import User
from tests import test_api as api_tests

WEBHOOK_SECRET = "whsec_refund_test"


@override_settings(
    DIRECT_COURSE_PAYMENTS_ENABLED=True,
    RAZORPAY_KEY_ID="rzp_test_public",
    RAZORPAY_KEY_SECRET="test-secret",
    RAZORPAY_WEBHOOK_SECRET=WEBHOOK_SECRET,
)
class RefundRevocationTests(api_tests.BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.course.price = Decimal("3500.00")
        self.course.monthly_price = Decimal("1500.00")
        self.course.installments_required = 3
        self.course.installment_access_days = 30
        self.course.batch_pass_payment_enabled = True
        self.course.batch_pass_price = Decimal("4500.00")
        self.course.included_in_batch_pass = True
        with self.captureOnCommitCallbacks(execute=True):
            self.course.save()

    # -- helpers ---------------------------------------------------------

    def make_course(self, title, **fields):
        defaults = {
            "description": "Another batch",
            "price": Decimal("3500.00"),
            "is_published": True,
            "instructor": self.instructor,
        }
        defaults.update(fields)
        with self.captureOnCommitCallbacks(execute=True):
            return Course.objects.create(title=title, **defaults)

    def paid(self, plan, *, amount, course=None, user=None, paid_at=None):
        number = Payment.objects.count() + 1
        payment = Payment.objects.create(
            user=user or self.student,
            course=course or self.course,
            amount=Decimal(amount),
            plan=plan,
            status=Payment.STATUS_PAID,
            paid_at=paid_at or timezone.now(),
            razorpay_order_id=f"order_refund_{number}",
            razorpay_payment_id=f"pay_refund_{number}",
            buyer_name="Refund Student",
            buyer_email="refund-buyer@example.com",
        )
        provision_paid_payment(payment)
        payment.refresh_from_db()
        return payment

    def enrollment(self, course=None, user=None):
        return Enrollment.objects.get(user=user or self.student, course=course or self.course)

    def refund_webhook(
        self,
        payment,
        *,
        refunded_paise=None,
        refund_status="full",
        payment_id=None,
        event="refund.processed",
        event_id=None,
    ):
        amount_paise = int(Decimal(payment.amount) * 100)
        refunded_paise = amount_paise if refunded_paise is None else refunded_paise
        payment_id = payment_id or payment.razorpay_payment_id
        payload = {
            "entity": "event",
            "event": event,
            "payload": {
                "refund": {
                    "entity": {
                        "id": f"rfnd_{payment_id}_{refunded_paise}",
                        "entity": "refund",
                        "amount": refunded_paise,
                        "currency": "INR",
                        "payment_id": payment_id,
                        "status": "processed",
                    }
                },
                "payment": {
                    "entity": {
                        "id": payment_id,
                        "entity": "payment",
                        "order_id": payment.razorpay_order_id,
                        "amount": amount_paise,
                        "currency": "INR",
                        "status": "refunded" if refund_status == "full" else "captured",
                        "amount_refunded": refunded_paise,
                        "refund_status": refund_status,
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
            HTTP_X_RAZORPAY_EVENT_ID=event_id or f"evt_{payment_id}_{refunded_paise}_{event}",
        )

    def captured_webhook(self, payment, *, event_id):
        payload = {
            "event": "payment.captured",
            "payload": {
                "payment": {
                    "entity": {
                        "id": payment.razorpay_payment_id,
                        "order_id": payment.razorpay_order_id,
                        "status": "captured",
                        "amount": int(Decimal(payment.amount) * 100),
                        "currency": "INR",
                    }
                }
            },
        }
        body = json.dumps(payload).encode("utf-8")
        signature = hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()
        return self.client.post(
            reverse("payment-webhook"),
            data=body,
            content_type="application/json",
            HTTP_X_RAZORPAY_SIGNATURE=signature,
            HTTP_X_RAZORPAY_EVENT_ID=event_id,
        )

    # -- one-time payments -----------------------------------------------

    def test_full_refund_webhook_revokes_one_time_access(self):
        payment = self.paid(Payment.PLAN_FULL, amount="3500.00")
        self.assertTrue(user_has_course_access(self.student, self.course.id))

        with patch("apps.payments.entitlements.invalidate_course_join_access_cache") as invalidate:
            response = self.refund_webhook(payment)

        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["data"]["processed"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        self.assertEqual(payment.amount_refunded, Decimal("3500.00"))
        self.assertIsNotNone(payment.refunded_at)
        self.assertEqual(payment.last_webhook_event, "refund.processed")
        enrollment = self.enrollment()
        self.assertEqual(enrollment.payment_status, Enrollment.STATUS_FAILED)
        self.assertFalse(enrollment.has_active_access())
        self.assertFalse(user_has_course_access(self.student, self.course.id))
        self.assertNotIn(self.course.id, list(accessible_course_ids_for_user(self.student)))
        invalidate.assert_called_with(user_id=self.student.id, course_id=self.course.id)

    def test_partial_refund_is_recorded_without_revoking_access(self):
        payment = self.paid(Payment.PLAN_FULL, amount="3500.00")

        response = self.refund_webhook(payment, refunded_paise=50000, refund_status="partial")

        self.assertEqual(response.status_code, 200, response.data)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(payment.amount_refunded, Decimal("500.00"))
        self.assertIsNone(payment.refunded_at)
        self.assertTrue(user_has_course_access(self.student, self.course.id))

    def test_partial_refunds_that_add_up_to_the_full_amount_revoke_access(self):
        payment = self.paid(Payment.PLAN_FULL, amount="3500.00")

        self.refund_webhook(payment, refunded_paise=150000, refund_status="partial")
        self.assertTrue(user_has_course_access(self.student, self.course.id))
        self.refund_webhook(payment, refunded_paise=350000, refund_status="full")

        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        self.assertFalse(user_has_course_access(self.student, self.course.id))

    def test_replayed_refund_webhook_does_nothing_twice(self):
        payment = self.paid(Payment.PLAN_FULL, amount="3500.00")
        self.refund_webhook(payment, event_id="evt_refund_once")
        payment.refresh_from_db()
        refunded_at = payment.refunded_at
        # Support re-grants the student by hand after the refund.
        Enrollment.objects.filter(user=self.student, course=self.course).update(
            payment_status=Enrollment.STATUS_PAID
        )

        duplicate = self.refund_webhook(payment, event_id="evt_refund_once")
        redelivered = self.refund_webhook(payment, event_id="evt_refund_redelivered")
        alias = self.refund_webhook(payment, event="payment.refunded", event_id="evt_payment_refunded")

        self.assertTrue(duplicate.data["data"]["duplicate"])
        self.assertFalse(redelivered.data["data"]["processed"])
        self.assertFalse(alias.data["data"]["processed"])
        payment.refresh_from_db()
        self.assertEqual(payment.refunded_at, refunded_at)
        self.assertEqual(payment.amount_refunded, Decimal("3500.00"))
        self.assertTrue(user_has_course_access(self.student, self.course.id))

    def test_refund_of_another_payment_on_the_same_order_is_ignored(self):
        payment = self.paid(Payment.PLAN_FULL, amount="3500.00")

        response = self.refund_webhook(payment, payment_id="pay_duplicate_auto_refund")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["data"]["processed"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(payment.amount_refunded, Decimal("0"))
        self.assertTrue(user_has_course_access(self.student, self.course.id))

    def test_refund_created_event_does_not_change_access(self):
        payment = self.paid(Payment.PLAN_FULL, amount="3500.00")

        response = self.refund_webhook(payment, event="refund.created")

        self.assertFalse(response.data["data"]["processed"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertTrue(user_has_course_access(self.student, self.course.id))

    def test_late_capture_webhook_cannot_resurrect_a_refunded_payment(self):
        payment = self.paid(Payment.PLAN_FULL, amount="3500.00")
        self.refund_webhook(payment)

        response = self.captured_webhook(payment, event_id="evt_late_capture")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["data"]["processed"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        self.assertFalse(user_has_course_access(self.student, self.course.id))

    def test_verify_callback_for_a_refunded_payment_is_rejected(self):
        payment = self.paid(Payment.PLAN_FULL, amount="3500.00")
        self.refund_webhook(payment)
        self.login(self.student.email)

        response = self.client.post(
            reverse("payment-verify"),
            {
                "course_id": self.course.id,
                "razorpay_order_id": payment.razorpay_order_id,
                "razorpay_payment_id": payment.razorpay_payment_id,
                "razorpay_signature": "a" * 64,
                "checkout_reference": str(payment.internal_reference),
            },
            format="json",
        )

        self.assertEqual(response.status_code, 409)
        self.assertFalse(user_has_course_access(self.student, self.course.id))

    def created_order(self, *, user=None, number="early"):
        return Payment.objects.create(
            user=user,
            course=self.course,
            amount=Decimal("3500.00"),
            plan=Payment.PLAN_FULL,
            status=Payment.STATUS_CREATED,
            razorpay_order_id=f"order_{number}",
            buyer_name="Refund Student",
            buyer_email="early-refund@example.com",
        )

    def test_refund_webhook_before_capture_is_kept_and_capture_ends_refunded(self):
        payment = self.created_order(user=self.student)
        payment.razorpay_payment_id = "pay_early"  # what the events will carry

        refund = self.refund_webhook(payment)

        self.assertEqual(refund.status_code, 200)
        self.assertTrue(refund.data["data"]["processed"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)
        self.assertEqual(payment.gateway_details["pending_refund"]["razorpay_payment_id"], "pay_early")
        self.assertTrue(payment.gateway_details["pending_refund"]["full"])

        payment.razorpay_payment_id = "pay_early"
        capture = self.captured_webhook(payment, event_id="evt_capture_after_refund")

        self.assertEqual(capture.status_code, 200)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        self.assertEqual(payment.amount_refunded, Decimal("3500.00"))
        self.assertIsNotNone(payment.refunded_at)
        self.assertFalse(user_has_course_access(self.student, self.course.id))
        self.assertFalse(Enrollment.objects.filter(user=self.student, course=self.course, payment_status="paid").exists())

    def test_guest_refund_before_capture_mints_no_login(self):
        payment = self.created_order(number="early_guest")
        payment.razorpay_payment_id = "pay_early_guest"
        self.refund_webhook(payment)
        users_before = User.objects.count()

        payment.razorpay_payment_id = "pay_early_guest"
        self.captured_webhook(payment, event_id="evt_guest_capture_after_refund")

        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        self.assertIsNone(payment.user_id)
        self.assertEqual(User.objects.count(), users_before)

    @patch("apps.payments.views.fetch_razorpay_payment")
    @patch("apps.payments.views.verify_razorpay_signature")
    def test_verify_after_an_early_refund_is_rejected_without_access(self, mock_verify, mock_fetch):
        payment = self.created_order(user=self.student, number="early_verify")
        payment.razorpay_payment_id = "pay_early_verify"
        self.refund_webhook(payment)
        mock_fetch.return_value = {
            "id": "pay_early_verify",
            "order_id": payment.razorpay_order_id,
            "status": "captured",
            "amount": 350000,
            "currency": "INR",
        }
        self.login(self.student.email)

        response = self.client.post(
            reverse("payment-verify"),
            {
                "course_id": self.course.id,
                "razorpay_order_id": payment.razorpay_order_id,
                "razorpay_payment_id": "pay_early_verify",
                "razorpay_signature": "a" * 64,
                "checkout_reference": str(payment.internal_reference),
            },
            format="json",
        )

        self.assertEqual(response.status_code, 409)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_REFUNDED)
        self.assertFalse(user_has_course_access(self.student, self.course.id))

    def test_early_refund_of_another_payment_does_not_touch_the_captured_one(self):
        payment = self.created_order(user=self.student, number="early_other")
        payment.razorpay_payment_id = "pay_auto_refunded"
        self.refund_webhook(payment)

        payment.razorpay_payment_id = "pay_kept"
        self.captured_webhook(payment, event_id="evt_capture_kept")

        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(payment.amount_refunded, Decimal("0"))
        self.assertTrue(user_has_course_access(self.student, self.course.id))

    def test_partial_refund_before_capture_keeps_access(self):
        payment = self.created_order(user=self.student, number="early_partial")
        payment.razorpay_payment_id = "pay_early_partial"
        self.refund_webhook(payment, refunded_paise=50000, refund_status="partial")

        payment.razorpay_payment_id = "pay_early_partial"
        self.captured_webhook(payment, event_id="evt_capture_partial")

        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(payment.amount_refunded, Decimal("500.00"))
        self.assertTrue(user_has_course_access(self.student, self.course.id))

    def test_refund_keeps_access_backed_by_another_paid_payment(self):
        first = self.paid(Payment.PLAN_FULL, amount="3500.00")
        self.paid(Payment.PLAN_FULL, amount="3500.00")

        self.refund_webhook(first)

        enrollment = self.enrollment()
        self.assertEqual(enrollment.payment_status, Enrollment.STATUS_PAID)
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_LIFETIME)

    def test_refund_keeps_course_covered_by_another_active_pass(self):
        source = self.make_course("Pass Source Batch", batch_pass_payment_enabled=True, batch_pass_price=Decimal("4500.00"))
        self.paid(Payment.PLAN_BATCH_PASS, amount="4500.00", course=source)
        one_time = self.paid(Payment.PLAN_FULL, amount="3500.00")

        self.refund_webhook(one_time)

        self.assertTrue(user_has_course_access(self.student, self.course.id))
        self.assertEqual(self.enrollment().access_type, Enrollment.ACCESS_LIFETIME)

    # -- EMI ---------------------------------------------------------------

    def test_refunded_emi_installment_rederives_access_from_remaining_installments(self):
        first = self.paid(Payment.PLAN_MONTHLY, amount="1500.00")
        second = self.paid(Payment.PLAN_MONTHLY, amount="1500.00")
        self.assertEqual(self.enrollment().installments_paid, 2)
        self.assertGreater(second.access_expires_at, first.access_expires_at)

        self.refund_webhook(second)

        enrollment = self.enrollment()
        self.assertEqual(enrollment.payment_status, Enrollment.STATUS_PAID)
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_INSTALLMENT)
        self.assertEqual(enrollment.access_expires_at, first.access_expires_at)
        self.assertEqual(enrollment.installments_paid, 1)
        self.assertTrue(enrollment.has_active_access())

    def test_refunding_the_only_installment_revokes_access(self):
        installment = self.paid(Payment.PLAN_MONTHLY, amount="1500.00")

        self.refund_webhook(installment)

        self.assertEqual(self.enrollment().payment_status, Enrollment.STATUS_FAILED)

    def test_refunding_the_last_of_three_installments_drops_lifetime_access(self):
        installments = [self.paid(Payment.PLAN_MONTHLY, amount="1500.00") for _ in range(3)]
        self.assertEqual(self.enrollment().access_type, Enrollment.ACCESS_LIFETIME)

        self.refund_webhook(installments[-1])

        enrollment = self.enrollment()
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_INSTALLMENT)
        self.assertEqual(enrollment.installments_paid, 2)
        self.assertEqual(enrollment.access_expires_at, installments[1].access_expires_at)

    # -- batch pass ------------------------------------------------------

    def test_refunded_batch_pass_ends_the_pass_and_revokes_pass_only_courses(self):
        earlier = self.make_course("OSINT Batch III", included_in_batch_pass=True)
        bought_separately = self.make_course("OSINT Batch II", included_in_batch_pass=True)
        admin_approved = self.make_course("OSINT Batch I", included_in_batch_pass=True)
        Enrollment.objects.create(
            user=self.student,
            course=admin_approved,
            payment_status=Enrollment.STATUS_PAID,
            access_type=Enrollment.ACCESS_LEGACY,
        )
        self.paid(Payment.PLAN_FULL, amount="3500.00", course=bought_separately)
        pass_payment = self.paid(Payment.PLAN_BATCH_PASS, amount="4500.00")
        for course in (self.course, earlier, bought_separately, admin_approved):
            self.assertTrue(user_has_course_access(self.student, course.id), course.title)

        response = self.refund_webhook(pass_payment)

        self.assertTrue(response.data["data"]["processed"])
        self.assertFalse(BatchPass.objects.get(payment=pass_payment).is_active)
        self.assertFalse(user_has_course_access(self.student, self.course.id))
        self.assertFalse(user_has_course_access(self.student, earlier.id))
        self.assertTrue(user_has_course_access(self.student, bought_separately.id))
        self.assertTrue(user_has_course_access(self.student, admin_approved.id))

        future = self.make_course("OSINT Batch V", included_in_batch_pass=True)
        self.assertFalse(Enrollment.objects.filter(user=self.student, course=future).exists())

    def test_refunded_batch_pass_restores_the_emi_access_it_had_upgraded(self):
        installment = self.paid(Payment.PLAN_MONTHLY, amount="1500.00")
        pass_payment = self.paid(Payment.PLAN_BATCH_PASS, amount="4500.00")
        self.assertEqual(self.enrollment().access_type, Enrollment.ACCESS_LIFETIME)

        self.refund_webhook(pass_payment)

        enrollment = self.enrollment()
        self.assertEqual(enrollment.access_type, Enrollment.ACCESS_INSTALLMENT)
        self.assertEqual(enrollment.access_expires_at, installment.access_expires_at)

    def test_refunded_pass_keeps_courses_covered_by_a_second_active_pass(self):
        earlier = self.make_course("OSINT Batch III", included_in_batch_pass=True)
        first_pass = self.paid(Payment.PLAN_BATCH_PASS, amount="4500.00")
        self.paid(Payment.PLAN_BATCH_PASS, amount="4500.00", course=earlier)

        self.refund_webhook(first_pass)

        self.assertTrue(user_has_course_access(self.student, self.course.id))
        self.assertTrue(user_has_course_access(self.student, earlier.id))

    def test_repurchase_after_refund_reuses_the_guest_account(self):
        guest_payment = Payment.objects.create(
            course=self.course,
            amount=Decimal("3500.00"),
            plan=Payment.PLAN_FULL,
            status=Payment.STATUS_PAID,
            paid_at=timezone.now() - timedelta(days=1),
            razorpay_order_id="order_guest_first",
            razorpay_payment_id="pay_guest_first",
            buyer_name="Guest",
            buyer_email="guest-refund@example.com",
        )
        provision_paid_payment(guest_payment)
        guest_payment.refresh_from_db()
        self.refund_webhook(guest_payment)

        repurchase = Payment.objects.create(
            course=self.course,
            amount=Decimal("3500.00"),
            plan=Payment.PLAN_FULL,
            status=Payment.STATUS_PAID,
            paid_at=timezone.now(),
            razorpay_order_id="order_guest_second",
            razorpay_payment_id="pay_guest_second",
            buyer_name="Guest",
            buyer_email="guest-refund@example.com",
        )
        provision_paid_payment(repurchase)
        repurchase.refresh_from_db()

        self.assertEqual(repurchase.user_id, guest_payment.user_id)
        self.assertTrue(user_has_course_access(repurchase.user, self.course.id))


class RefundAdminActionTests(api_tests.BaseAPITestCase):
    """Refunds issued by hand in the Razorpay dashboard."""

    def setUp(self):
        super().setUp()
        self.superuser = User.objects.create_superuser(
            email="refund-admin@example.com",
            password="StrongAdmin@123",
            full_name="Refund Admin",
        )
        self.payment = Payment.objects.create(
            user=self.student,
            course=self.course,
            amount=Decimal("499.00"),
            plan=Payment.PLAN_FULL,
            status=Payment.STATUS_PAID,
            paid_at=timezone.now(),
            razorpay_order_id="order_admin_refund",
            razorpay_payment_id="pay_admin_refund",
            buyer_email="admin-refund@example.com",
        )
        provision_paid_payment(self.payment)

    def run_action(self, user):
        self.client.force_login(user)
        return self.client.post(
            reverse("admin:payments_payment_changelist"),
            {
                "action": "mark_refunded_and_revoke_access",
                "_selected_action": [self.payment.pk],
            },
            follow=True,
        )

    def test_superuser_marks_payment_refunded_and_access_is_revoked(self):
        with patch("apps.payments.admin.log_security_event") as log_event:
            response = self.run_action(self.superuser)
            self.run_action(self.superuser)

        self.assertEqual(response.status_code, 200)
        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_REFUNDED)
        self.assertEqual(self.payment.amount_refunded, Decimal("499.00"))
        self.assertFalse(user_has_course_access(self.student, self.course.id))
        refund_logs = [
            item for item in log_event.call_args_list if item.args[0] == "admin.payment_marked_refunded"
        ]
        self.assertEqual(len(refund_logs), 1)
        self.assertEqual(refund_logs[0].kwargs["payment_id"], self.payment.id)
        self.assertEqual(refund_logs[0].kwargs["revoked"], 1)

    def test_staff_without_superuser_cannot_mark_refunds(self):
        staff = User.objects.create_user(
            email="refund-staff@example.com",
            password="StrongStaff@123",
            full_name="Refund Staff",
            is_staff=True,
        )
        staff.user_permissions.add(
            *Permission.objects.filter(content_type__app_label="payments", codename__in=["view_payment", "change_payment"])
        )
        self.client.force_login(staff)
        changelist = self.client.get(reverse("admin:payments_payment_changelist"))
        self.assertEqual(changelist.status_code, 200)
        self.assertNotContains(changelist, "mark_refunded_and_revoke_access")

        self.run_action(staff)

        self.payment.refresh_from_db()
        self.assertEqual(self.payment.status, Payment.STATUS_PAID)
        self.assertTrue(user_has_course_access(self.student, self.course.id))
