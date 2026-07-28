import hashlib
import hmac
import logging
from urllib.parse import quote

import requests
from django.conf import settings


logger = logging.getLogger(__name__)
RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1"


class RazorpayServiceError(Exception):
    pass


class _TimeoutSession(requests.Session):
    def __init__(self, *, timeout_seconds):
        super().__init__()
        self.timeout_seconds = max(1.0, float(timeout_seconds))

    def request(self, method, url, **kwargs):
        kwargs.setdefault("timeout", self.timeout_seconds)
        return super().request(method, url, **kwargs)


def _razorpay_credentials():
    if not settings.RAZORPAY_KEY_ID or not settings.RAZORPAY_KEY_SECRET:
        raise RazorpayServiceError("Razorpay credentials are not configured.")
    return settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET


def _razorpay_request(method, path, *, json_body=None):
    key_id, key_secret = _razorpay_credentials()
    session = _TimeoutSession(
        timeout_seconds=getattr(settings, "RAZORPAY_HTTP_TIMEOUT_SECONDS", 12)
    )
    try:
        response = session.request(
            method,
            f"{RAZORPAY_API_BASE_URL}{path}",
            auth=(key_id, key_secret),
            headers={"Accept": "application/json"},
            json=json_body,
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Razorpay returned a non-object response.")
        return payload
    except Exception as exc:
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        logger.exception(
            "Razorpay API request failed: method=%s path=%s status=%s",
            method,
            path,
            status_code or "unavailable",
        )
        raise RazorpayServiceError(
            "The payment gateway is temporarily unavailable. Please try again shortly."
        ) from exc


def create_razorpay_order(*, amount_paise, currency="INR", receipt=""):
    try:
        return _razorpay_request(
            "POST",
            "/orders",
            json_body={
                "amount": amount_paise,
                "currency": currency,
                "receipt": receipt or "alsyedinitiative-order",
                "payment_capture": 1,
            },
        )
    except RazorpayServiceError:
        raise


def verify_razorpay_signature(*, razorpay_order_id, razorpay_payment_id, razorpay_signature):
    _, key_secret = _razorpay_credentials()
    message = f"{razorpay_order_id}|{razorpay_payment_id}".encode("utf-8")
    expected_signature = hmac.new(
        key=key_secret.encode("utf-8"),
        msg=message,
        digestmod=hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected_signature, str(razorpay_signature or "")):
        raise RazorpayServiceError("Razorpay signature verification failed.")
    return True


def fetch_razorpay_payment(*, razorpay_payment_id):
    payment_id = quote(str(razorpay_payment_id or "").strip(), safe="")
    if not payment_id:
        raise RazorpayServiceError("Razorpay payment ID is required.")
    try:
        return _razorpay_request("GET", f"/payments/{payment_id}")
    except RazorpayServiceError as exc:
        raise RazorpayServiceError(
            "Failed to confirm payment status with Razorpay."
        ) from exc


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
