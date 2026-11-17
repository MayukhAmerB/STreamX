import hashlib
import hmac
import logging
import re
import time
from urllib.parse import quote

import requests
from config.metrics import record_upstream_request
from django.conf import settings

logger = logging.getLogger(__name__)
RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1"
RAZORPAY_ORDER_ID_PATTERN = re.compile(r"^order_[A-Za-z0-9_-]{1,120}$")
RAZORPAY_BREAKER_NAME = "razorpay"
GATEWAY_UNAVAILABLE_MESSAGE = "The payment gateway is temporarily unavailable. Please try again shortly."
CIRCUIT_OPEN_MESSAGE = "Payments are temporarily unavailable. Please try again in a minute; you have not been charged."


class RazorpayServiceError(Exception):
    pass


class RazorpayUnavailable(RazorpayServiceError):
    """Razorpay is down, slow, answering 5xx/429, or its circuit is open.

    A subclass of ``RazorpayServiceError`` so every existing caller keeps
    working; callers that care (verify, checkout) answer 503 + retry instead of
    a client error. ``reason`` is one of circuit_open, timeout,
    connection_error, upstream_5xx, rate_limited, invalid_response, error.
    """

    code = "payment_gateway_unavailable"

    def __init__(self, message=GATEWAY_UNAVAILABLE_MESSAGE, *, reason="", retry_after=None):
        super().__init__(message)
        self.reason = reason
        self.retry_after = retry_after


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


def razorpay_breaker():
    from apps.core.circuit import get_breaker

    return get_breaker(RAZORPAY_BREAKER_NAME)


def ensure_gateway_available():
    """Raise ``RazorpayUnavailable`` while the Razorpay circuit is OPEN.

    Checkout flows call this before writing any row, so an outage never leaves
    half-created orders behind. Read-only (a half-open circuit lets the call
    through as the probe) and fail-open: a cache/Redis error means "available".
    """
    from apps.core.circuit import STATE_OPEN

    try:
        breaker = razorpay_breaker()
        state = breaker.state()
        retry_after = breaker.config.open_seconds
    except Exception:  # noqa: BLE001 - breaker trouble must never block payments
        return
    if state == STATE_OPEN:
        record_upstream_request(upstream=RAZORPAY_BREAKER_NAME, method="PRECHECK", outcome="circuit_open")
        raise RazorpayUnavailable(CIRCUIT_OPEN_MESSAGE, reason="circuit_open", retry_after=retry_after)


def _retry_settings():
    attempts = max(1, int(getattr(settings, "RAZORPAY_HTTP_MAX_ATTEMPTS", 2) or 1))
    deadline = max(1.0, float(getattr(settings, "RAZORPAY_HTTP_RETRY_DEADLINE_SECONDS", 20) or 20))
    base = max(0.0, float(getattr(settings, "RAZORPAY_HTTP_BACKOFF_BASE_SECONDS", 0.3) or 0.0))
    cap = max(base, float(getattr(settings, "RAZORPAY_HTTP_BACKOFF_CAP_SECONDS", 2.0) or 0.0))
    return attempts, deadline, base, cap


def _classify_failure(exc):
    """(reason, transient, request_never_sent) for an exception from one attempt."""
    if isinstance(exc, requests.exceptions.ConnectTimeout):
        return "timeout", True, True
    if isinstance(exc, requests.exceptions.Timeout):
        return "timeout", True, False
    if isinstance(exc, requests.exceptions.ConnectionError):
        return "connection_error", True, False
    status_code = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status_code, int):
        if status_code >= 500:
            return "upstream_5xx", True, False
        if status_code == 429:
            return "rate_limited", True, False
        return "client_error", False, False
    if isinstance(exc, ValueError):
        return "invalid_response", True, False
    return "error", True, False


