"""Small, stable gateway adapter for modules outside the course flow (apps.billing).

It only calls the existing Razorpay integration in ``services`` and lets other
modules claim webhooks for their own orders. Nothing here changes how course,
batch-pass or platform payments behave.
"""

from __future__ import annotations

from collections.abc import Callable

from django.conf import settings

from .services import (
    RazorpayServiceError,
    RazorpayUnavailable,
    create_razorpay_order,
    ensure_gateway_available,
    validate_created_razorpay_order,
    verify_razorpay_signature,
)

GatewayError = RazorpayServiceError
GatewayUnavailable = RazorpayUnavailable


def ensure_available() -> None:
    """Raise ``GatewayUnavailable`` while the Razorpay circuit is open (fail-open)."""
    ensure_gateway_available()

# Callables ``handler(payload: dict, *, request=None) -> dict | None``. A handler
# returns ``None`` for an event that is not its own; the first non-None result
# wins. Called by ``platform_webhooks.route_platform_event`` only after every
# existing route declined the event, inside the existing de-duplicated webhook.
_ORDER_EVENT_HANDLERS: list[Callable] = []


def register_order_event_handler(handler: Callable) -> None:
    if handler not in _ORDER_EVENT_HANDLERS:
        _ORDER_EVENT_HANDLERS.append(handler)


def route_registered_order_event(payload: dict, *, request=None):
    for handler in list(_ORDER_EVENT_HANDLERS):
        result = handler(payload, request=request)
        if result is not None:
            return result
    return None


def create_order(*, amount_paise: int, receipt: str, currency: str = "INR") -> dict:
    """Create and validate a Razorpay order (raises ``GatewayError``)."""
    order = create_razorpay_order(amount_paise=amount_paise, currency=currency, receipt=receipt)
    return validate_created_razorpay_order(
        order, expected_amount_paise=amount_paise, expected_currency=currency, expected_receipt=receipt
    )


def verify_checkout_signature(*, order_id: str, payment_id: str, signature: str) -> None:
    """Raise ``GatewayError`` unless the Razorpay checkout signature is valid."""
    verify_razorpay_signature(
        razorpay_order_id=order_id, razorpay_payment_id=payment_id, razorpay_signature=signature
    )


def public_key_id() -> str:
    return getattr(settings, "RAZORPAY_KEY_ID", "") or ""
