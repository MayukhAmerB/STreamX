import hashlib
import hmac
import logging
import re
from urllib.parse import quote

import requests
from django.conf import settings

logger = logging.getLogger(__name__)
RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1"
RAZORPAY_ORDER_ID_PATTERN = re.compile(r"^order_[A-Za-z0-9_-]{1,120}$")


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


def validate_created_razorpay_order(
    order,
    *,
    expected_amount_paise,
    expected_currency="INR",
    expected_receipt,
):
    """Reject malformed or financially inconsistent provider order responses."""
    if not isinstance(order, dict):
        raise RazorpayServiceError("The payment gateway returned an invalid order.")

    raw_order_id = order.get("id")
    order_id = raw_order_id.strip() if isinstance(raw_order_id, str) else ""
    amount = order.get("amount")
    raw_currency = order.get("currency")
    expected_currency = str(expected_currency or "").strip().upper()
    valid_amount = (
        isinstance(amount, int)
        and not isinstance(amount, bool)
        and amount == int(expected_amount_paise)
    )
    amount_paid = order.get("amount_paid")
    amount_due = order.get("amount_due")
    valid_state = (
        order.get("entity") == "order"
        and order.get("status") == "created"
        and isinstance(amount_paid, int)
        and not isinstance(amount_paid, bool)
        and amount_paid == 0
        and isinstance(amount_due, int)
        and not isinstance(amount_due, bool)
        and amount_due == int(expected_amount_paise)
    )
    valid_receipt = order.get("receipt") == expected_receipt
    canonical_values = (
        raw_order_id == order_id
        and raw_currency == expected_currency
    )
    if (
        not RAZORPAY_ORDER_ID_PATTERN.fullmatch(order_id)
        or not valid_amount
        or not canonical_values
        or not valid_state
        or not valid_receipt
    ):
        logger.error(
            "Razorpay created-order response failed validation: has_id=%s amount_matches=%s currency_matches=%s state_matches=%s receipt_matches=%s",
            bool(order_id),
            valid_amount,
            raw_currency == expected_currency,
            valid_state,
            valid_receipt,
        )
        raise RazorpayServiceError("The payment gateway returned an invalid order.")
    return order


def verify_razorpay_signature(*, razorpay_order_id, razorpay_payment_id, razorpay_signature):
    _, key_secret = _razorpay_credentials()
    message = f"{razorpay_order_id}|{razorpay_payment_id}".encode()
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


def fetch_razorpay_order(*, razorpay_order_id):
    order_id = quote(str(razorpay_order_id or "").strip(), safe="")
    if not order_id:
        raise RazorpayServiceError("Razorpay order ID is required.")
    try:
        return _razorpay_request("GET", f"/orders/{order_id}")
    except RazorpayServiceError as exc:
        raise RazorpayServiceError(
            "Failed to confirm order status with Razorpay."
        ) from exc


def fetch_razorpay_order_payments(*, razorpay_order_id):
    order_id = quote(str(razorpay_order_id or "").strip(), safe="")
    if not order_id:
        raise RazorpayServiceError("Razorpay order ID is required.")
    try:
        return _razorpay_request("GET", f"/orders/{order_id}/payments")
    except RazorpayServiceError as exc:
        raise RazorpayServiceError(
            "Failed to confirm order payments with Razorpay."
        ) from exc


def validate_existing_razorpay_order(
    order,
    *,
    expected_order_id,
    expected_amount_paise,
    expected_currency="INR",
    expected_receipt,
):
    """Validate an existing provider order before it is resumed or reconciled."""
    if not isinstance(order, dict):
        raise RazorpayServiceError("The payment gateway returned an invalid order.")

    order_id = str(order.get("id") or "").strip()
    currency = str(order.get("currency") or "").strip().upper()
    provider_status = str(order.get("status") or "").strip().lower()
    expected_amount_paise = int(expected_amount_paise)
    amount = order.get("amount")
    amount_paid = order.get("amount_paid")
    amount_due = order.get("amount_due")
    integer_values = all(
        isinstance(value, int) and not isinstance(value, bool)
        for value in (amount, amount_paid, amount_due)
    )
    valid_balance = (
        provider_status in {"created", "attempted"}
        and amount_paid == 0
        and amount_due == expected_amount_paise
    ) or (
        provider_status == "paid"
        and amount_paid == expected_amount_paise
        and amount_due == 0
    )
    if not (
        order.get("entity") == "order"
        and order_id == str(expected_order_id or "").strip()
        and RAZORPAY_ORDER_ID_PATTERN.fullmatch(order_id)
        and integer_values
        and amount == expected_amount_paise
        and currency == str(expected_currency or "").strip().upper()
        and order.get("receipt") == expected_receipt
        and provider_status in {"created", "attempted", "paid"}
        and valid_balance
    ):
        logger.error(
            "Razorpay existing-order response failed validation: order_matches=%s amount_matches=%s currency_matches=%s status=%s receipt_matches=%s",
            order_id == str(expected_order_id or "").strip(),
            amount == expected_amount_paise,
            currency == str(expected_currency or "").strip().upper(),
            provider_status or "missing",
            order.get("receipt") == expected_receipt,
        )
        raise RazorpayServiceError("The payment gateway returned an invalid order.")
    return order


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
