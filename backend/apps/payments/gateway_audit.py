from typing import Any


def safe_gateway_entity(entity: object) -> dict[str, str | int | float | bool]:
    """Retain operational gateway fields without card, VPA, or bank payloads."""
    if not isinstance(entity, dict):
        return {}
    allowed_fields = (
        "id",
        "entity",
        "order_id",
        "amount",
        "amount_paid",
        "amount_due",
        "amount_refunded",
        "currency",
        "receipt",
        "status",
        "attempts",
        "international",
        "method",
        "captured",
        "refund_status",
        "fee",
        "tax",
        "created_at",
        "error_code",
        "error_description",
        "error_source",
        "error_step",
        "error_reason",
    )
    return {
        key: value
        for key in allowed_fields
        if (value := entity.get(key)) is not None
        and isinstance(value, (str, int, float, bool))
    }


def set_gateway_audit(
    payment: Any,
    entity: object,
    *,
    detail_key: str = "payment",
    event: str = "",
    failure_reason: str = "",
) -> None:
    safe_entity = safe_gateway_entity(entity)
    details = dict(payment.gateway_details or {})
    if safe_entity:
        details[detail_key] = safe_entity
        payment.gateway_details = details
    gateway_status = str(safe_entity.get("status") or "").strip().lower()
    if gateway_status:
        payment.gateway_status = gateway_status
    payment_method = str(safe_entity.get("method") or "").strip().lower()
    if payment_method:
        payment.payment_method = payment_method
    if event:
        payment.last_webhook_event = str(event)[:120]
    if failure_reason:
        payment.failure_reason = str(failure_reason)[:2000]