def _razorpay_request(method, path, *, json_body=None, retry_safe=None):
    """One logical Razorpay API call: timeout, circuit breaker, bounded retries.

    * Every attempt goes through the shared ``razorpay`` circuit breaker
      (``apps.core.circuit``: state in Redis, shared by both payment-backend
      replicas, fail-open). Network errors, timeouts and 5xx count as
      failures; 4xx and 429 never trip it.
    * Transient failures are retried (``RAZORPAY_HTTP_MAX_ATTEMPTS``,
      full-jitter backoff) only while the retry can still finish inside
      ``RAZORPAY_HTTP_RETRY_DEADLINE_SECONDS``: gunicorn kills a payment
      worker at 30s, so a timed-out attempt is not retried.
    * ``retry_safe`` defaults to GET. A POST is retried only when the request
      was never sent (connect timeout), unless the caller marks it safe
      (creating an order twice leaves only an orphan order nobody can pay).
    """
    from apps.core.circuit import CircuitOpenError
    from apps.core.http import backoff_delay

    key_id, key_secret = _razorpay_credentials()
    method = str(method).upper()
    retry_safe = (method == "GET") if retry_safe is None else bool(retry_safe)
    max_attempts, deadline, backoff_base, backoff_cap = _retry_settings()
    timeout_seconds = getattr(settings, "RAZORPAY_HTTP_TIMEOUT_SECONDS", 12)
    session = _TimeoutSession(timeout_seconds=timeout_seconds)
    breaker = razorpay_breaker()
    started = time.monotonic()
    last_exc = None
    last_reason = ""
    for attempt in range(max_attempts):
        try:
            permit = breaker.allow()
        except CircuitOpenError as exc:
            record_upstream_request(upstream=RAZORPAY_BREAKER_NAME, method=method, outcome="circuit_open")
            logger.warning("Razorpay circuit open: method=%s path=%s", method, path)
            raise RazorpayUnavailable(CIRCUIT_OPEN_MESSAGE, reason="circuit_open", retry_after=exc.retry_after) from exc
        attempt_started = time.monotonic()
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
        except Exception as exc:  # noqa: BLE001 - classified below
            reason, transient, never_sent = _classify_failure(exc)
            if transient and reason != "rate_limited":
                permit.failure()
            else:
                permit.release()
            record_upstream_request(
                upstream=RAZORPAY_BREAKER_NAME,
                method=method,
                outcome=reason,
                elapsed_seconds=time.monotonic() - attempt_started,
            )
            status_code = getattr(getattr(exc, "response", None), "status_code", None)
            logger.warning(
                "Razorpay API request failed: method=%s path=%s status=%s reason=%s attempt=%s/%s",
                method,
                path,
                status_code or "unavailable",
                reason,
                attempt + 1,
                max_attempts,
            )
            last_exc, last_reason = exc, reason
            if not transient or attempt + 1 >= max_attempts or not (retry_safe or never_sent):
                break
            delay = backoff_delay(attempt, base=backoff_base, cap=backoff_cap)
            if time.monotonic() - started + delay + float(timeout_seconds) > deadline:
                break
            time.sleep(delay)
            continue
        permit.success()
        record_upstream_request(
            upstream=RAZORPAY_BREAKER_NAME,
            method=method,
            outcome="2xx",
            elapsed_seconds=time.monotonic() - attempt_started,
        )
        return payload

    logger.error(
        "Razorpay API request gave up: method=%s path=%s reason=%s",
        method,
        path,
        last_reason or "unknown",
        exc_info=last_exc,
    )
    if last_reason == "client_error":
        raise RazorpayServiceError(GATEWAY_UNAVAILABLE_MESSAGE) from last_exc
    raise RazorpayUnavailable(GATEWAY_UNAVAILABLE_MESSAGE, reason=last_reason) from last_exc


def _rewrap(exc, message):
    """The same failure with a caller-specific message, keeping the transient type."""
    if isinstance(exc, RazorpayUnavailable):
        return RazorpayUnavailable(message, reason=exc.reason, retry_after=exc.retry_after)
    return RazorpayServiceError(message)


