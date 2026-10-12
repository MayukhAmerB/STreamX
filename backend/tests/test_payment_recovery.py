from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from apps.courses.models import Course, Enrollment
from apps.payments import views as payment_views
from apps.payments.models import Payment
from apps.payments.services import RazorpayServiceError
from apps.users.models import User
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APITestCase


@override_settings(
    DIRECT_COURSE_PAYMENTS_ENABLED=True,
    RAZORPAY_KEY_ID="rzp_test_public",
    RAZORPAY_KEY_SECRET="test-secret",
)
class PaymentOrderRecoveryTests(APITestCase):
    def setUp(self):
        self.instructor = User.objects.create_user(
            email="instructor-recovery@example.com",
            password="StrongPass@123",
            full_name="Recovery Instructor",
            role=User.ROLE_INSTRUCTOR,
        )
        self.owner = User.objects.create_user(
            email="owner-recovery@example.com",
            password="StrongPass@123",
            full_name="Recovery Owner",
            role=User.ROLE_STUDENT,
        )
        self.victim = User.objects.create_user(
            email="victim-recovery@example.com",
            password="StrongPass@123",
            full_name="Recovery Victim",
            role=User.ROLE_STUDENT,
        )
        self.course = Course.objects.create(
            title="Payment Recovery Course",
            description="Exercises server-side payment order recovery.",
            price=Decimal("3500.00"),
            monthly_price=Decimal("1500.00"),
            instructor=self.instructor,
            is_published=True,
            launch_status=Course.STATUS_LIVE,
        )
        self.client.force_authenticate(user=self.owner)

    def checkout_payload(self, **overrides):
        payload = {
            "course_id": self.course.id,
            "plan": Payment.PLAN_FULL,
            "buyer_name": self.owner.full_name,
            "buyer_email": self.owner.email,
            "whatsapp_number": "+91 98765 43210",
            "alternate_number": "+91 91234 56789",
        }
        payload.update(overrides)
        return payload

    def create_pending_order(
        self,
        *,
        user,
        order_id,
        buyer_email=None,
        plan=Payment.PLAN_FULL,
        amount=None,
    ):
        payment = Payment.objects.create(
            user=user,
            course=self.course,
            amount=amount if amount is not None else self.course.price,
            currency="INR",
            status=Payment.STATUS_CREATED,
            plan=plan,
            razorpay_order_id=order_id,
            buyer_name=user.full_name if user else "Guest Buyer",
            buyer_email=buyer_email or (user.email if user else "guest@example.com"),
            whatsapp_number="+91 98765 43210",
            alternate_number="+91 91234 56789",
            gateway_status="created",
        )
        provider_order = self.provider_order(payment)
        payment.gateway_details = {"order": provider_order}
        payment.save(update_fields=["gateway_details", "updated_at"])
        return payment, provider_order

    def provider_order(self, payment, *, status="created"):
        amount_paise = int(payment.amount * 100)
        amount_paid = amount_paise if status == "paid" else 0
        return {
            "id": payment.razorpay_order_id,
            "entity": "order",
            "amount": amount_paise,
            "amount_paid": amount_paid,
            "amount_due": amount_paise - amount_paid,
            "currency": payment.currency,
            "receipt": f"p-{payment.internal_reference.hex[:24]}",
            "status": status,
        }

    def unexpected_new_order(self, **kwargs):
        return {
            "id": "order_unexpected_duplicate",
            "entity": "order",
            "amount": kwargs["amount_paise"],
            "amount_paid": 0,
            "amount_due": kwargs["amount_paise"],
            "currency": kwargs["currency"],
            "receipt": kwargs["receipt"],
            "status": "created",
        }

    @patch("apps.payments.views.fetch_razorpay_order", create=True)
    @patch("apps.payments.views.create_razorpay_order")
    def test_new_idempotency_key_reuses_owned_created_gateway_order(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        existing, provider_order = self.create_pending_order(
            user=self.owner,
            order_id="order_existing_created",
        )
        mock_fetch_order.return_value = provider_order
        mock_create_order.side_effect = self.unexpected_new_order

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-recovery-new-key-0001",
        )

        self.assertIn(response.status_code, (200, 201))
        self.assertTrue(response.data["success"])
        self.assertEqual(
            response.data["data"]["razorpay_order_id"],
            existing.razorpay_order_id,
        )
        self.assertEqual(
            response.data["data"]["checkout_reference"],
            str(existing.internal_reference),
        )
        self.assertEqual(Payment.objects.count(), 1)
        mock_create_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_new_guest_key_cannot_recover_an_order_using_email_alone(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        self.client.force_authenticate(user=None)
        existing, _ = self.create_pending_order(
            user=None,
            order_id="order_guest_private_recovery",
            buyer_email="guest-private@example.com",
        )

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(
                buyer_name="Email Knower",
                buyer_email="guest-private@example.com",
            ),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-attacker-new-key-0006",
        )

        self.assertEqual(response.status_code, 409)
        self.assertIsNone(response.data["data"])
        self.assertNotIn(str(existing.internal_reference), str(response.data))
        self.assertNotIn(existing.razorpay_order_id, str(response.data))
        mock_fetch_order.assert_not_called()
        mock_create_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_open_order_for_a_different_plan_fails_closed(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        existing, provider_order = self.create_pending_order(
            user=self.owner,
            order_id="order_existing_monthly_quote",
            plan=Payment.PLAN_MONTHLY,
            amount=self.course.monthly_price,
        )
        mock_fetch_order.return_value = provider_order

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(plan=Payment.PLAN_FULL),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-plan-mismatch-0007",
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(Payment.objects.count(), 1)
        self.assertTrue(Payment.objects.filter(pk=existing.pk).exists())
        mock_create_order.assert_not_called()

    @override_settings(PAYMENT_ORDER_RESUME_MAX_AGE_SECONDS=60)
    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_stale_open_order_quote_fails_closed(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        existing, provider_order = self.create_pending_order(
            user=self.owner,
            order_id="order_existing_expired_quote",
        )
        Payment.objects.filter(pk=existing.pk).update(
            created_at=timezone.now() - timedelta(hours=2)
        )
        mock_fetch_order.return_value = provider_order

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-expired-quote-0008",
        )

        self.assertEqual(response.status_code, 409)
        self.assertEqual(Payment.objects.count(), 1)
        mock_create_order.assert_not_called()

    @patch("apps.payments.views._reconcile_open_payment", return_value=None)
    @patch("apps.payments.views.create_razorpay_order")
    def test_locked_create_recheck_blocks_a_concurrent_open_order(
        self,
        mock_create_order,
        _mock_reconcile,
    ):
        self.create_pending_order(
            user=self.owner,
            order_id="order_concurrent_winner",
        )

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-concurrent-loser-0009",
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(Payment.objects.count(), 1)
        mock_create_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_guest_same_key_recovers_after_concurrent_checkout_503(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        self.client.force_authenticate(user=None)
        existing, provider_order = self.create_pending_order(
            user=None,
            order_id="order_guest_concurrent_winner",
            buyer_email="guest-retry@example.com",
        )
        mock_fetch_order.return_value = provider_order
        original_reconcile = payment_views._reconcile_open_payment
        reconcile_calls = 0

        def defer_first_reconciliation(**kwargs):
            nonlocal reconcile_calls
            reconcile_calls += 1
            if reconcile_calls == 1:
                return None
            return original_reconcile(**kwargs)

        request_key = "checkout-guest-concurrent-retry-0010"
        payload = self.checkout_payload(
            buyer_name="Guest Retry",
            buyer_email="guest-retry@example.com",
        )
        with patch(
            "apps.payments.views._reconcile_open_payment",
            side_effect=defer_first_reconciliation,
        ):
            first = self.client.post(
                reverse("payment-create-order"),
                payload,
                format="json",
                HTTP_IDEMPOTENCY_KEY=request_key,
            )
            second = self.client.post(
                reverse("payment-create-order"),
                payload,
                format="json",
                HTTP_IDEMPOTENCY_KEY=request_key,
            )

        self.assertEqual(first.status_code, 503)
        self.assertTrue(first.data["data"]["retry_same_checkout"])
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.data["success"])
        self.assertTrue(second.data["data"]["resumed"])
        self.assertEqual(
            second.data["data"]["razorpay_order_id"],
            existing.razorpay_order_id,
        )
        self.assertEqual(Payment.objects.count(), 1)
        mock_create_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_same_key_recovers_after_provider_outage_503(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        existing, provider_order = self.create_pending_order(
            user=self.owner,
            order_id="order_authenticated_provider_retry",
        )
        mock_fetch_order.side_effect = [
            RazorpayServiceError("The payment gateway is temporarily unavailable."),
            provider_order,
        ]
        request_key = "checkout-provider-outage-retry-0011"

        first = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )
        second = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )

        self.assertEqual(first.status_code, 503)
        self.assertTrue(first.data["data"]["retry_same_checkout"])
        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.data["success"])
        self.assertTrue(second.data["data"]["resumed"])
        self.assertEqual(
            second.data["data"]["razorpay_order_id"],
            existing.razorpay_order_id,
        )
        self.assertEqual(Payment.objects.count(), 1)
        mock_create_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_same_key_preserves_rotation_after_gateway_creation_failure(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        mock_create_order.side_effect = RazorpayServiceError(
            "The payment gateway is temporarily unavailable."
        )
        request_key = "checkout-provider-create-failure-0012"

        first = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )
        second = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )

        self.assertEqual(first.status_code, 503)
        self.assertTrue(first.data["data"]["rotate_checkout_key"])
        self.assertEqual(second.status_code, 503)
        self.assertTrue(second.data["data"]["rotate_checkout_key"])
        payment = Payment.objects.get()
        self.assertEqual(payment.status, Payment.STATUS_FAILED)
        self.assertFalse(payment.razorpay_order_id)
        self.assertEqual(mock_create_order.call_count, 1)
        mock_fetch_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order", create=True)
    @patch("apps.payments.views.create_razorpay_order")
    def test_provider_lookup_failure_blocks_a_duplicate_local_payment(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        existing, _ = self.create_pending_order(
            user=self.owner,
            order_id="order_existing_lookup_unavailable",
        )
        mock_fetch_order.side_effect = RazorpayServiceError(
            "The payment gateway is temporarily unavailable."
        )
        mock_create_order.side_effect = self.unexpected_new_order

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-recovery-new-key-0002",
        )

        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.data["success"])
        self.assertEqual(Payment.objects.count(), 1)
        self.assertTrue(Payment.objects.filter(pk=existing.pk).exists())
        mock_create_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order", create=True)
    @patch("apps.payments.views.create_razorpay_order")
    def test_authenticated_owner_scope_overrides_submitted_buyer_email(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        owner_order, owner_provider_order = self.create_pending_order(
            user=self.owner,
            order_id="order_authenticated_owner",
        )
        victim_order, victim_provider_order = self.create_pending_order(
            user=self.victim,
            order_id="order_submitted_email_victim",
        )
        provider_orders = {
            owner_order.razorpay_order_id: owner_provider_order,
            victim_order.razorpay_order_id: victim_provider_order,
        }
        mock_fetch_order.side_effect = (
            lambda *, razorpay_order_id: provider_orders[razorpay_order_id]
        )
        mock_create_order.side_effect = self.unexpected_new_order

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(buyer_email=self.victim.email),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-recovery-new-key-0003",
        )

        self.assertIn(response.status_code, (200, 201))
        self.assertTrue(response.data["success"])
        self.assertEqual(
            response.data["data"]["razorpay_order_id"],
            owner_order.razorpay_order_id,
        )
        self.assertEqual(
            response.data["data"]["checkout_reference"],
            str(owner_order.internal_reference),
        )
        self.assertNotEqual(
            response.data["data"]["checkout_reference"],
            str(victim_order.internal_reference),
        )
        self.assertEqual(Payment.objects.count(), 2)
        mock_create_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order_payments")
    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_paid_open_order_is_recovered_and_provisioned_without_a_new_order(
        self,
        mock_create_order,
        mock_fetch_order,
        mock_fetch_order_payments,
    ):
        existing, _ = self.create_pending_order(
            user=self.owner,
            order_id="order_existing_captured",
        )
        mock_fetch_order.return_value = self.provider_order(existing, status="paid")
        mock_fetch_order_payments.return_value = {
            "items": [
                {
                    "id": "pay_existing_captured",
                    "order_id": existing.razorpay_order_id,
                    "status": "captured",
                    "amount": int(existing.amount * 100),
                    "currency": existing.currency,
                    "method": "upi",
                }
            ]
        }

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-recovery-captured-0004",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["data"]["payment_verified"])
        existing.refresh_from_db()
        self.assertEqual(existing.status, Payment.STATUS_PAID)
        self.assertEqual(existing.razorpay_payment_id, "pay_existing_captured")
        self.assertTrue(
            Enrollment.objects.filter(user=self.owner, course=self.course).exists()
        )
        self.assertEqual(Payment.objects.count(), 1)
        mock_create_order.assert_not_called()

    @patch("apps.payments.views.fetch_razorpay_order_payments")
    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_same_checkout_key_reconciles_capture_after_a_page_reload(
        self,
        mock_create_order,
        mock_fetch_order,
        mock_fetch_order_payments,
    ):
        mock_create_order.side_effect = self.unexpected_new_order
        request_key = "checkout-recovery-reload-0005"
        first = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )
        self.assertEqual(first.status_code, 201)
        payment = Payment.objects.get()
        mock_fetch_order.return_value = self.provider_order(payment, status="paid")
        payment.status = Payment.STATUS_FAILED
        payment.save(update_fields=["status", "updated_at"])
        self.course.price = Decimal("4200.00")
        self.course.registration_closed = True
        self.course.is_published = False
        self.course.save(
            update_fields=[
                "price",
                "registration_closed",
                "is_published",
                "updated_at",
            ]
        )
        mock_fetch_order_payments.return_value = {
            "items": [
                {
                    "id": "pay_recovered_after_reload",
                    "order_id": payment.razorpay_order_id,
                    "status": "captured",
                    "amount": int(payment.amount * 100),
                    "currency": payment.currency,
                }
            ]
        }

        second = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )

        self.assertEqual(second.status_code, 200)
        self.assertTrue(second.data["data"]["payment_verified"])
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_PAID)
        self.assertEqual(Payment.objects.count(), 1)
        self.assertEqual(mock_create_order.call_count, 1)

    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_closed_course_blocks_unpaid_replay_and_all_new_sales(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        mock_create_order.side_effect = self.unexpected_new_order
        request_key = "checkout-recovery-closed-unpaid-0006"
        first = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )
        self.assertEqual(first.status_code, 201)
        payment = Payment.objects.get()
        mock_fetch_order.return_value = self.provider_order(payment, status="created")
        self.course.registration_closed = True
        self.course.is_published = False
        self.course.save(
            update_fields=["registration_closed", "is_published", "updated_at"]
        )

        replay = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )
        new_sale = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-recovery-closed-new-sale-0007",
        )

        self.assertEqual(replay.status_code, 409)
        self.assertFalse(replay.data["success"])
        self.assertEqual(new_sale.status_code, 404)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_CREATED)
        self.assertFalse(Enrollment.objects.filter(course=self.course).exists())
        self.assertEqual(Payment.objects.count(), 1)
        self.assertEqual(mock_create_order.call_count, 1)
        self.assertEqual(mock_fetch_order.call_count, 1)

    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_closed_course_never_replays_cached_order_for_failed_payment(
        self,
        mock_create_order,
        mock_fetch_order,
    ):
        mock_create_order.side_effect = self.unexpected_new_order
        request_key = "checkout-recovery-closed-failed-0008"
        first = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )
        self.assertEqual(first.status_code, 201)
        payment = Payment.objects.get()
        payment.status = Payment.STATUS_FAILED
        payment.save(update_fields=["status", "updated_at"])
        mock_fetch_order.return_value = self.provider_order(payment, status="attempted")
        self.course.registration_closed = True
        self.course.is_published = False
        self.course.save(
            update_fields=["registration_closed", "is_published", "updated_at"]
        )

        replay = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY=request_key,
        )
        new_sale = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-recovery-closed-new-sale-0009",
        )

        self.assertEqual(replay.status_code, 409)
        self.assertFalse(replay.data["success"])
        self.assertIsNone(replay.data["data"])
        self.assertEqual(new_sale.status_code, 404)
        payment.refresh_from_db()
        self.assertEqual(payment.status, Payment.STATUS_FAILED)
        self.assertFalse(Enrollment.objects.filter(course=self.course).exists())
        self.assertEqual(Payment.objects.count(), 1)
        self.assertEqual(mock_create_order.call_count, 1)
        self.assertEqual(mock_fetch_order.call_count, 1)

    @patch("apps.payments.views.fetch_razorpay_order_payments")
    @patch("apps.payments.views.fetch_razorpay_order")
    @patch("apps.payments.views.create_razorpay_order")
    def test_paid_order_with_mismatched_capture_fails_closed(
        self,
        mock_create_order,
        mock_fetch_order,
        mock_fetch_order_payments,
    ):
        existing, _ = self.create_pending_order(
            user=self.owner,
            order_id="order_existing_capture_mismatch",
        )
        mock_fetch_order.return_value = self.provider_order(existing, status="paid")
        mock_fetch_order_payments.return_value = {
            "items": [
                {
                    "id": "pay_existing_capture_mismatch",
                    "order_id": existing.razorpay_order_id,
                    "status": "captured",
                    "amount": int(existing.amount * 100) - 1,
                    "currency": existing.currency,
                }
            ]
        }

        response = self.client.post(
            reverse("payment-create-order"),
            self.checkout_payload(),
            format="json",
            HTTP_IDEMPOTENCY_KEY="checkout-recovery-mismatch-0005",
        )

        self.assertEqual(response.status_code, 409)
        existing.refresh_from_db()
        self.assertEqual(existing.status, Payment.STATUS_CREATED)
        self.assertFalse(Enrollment.objects.filter(course=self.course).exists())
        self.assertEqual(Payment.objects.count(), 1)
        mock_create_order.assert_not_called()
