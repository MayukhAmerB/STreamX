from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from .gateway_audit import set_gateway_audit
from .idempotency import serialized_checkout
from .models import Payment
from .pricing import get_plan_terms
from .services import RazorpayServiceError, validate_created_razorpay_order


@dataclass(frozen=True)
class PaymentOrderResult:
    payment: Payment
    order: dict[str, Any] | None = None
    error: str = ""
    blocked_by_existing: bool = False

    @property
    def succeeded(self) -> bool:
        return self.order is not None and not self.error


def create_payment_order(
    *,
    user: Any,
    course: Any,
    amount: Any,
    amount_paise: int,
    plan: str,
    checkout_profile: Mapping[str, Any],
    gateway_create_order: Callable[..., dict[str, Any]],
    application: Any = None,
) -> PaymentOrderResult:
    with serialized_checkout(
        user=user,
        buyer_email=checkout_profile["buyer_email"],
        course=course,
    ):
        open_payments = Payment.objects.filter(
            course=course,
            status=Payment.STATUS_CREATED,
        )
        if user and user.is_authenticated:
            open_payments = open_payments.filter(user=user)
        else:
            open_payments = open_payments.filter(
                user__isnull=True,
                buyer_email__iexact=checkout_profile["buyer_email"],
            )
        existing_payment = open_payments.order_by("created_at").first()
        if existing_payment:
            return PaymentOrderResult(
                payment=existing_payment,
                error="An existing checkout was detected. Retry to reconcile it; do not pay again.",
                blocked_by_existing=True,
            )

        payment = Payment.objects.create(
            application=application,
            terms_snapshot=get_plan_terms(course, plan),
            user=user if user and user.is_authenticated else None,
            course=course,
            amount=amount,
            currency="INR",
            status=Payment.STATUS_CREATED,
            plan=plan,
            gateway_status="initializing",
            buyer_name=checkout_profile["buyer_name"],
            buyer_email=checkout_profile["buyer_email"],
            whatsapp_number=checkout_profile["whatsapp_number"],
            alternate_number=checkout_profile.get("alternate_number", ""),
            age=checkout_profile.get("age"),
            country=checkout_profile.get("country", ""),
            state=checkout_profile.get("state", ""),
            city=checkout_profile.get("city", ""),
            pincode=checkout_profile.get("pincode", ""),
        )
        receipt = f"p-{payment.internal_reference.hex[:24]}"
        try:
            order = validate_created_razorpay_order(
                gateway_create_order(
                    amount_paise=amount_paise,
                    currency="INR",
                    receipt=receipt,
                ),
                expected_amount_paise=amount_paise,
                expected_currency="INR",
                expected_receipt=receipt,
            )
        except RazorpayServiceError as exc:
            payment.status = Payment.STATUS_FAILED
            payment.gateway_status = "order_creation_failed"
            payment.failure_reason = str(exc)[:2000]
            payment.save(
                update_fields=[
                    "status",
                    "gateway_status",
                    "failure_reason",
                    "updated_at",
                ]
            )
            return PaymentOrderResult(payment=payment, error=str(exc))

        payment.razorpay_order_id = str(order["id"])
        payment.currency = str(order.get("currency") or "INR")
        set_gateway_audit(payment, order, detail_key="order")
        payment.save(
            update_fields=[
                "razorpay_order_id",
                "currency",
                "gateway_status",
                "gateway_details",
                "updated_at",
            ]
        )
        return PaymentOrderResult(payment=payment, order=order)
