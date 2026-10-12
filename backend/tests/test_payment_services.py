import hashlib
import hmac
from unittest.mock import patch

import requests
from apps.payments.services import (
    RazorpayServiceError,
    create_razorpay_order,
    fetch_razorpay_payment,
    validate_created_razorpay_order,
    verify_razorpay_signature,
)
from django.test import SimpleTestCase, override_settings


@override_settings(
    RAZORPAY_KEY_ID="rzp_test_key",
    RAZORPAY_KEY_SECRET="test_secret",
    RAZORPAY_HTTP_TIMEOUT_SECONDS=7,
)
class RazorpayServiceTests(SimpleTestCase):
    @patch("apps.payments.services._TimeoutSession")
    def test_create_order_uses_authenticated_razorpay_api(self, session_class):
        response = session_class.return_value.request.return_value
        response.json.return_value = {"id": "order_test_123", "status": "created"}

        result = create_razorpay_order(
            amount_paise=350000,
            currency="INR",
            receipt="ASI-123",
        )

        self.assertEqual(result["id"], "order_test_123")
        session_class.assert_called_once_with(timeout_seconds=7)
        session_class.return_value.request.assert_called_once_with(
            "POST",
            "https://api.razorpay.com/v1/orders",
            auth=("rzp_test_key", "test_secret"),
            headers={"Accept": "application/json"},
            json={
                "amount": 350000,
                "currency": "INR",
                "receipt": "ASI-123",
                "payment_capture": 1,
            },
        )
        response.raise_for_status.assert_called_once_with()

    def test_verify_signature_uses_constant_time_hmac_check(self):
        signature = hmac.new(
            b"test_secret",
            b"order_test_123|pay_test_123",
            hashlib.sha256,
        ).hexdigest()

        self.assertTrue(
            verify_razorpay_signature(
                razorpay_order_id="order_test_123",
                razorpay_payment_id="pay_test_123",
                razorpay_signature=signature,
            )
        )

    def test_verify_signature_rejects_invalid_value(self):
        with self.assertRaisesRegex(
            RazorpayServiceError,
            "signature verification failed",
        ):
            verify_razorpay_signature(
                razorpay_order_id="order_test_123",
                razorpay_payment_id="pay_test_123",
                razorpay_signature="invalid",
            )

    @patch("apps.payments.services._TimeoutSession")
    def test_fetch_payment_uses_encoded_payment_id(self, session_class):
        response = session_class.return_value.request.return_value
        response.json.return_value = {"id": "pay_test/123", "status": "captured"}

        result = fetch_razorpay_payment(razorpay_payment_id="pay_test/123")

        self.assertEqual(result["status"], "captured")
        session_class.return_value.request.assert_called_once_with(
            "GET",
            "https://api.razorpay.com/v1/payments/pay_test%2F123",
            auth=("rzp_test_key", "test_secret"),
            headers={"Accept": "application/json"},
            json=None,
        )

    @patch("apps.payments.services._TimeoutSession")
    def test_gateway_http_failure_returns_safe_service_error(self, session_class):
        response = session_class.return_value.request.return_value
        response.raise_for_status.side_effect = requests.HTTPError(
            "401 Client Error",
            response=response,
        )
        response.status_code = 401

        with self.assertRaisesRegex(
            RazorpayServiceError,
            "temporarily unavailable",
        ):
            create_razorpay_order(amount_paise=350000)

    def test_created_order_must_match_server_amount_and_currency(self):
        with self.assertRaisesRegex(
            RazorpayServiceError,
            "invalid order",
        ):
            validate_created_razorpay_order(
                {"id": "order_wrong_amount", "amount": 1, "currency": "INR"},
                expected_amount_paise=350000,
                expected_currency="INR",
                expected_receipt="p-test-receipt",
            )

        with self.assertRaisesRegex(
            RazorpayServiceError,
            "invalid order",
        ):
            validate_created_razorpay_order(
                {"id": "order_wrong_currency", "amount": 350000, "currency": "USD"},
                expected_amount_paise=350000,
                expected_currency="INR",
                expected_receipt="p-test-receipt",
            )

    def test_created_order_requires_a_valid_provider_identifier(self):
        with self.assertRaisesRegex(
            RazorpayServiceError,
            "invalid order",
        ):
            validate_created_razorpay_order(
                {"amount": 350000, "currency": "INR"},
                expected_amount_paise=350000,
                expected_currency="INR",
                expected_receipt="p-test-receipt",
            )

    def test_created_order_requires_canonical_new_unpaid_order_for_exact_receipt(self):
        valid_order = {
            "id": "order_created_123",
            "entity": "order",
            "amount": 350000,
            "amount_paid": 0,
            "amount_due": 350000,
            "currency": "INR",
            "receipt": "p-test-receipt",
            "status": "created",
        }

        self.assertIs(
            validate_created_razorpay_order(
                valid_order,
                expected_amount_paise=350000,
                expected_currency="INR",
                expected_receipt="p-test-receipt",
            ),
            valid_order,
        )

        invalid_variants = (
            {**valid_order, "status": "paid", "amount_paid": 350000, "amount_due": 0},
            {**valid_order, "receipt": "p-another-payment"},
            {**valid_order, "id": " order_created_123 "},
            {**valid_order, "currency": "inr"},
        )
        for invalid_order in invalid_variants:
            with self.subTest(invalid_order=invalid_order):
                with self.assertRaisesRegex(RazorpayServiceError, "invalid order"):
                    validate_created_razorpay_order(
                        invalid_order,
                        expected_amount_paise=350000,
                        expected_currency="INR",
                        expected_receipt="p-test-receipt",
                    )