def create_razorpay_order(*, amount_paise, currency="INR", receipt=""):
    try:
        return _razorpay_request(
            "POST",
            "/orders",
            retry_safe=True,
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
        raise _rewrap(exc, "Failed to confirm payment status with Razorpay.") from exc


def fetch_razorpay_order(*, razorpay_order_id):
    order_id = quote(str(razorpay_order_id or "").strip(), safe="")
    if not order_id:
        raise RazorpayServiceError("Razorpay order ID is required.")
    try:
        return _razorpay_request("GET", f"/orders/{order_id}")
    except RazorpayServiceError as exc:
        raise _rewrap(exc, "Failed to confirm order status with Razorpay.") from exc


def fetch_razorpay_order_payments(*, razorpay_order_id):
    order_id = quote(str(razorpay_order_id or "").strip(), safe="")
    if not order_id:
        raise RazorpayServiceError("Razorpay order ID is required.")
    try:
        return _razorpay_request("GET", f"/orders/{order_id}/payments")
    except RazorpayServiceError as exc:
        raise _rewrap(exc, "Failed to confirm order payments with Razorpay.") from exc


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


# ---------------------------------------------------------------------------
# Razorpay Subscriptions and Plans (platform memberships)
# ---------------------------------------------------------------------------
RAZORPAY_SUBSCRIPTION_ID_PATTERN = re.compile(r"^sub_[A-Za-z0-9_-]{1,120}$")
RAZORPAY_PLAN_ID_PATTERN = re.compile(r"^plan_[A-Za-z0-9_-]{1,120}$")


def _subscription_path(subscription_id, suffix=""):
    value = str(subscription_id or "").strip()
    if not RAZORPAY_SUBSCRIPTION_ID_PATTERN.fullmatch(value):
        raise RazorpayServiceError("Invalid Razorpay subscription ID.")
    return f"/subscriptions/{quote(value, safe='')}{suffix}"


def create_razorpay_subscription(*, plan_id, total_count, notes=None, customer_notify=True):
    if not RAZORPAY_PLAN_ID_PATTERN.fullmatch(str(plan_id or "")):
        raise RazorpayServiceError("Invalid Razorpay plan ID.")
    payload = _razorpay_request(
        "POST",
        "/subscriptions",
        json_body={
            "plan_id": plan_id,
            "total_count": int(total_count),
            "quantity": 1,
            "customer_notify": 1 if customer_notify else 0,
            "notes": {str(k): str(v)[:250] for k, v in (notes or {}).items()},
        },
    )
    subscription_id = str(payload.get("id") or "")
    if (
        payload.get("entity") != "subscription"
        or not RAZORPAY_SUBSCRIPTION_ID_PATTERN.fullmatch(subscription_id)
        or payload.get("plan_id") != plan_id
    ):
        logger.error("Razorpay created-subscription response failed validation.")
        raise RazorpayServiceError("The payment gateway returned an invalid subscription.")
    return payload


def fetch_razorpay_subscription(*, subscription_id):
    return _razorpay_request("GET", _subscription_path(subscription_id))


def cancel_razorpay_subscription(*, subscription_id, at_cycle_end=True):
    return _razorpay_request(
        "POST",
        _subscription_path(subscription_id, "/cancel"),
        retry_safe=True,
        json_body={"cancel_at_cycle_end": 1 if at_cycle_end else 0},
    )


def create_razorpay_plan(*, period, interval, amount_paise, name, description="", notes=None):
    if period not in {"monthly", "yearly"}:
        raise RazorpayServiceError("Unsupported plan period.")
    payload = _razorpay_request(
        "POST",
        "/plans",
        json_body={
            "period": period,
            "interval": int(interval),
            "item": {
                "name": str(name)[:100],
                "amount": int(amount_paise),
                "currency": "INR",
                "description": str(description)[:250],
            },
            "notes": {str(k): str(v)[:250] for k, v in (notes or {}).items()},
        },
    )
    plan_id = str(payload.get("id") or "")
    if not RAZORPAY_PLAN_ID_PATTERN.fullmatch(plan_id):
        raise RazorpayServiceError("The payment gateway returned an invalid plan.")
    return payload


def verify_razorpay_subscription_signature(*, razorpay_payment_id, razorpay_subscription_id, razorpay_signature):
    """Checkout success signature for subscriptions: HMAC(payment_id + "|" + subscription_id)."""
    _, key_secret = _razorpay_credentials()
    message = f"{razorpay_payment_id}|{razorpay_subscription_id}".encode()
    expected_signature = hmac.new(
        key=key_secret.encode("utf-8"),
        msg=message,
        digestmod=hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected_signature, str(razorpay_signature or "")):
        raise RazorpayServiceError("Razorpay signature verification failed.")
    return True
