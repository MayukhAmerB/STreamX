"""Record refunds and take back the access a fully refunded payment granted.

Shared by the Razorpay refund webhook and the admin action for refunds issued
manually in the Razorpay dashboard. Every step is idempotent: the refunded
amount only ever grows, and access is revoked once, on the transition to the
refunded status.
"""

from dataclasses import dataclass, field
from decimal import Decimal

from django.db import transaction
from django.utils import timezone

from apps.courses.models import Course

from .batch_pass import deactivate_batch_pass
from .entitlements import resync_enrollment_access, tally
from .models import BatchPass, Payment

REFUNDABLE_STATUSES = (Payment.STATUS_PAID, Payment.STATUS_REFUNDED)


@dataclass
class RefundOutcome:
    payment: Payment
    recorded: bool = False
    newly_refunded: bool = False
    access: dict = field(default_factory=lambda: tally([]))

    @property
    def partial(self):
        return self.recorded and self.payment.status != Payment.STATUS_REFUNDED


def revoke_refunded_payment_access(payment):
    """Re-derive every enrollment the refunded payment was backing."""
    if not payment.user_id:
        return tally([])
    if payment.plan == Payment.PLAN_BATCH_PASS:
        batch_pass = BatchPass.objects.filter(payment=payment).first()
        if batch_pass is not None:
            return deactivate_batch_pass(batch_pass)
    course = Course.objects.filter(pk=payment.course_id).first()
    if course is None:
        return tally([])
    return tally([resync_enrollment_access(payment.user_id, course)])


@transaction.atomic
def record_refund(payment, *, amount_refunded, full=False):
    """Track the cumulative refunded amount; a full refund revokes access.

    ``amount_refunded`` is the provider's cumulative total, so replays and
    out-of-order events can never double count.
    """
    payment = Payment.objects.select_for_update().get(pk=payment.pk)
    outcome = RefundOutcome(payment=payment)
    if payment.status not in REFUNDABLE_STATUSES:
        return outcome

    amount_refunded = min(max(Decimal(amount_refunded), Decimal("0")), Decimal(payment.amount))
    update_fields = []
    if amount_refunded > payment.amount_refunded:
        payment.amount_refunded = amount_refunded
        update_fields.append("amount_refunded")
        outcome.recorded = True

    is_full = full or payment.amount_refunded >= Decimal(payment.amount)
    if is_full and payment.status != Payment.STATUS_REFUNDED:
        payment.status = Payment.STATUS_REFUNDED
        payment.refunded_at = timezone.now()
        update_fields.extend(["status", "refunded_at"])
        outcome.recorded = True
        outcome.newly_refunded = True

    if update_fields:
        payment.save(update_fields=[*update_fields, "updated_at"])
    if outcome.newly_refunded:
        outcome.access = revoke_refunded_payment_access(payment)
    return outcome


# ---------------------------------------------------------------------------
# Refunds that arrive before the capture was recorded.
# ---------------------------------------------------------------------------

PENDING_REFUND_KEY = "pending_refund"


def record_pending_refund(payment, *, razorpay_payment_id, amount_refunded, full):
    """Remember a refund for a payment this order has not recorded as captured yet.

    Webhooks are not ordered: refund.processed can be handled while the order
    is still ``created`` (capture webhook delayed, browser closed before
    verify). The refund is kept, bound to the Razorpay payment id, so that the
    capture of that payment ends in ``refunded`` without granting access
    (see ``apply_pending_refund``). Caller holds the payment row lock.
    Returns True when the marker changed.
    """
    amount_refunded = min(max(Decimal(amount_refunded), Decimal("0")), Decimal(payment.amount))
    details = dict(payment.gateway_details or {})
    previous = details.get(PENDING_REFUND_KEY) or {}
    if previous.get("razorpay_payment_id") == razorpay_payment_id:
        amount_refunded = max(amount_refunded, Decimal(str(previous.get("amount_refunded") or "0")))
        full = bool(full or previous.get("full"))
    marker = {
        "razorpay_payment_id": razorpay_payment_id,
        "amount_refunded": str(amount_refunded),
        "full": bool(full or amount_refunded >= Decimal(payment.amount)),
        "recorded_at": previous.get("recorded_at") or timezone.now().isoformat(),
    }
    if previous == marker:
        return False
    details[PENDING_REFUND_KEY] = marker
    payment.gateway_details = details
    payment.save(update_fields=["gateway_details", "updated_at"])
    return True


def apply_pending_refund(payment):
    """Apply a refund recorded before capture to a now-paid payment.

    Returns the ``RefundOutcome`` (``None`` when there is nothing to apply).
    A full refund leaves the payment ``refunded``; callers must then not grant
    access.
    """
    marker = (payment.gateway_details or {}).get(PENDING_REFUND_KEY) or {}
    if not marker or payment.status != Payment.STATUS_PAID:
        return None
    if marker.get("razorpay_payment_id") != payment.razorpay_payment_id:
        return None  # A different payment of this order was captured.
    return record_refund(
        payment,
        amount_refunded=Decimal(str(marker.get("amount_refunded") or "0")),
        full=bool(marker.get("full")),
    )
