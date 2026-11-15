"""Route Razorpay webhooks that belong to platform plans away from the course flow.

Called first by ``views.process_payment_webhook_payload`` (so de-duplication by
``X-Razorpay-Event-Id``, retries and the audit row stay exactly as they are).
Returns ``None`` for every event that is not a platform event, leaving the
existing course-payment processing untouched.
"""

from __future__ import annotations

from .models import Payment

REFUND_EVENTS = {"refund.processed", "payment.refunded"}


def route_platform_event(payload: dict, *, request=None):
    event = str(payload.get("event") or "").strip().lower()
    body = payload.get("payload") or {}
    if event.startswith("subscription."):
        from .subscriptions import handle_event

        return handle_event(payload, request=request)
    payment_entity = (body.get("payment") or {}).get("entity") or {}
    if payment_entity.get("subscription_id") and event.startswith("payment."):
        from .subscriptions import handle_payment_event

        return handle_payment_event(payload, request=request)
    order_id = str(payment_entity.get("order_id") or ((body.get("order") or {}).get("entity") or {}).get("id") or "").strip()
    payment = None
    if order_id:
        payment = (
            Payment.objects.filter(razorpay_order_id=order_id, plan=Payment.PLAN_PLATFORM_ONE_TIME)
            .only("pk")
            .first()
        )
    elif event in REFUND_EVENTS:
        refund_entity = (body.get("refund") or {}).get("entity") or {}
        payment_id = str(payment_entity.get("id") or refund_entity.get("payment_id") or "").strip()
        if payment_id:
            payment = (
                Payment.objects.filter(razorpay_payment_id=payment_id, plan=Payment.PLAN_PLATFORM_ONE_TIME)
                .only("pk")
                .first()
            )
    if payment is None:
        # Orders owned by other modules (apps.billing) via ``gateway``; None otherwise.
        from .gateway import route_registered_order_event

        return route_registered_order_event(payload, request=request)
    from .platform_orders import handle_order_event

    return handle_order_event(payment, payload, request=request)
