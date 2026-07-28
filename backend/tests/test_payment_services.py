import hashlib
import hmac
from unittest.mock import patch

import requests
from django.test import SimpleTestCase, override_settings

from apps.payments.services import (
    RazorpayServiceError,
    create_razorpay_order,
    fetch_razorpay_payment,
    verify_razorpay_signature,
)


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
