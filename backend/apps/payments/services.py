import hashlib
import hmac

import requests
from django.conf import settings


class RazorpayServiceError(Exception):
    pass


class _TimeoutSession(requests.Session):
    def __init__(self, *, timeout_seconds):
        super().__init__()
        self.timeout_seconds = max(1.0, float(timeout_seconds))

    def request(self, method, url, **kwargs):
        kwargs.setdefault("timeout", self.timeout_seconds)
        return super().request(method, url, **kwargs)


def get_razorpay_client():
    if not settings.RAZORPAY_KEY_ID or not settings.RAZORPAY_KEY_SECRET:
        raise RazorpayServiceError("Razorpay credentials are not configured.")
    try:
        import razorpay
    except ModuleNotFoundError as exc:
        raise RazorpayServiceError(
            "Razorpay SDK dependency is unavailable. Install setuptools and razorpay dependencies."
        ) from exc
    session = _TimeoutSession(
        timeout_seconds=getattr(settings, "RAZORPAY_HTTP_TIMEOUT_SECONDS", 12)
    )
    return razorpay.Client(
        session=session,
        auth=(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET),
    )


def create_razorpay_order(*, amount_paise, currency="INR", receipt=""):
    client = get_razorpay_client()
    try:
        return client.order.create(
            {
                "amount": amount_paise,
                "currency": currency,
                "receipt": receipt or "alsyedinitiative-order",
                "payment_capture": 1,
            }
        )
    except Exception as exc:
        raise RazorpayServiceError("Failed to create Razorpay order.") from exc


def verify_razorpay_signature(*, razorpay_order_id, razorpay_payment_id, razorpay_signature):
    client = get_razorpay_client()
    payload = {
        "razorpay_order_id": razorpay_order_id,
        "razorpay_payment_id": razorpay_payment_id,
        "razorpay_signature": razorpay_signature,
    }
    try:
        client.utility.verify_payment_signature(payload)
        return True
    except Exception as exc:
        raise RazorpayServiceError("Razorpay signature verification failed.") from exc


def fetch_razorpay_payment(*, razorpay_payment_id):
    client = get_razorpay_client()
    try:
        return client.payment.fetch(razorpay_payment_id)
    except Exception as exc:
        raise RazorpayServiceError("Failed to confirm payment status with Razorpay.") from exc


def verify_razorpay_webhook_signature(*, payload_body, razorpay_signature):
    webhook_secret = str(getattr(settings, "RAZORPAY_WEBHOOK_SECRET", "") or "").strip()
    if not webhook_secret:
        raise RazorpayServiceError("Razorpay webhook secret is not configured.")

    signature = str(razorpay_signature or "").strip()
    if not signature:
        raise RazorpayServiceError("Missing Razorpay webhook signature header.")

    body = payload_body.encode("utf-8") if isinstance(payload_body, str) else bytes(payload_body or b"")
    if not body:
        raise RazorpayServiceError("Webhook payload is empty.")

    expected_signature = hmac.new(
        key=webhook_secret.encode("utf-8"),
        msg=body,
        digestmod=hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected_signature, signature):
        raise RazorpayServiceError("Razorpay webhook signature verification failed.")
    return True
