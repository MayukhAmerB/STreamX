"""One-time platform plans (Foundations Bootcamp, Lifetime): Razorpay Orders.

The order amount is frozen on ``Payment.amount`` and ``terms_snapshot`` when
the order is created (like per-course plans): verification, webhooks and
refunds compare against the stored order only.

Access follows the ``BatchPass`` pattern: an active ``PlatformGrant`` per
payment, materialised as lifetime Enrollments for every course in the plan's
scope (``platform_plans.plan_scope_course_ids``). A refund or a deactivated
grant re-derives each enrollment through ``entitlements.resync_enrollment_access``
so access the student paid for separately is kept.
"""

from __future__ import annotations

from decimal import Decimal

from config.audit import log_security_event
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.courses.models import Course, Enrollment

from .entitlements import resync_enrollment_access, tally
from .models import Payment, PlatformGrant, PlatformPlan
from .platform_plans import STATE_AVAILABLE, gate_feature_key, plan_amount_paise, plan_gate, plan_scope_course_ids
from .plans import to_rupees
from .services import (
    RazorpayServiceError,
    create_razorpay_order,
    validate_created_razorpay_order,
    verify_razorpay_signature,
)
from .subscriptions import SubscriptionError

PlatformOrderError = SubscriptionError


def _receipt(payment) -> str:
    return f"pp-{str(payment.internal_reference)[:30]}"


def _plan_or_404(plan_key) -> PlatformPlan:
    plan = PlatformPlan.objects.filter(key=str(plan_key or "").strip()).first()
    if plan is None:
        raise PlatformOrderError("plan_not_found", "This plan does not exist.", 404)
    return plan


def user_holds_plan(user, plan) -> bool:
    return PlatformGrant.objects.filter(user=user, plan=plan, is_active=True).exists()


def check_purchasable(plan: PlatformPlan) -> None:
    if plan.is_subscription:
        raise PlatformOrderError("plan_is_subscription", "This plan is a subscription.", 400)
    feature = gate_feature_key(plan)
    if feature:
        from apps.core import features

        raise PlatformOrderError("feature_disabled", features.reason_for(feature), 403, feature=feature)
    state, _code, reason = plan_gate(plan)
    if state != STATE_AVAILABLE:
        raise PlatformOrderError("plan_unavailable", reason, 403)


def create_order(user, plan_key, *, request=None) -> Payment:
    plan = _plan_or_404(plan_key)
    check_purchasable(plan)
    if user_holds_plan(user, plan):
        raise PlatformOrderError("already_owned", "You already have this plan.", 409)
    amount = to_rupees(plan.price_inr)
    with transaction.atomic():
        payment = Payment.objects.create(
            user=user,
            platform_plan=plan,
            plan=Payment.PLAN_PLATFORM_ONE_TIME,
            amount=amount,
            currency="INR",
            status=Payment.STATUS_CREATED,
            buyer_email=getattr(user, "email", "") or "",
            buyer_name=(getattr(user, "full_name", "") or "")[:255],
            course_title_snapshot=plan.title[:255],
            terms_snapshot={"platform_plan": plan.key, "product": plan.product, "price_inr": format(amount, ".2f")},
        )
    receipt = _receipt(payment)
    try:
        order = create_razorpay_order(amount_paise=plan_amount_paise(plan), currency="INR", receipt=receipt)
        validate_created_razorpay_order(order, expected_amount_paise=plan_amount_paise(plan), expected_receipt=receipt)
    except RazorpayServiceError as exc:
        payment.status = Payment.STATUS_FAILED
        payment.failure_reason = str(exc)[:500]
        payment.save(update_fields=["status", "failure_reason", "updated_at"])
        raise PlatformOrderError("upstream_unavailable", str(exc), 503) from exc
    payment.razorpay_order_id = order["id"]
    payment.save(update_fields=["razorpay_order_id", "updated_at"])
    log_security_event("platform_order.created", request=request, plan=plan.key, payment_id=payment.pk)
    return payment


def _grant_lifetime(user_id, course_id) -> bool:
    from apps.realtime.domain import invalidate_course_join_access_cache

    enrollment, created = Enrollment.objects.select_for_update().get_or_create(
        user_id=user_id,
        course_id=course_id,
        defaults={"payment_status": Enrollment.STATUS_PAID, "access_type": Enrollment.ACCESS_LIFETIME},
    )
    if not created:
        if enrollment.payment_status == Enrollment.STATUS_PAID and enrollment.access_type in (
            Enrollment.ACCESS_LIFETIME,
            Enrollment.ACCESS_LEGACY,
        ):
            return False
        enrollment.payment_status = Enrollment.STATUS_PAID
        enrollment.access_type = Enrollment.ACCESS_LIFETIME
        enrollment.access_expires_at = None
        enrollment.save(update_fields=["payment_status", "access_type", "access_expires_at"])
    invalidate_course_join_access_cache(user_id=user_id, course_id=course_id)
    return True


@transaction.atomic
def activate_grant(payment: Payment) -> PlatformGrant:
    grant, _ = PlatformGrant.objects.get_or_create(
        payment=payment, defaults={"user_id": payment.user_id, "plan_id": payment.platform_plan_id}
    )
    if grant.is_active:
        for course_id in plan_scope_course_ids(grant.plan):
            _grant_lifetime(grant.user_id, course_id)
    return grant


@transaction.atomic
def grant_scope_lifetime(grant: PlatformGrant) -> int:
    """Manual admin grant (no payment): Pentesting plans materialise Enrollments.

    No end date = lifetime access; a dated grant gives time-limited access to
    ``expires_at``. OSINT plans need nothing here (the labs and recordings read
    the grant directly).
    """
    from apps.realtime.domain import invalidate_course_join_access_cache

    if not grant.is_active or grant.plan.product not in PlatformPlan.PENTESTING_PRODUCTS:
        return 0
    touched = 0
    for course_id in plan_scope_course_ids(grant.plan):
        if grant.expires_at is None:
            touched += int(_grant_lifetime(grant.user_id, course_id))
            continue
        enrollment, created = Enrollment.objects.select_for_update().get_or_create(
            user_id=grant.user_id,
            course_id=course_id,
            defaults={
                "payment_status": Enrollment.STATUS_PAID,
                "access_type": Enrollment.ACCESS_INSTALLMENT,
                "access_expires_at": grant.expires_at,
            },
        )
        if not created and not enrollment.has_active_access():
            enrollment.payment_status = Enrollment.STATUS_PAID
            enrollment.access_type = Enrollment.ACCESS_INSTALLMENT
            enrollment.access_expires_at = grant.expires_at
            enrollment.save(update_fields=["payment_status", "access_type", "access_expires_at"])
        invalidate_course_join_access_cache(user_id=grant.user_id, course_id=course_id)
        touched += 1
    return touched


@transaction.atomic
def deactivate_grant(grant: PlatformGrant) -> dict:
    grant = PlatformGrant.objects.select_for_update().select_related("plan").get(pk=grant.pk)
    if grant.is_active:
        grant.is_active = False
        grant.revoked_at = timezone.now()
        grant.save(update_fields=["is_active", "revoked_at"])
    courses = Course.objects.filter(id__in=plan_scope_course_ids(grant.plan))
    return tally([resync_enrollment_access(grant.user_id, course) for course in courses])


@transaction.atomic
def grant_course_to_plan_holders(course) -> int:
    """A course newly published into a lifetime/include-future scope reaches every active holder."""
    granted = 0
    grants = PlatformGrant.objects.filter(is_active=True, plan__product__in=PlatformPlan.PENTESTING_PRODUCTS).select_related("plan")
    for grant in grants:
        if grant.plan.kind == PlatformPlan.KIND_ONE_TIME and course.id in plan_scope_course_ids(grant.plan):
            granted += int(_grant_lifetime(grant.user_id, course.id))
    return granted


def _mark_paid(payment: Payment, *, payment_id: str, signature: str = "", event: str = "") -> bool:
    """Mark the locked payment paid and grant access. False when already paid."""
    if payment.status == Payment.STATUS_PAID:
        return False
    payment.status = Payment.STATUS_PAID
    payment.razorpay_payment_id = payment_id
    if signature:
        payment.razorpay_signature = signature
    payment.paid_at = timezone.now()
    payment.provisioning_status = Payment.PROVISION_CREDENTIALS_ISSUED
    if event:
        payment.last_webhook_event = event[:120]
    payment.save(
        update_fields=[
            "status",
            "razorpay_payment_id",
            "razorpay_signature",
            "paid_at",
            "provisioning_status",
            "last_webhook_event",
            "updated_at",
        ]
    )
    activate_grant(payment)
    return True


def verify_order(user, *, order_id, payment_id, signature, request=None) -> Payment:
    payment = (
        Payment.objects.select_related("platform_plan")
        .filter(user=user, plan=Payment.PLAN_PLATFORM_ONE_TIME, razorpay_order_id=str(order_id or "").strip())
        .first()
    )
    if payment is None:
        raise PlatformOrderError("payment_not_found", "Order not found.", 404)
    try:
        verify_razorpay_signature(
            razorpay_order_id=payment.razorpay_order_id,
            razorpay_payment_id=str(payment_id or "").strip(),
            razorpay_signature=signature,
        )
    except RazorpayServiceError as exc:
        log_security_event("platform_order.verify_signature_failed", request=request, payment_id=payment.pk)
        raise PlatformOrderError("signature_invalid", "Payment verification failed.", 400) from exc
    with transaction.atomic():
        payment = Payment.objects.select_for_update().get(pk=payment.pk)
        if payment.status == Payment.STATUS_REFUNDED:
            raise PlatformOrderError("payment_refunded", "This payment was refunded.", 409)
        _mark_paid(payment, payment_id=str(payment_id).strip(), signature=str(signature or ""))
    log_security_event("platform_order.verified", request=request, payment_id=payment.pk)
    return payment


def handle_order_event(payment: Payment, payload: dict, *, request=None) -> dict:
    """``payment.captured`` / ``payment.failed`` / refunds for a platform one-time order."""
    event = str(payload.get("event") or "").strip().lower()
    body = payload.get("payload") or {}
    entity = (body.get("payment") or {}).get("entity") or {}
    with transaction.atomic():
        payment = Payment.objects.select_for_update().get(pk=payment.pk)
        if event in {"refund.processed", "payment.refunded"}:
            refund = (body.get("refund") or {}).get("entity") or {}
            try:
                refunded = Decimal(int(refund.get("amount") or entity.get("amount_refunded") or 0)) / 100
            except (TypeError, ValueError, ArithmeticError):
                refunded = Decimal("0")
            payment.amount_refunded = max(payment.amount_refunded or Decimal("0"), refunded)
            payment.refunded_at = payment.refunded_at or timezone.now()
            fields = ["amount_refunded", "refunded_at", "updated_at"]
            if payment.amount_refunded >= payment.amount:
                payment.status = Payment.STATUS_REFUNDED
                fields.append("status")
            payment.save(update_fields=fields)
            if payment.status == Payment.STATUS_REFUNDED:
                grant = PlatformGrant.objects.filter(payment=payment).first()
                if grant is not None:
                    deactivate_grant(grant)
            return {"success": True, "status_code": 200, "message": "Refund recorded.",
                    "data": {"processed": True, "payment_id": payment.pk}}
        amount = entity.get("amount")
        currency = str(entity.get("currency") or "").upper()
        if event == "payment.captured" or str(entity.get("status") or "") == "captured":
            if amount != int(payment.amount * 100) or currency != payment.currency:
                log_security_event("platform_order.webhook_amount_mismatch", request=request, payment_id=payment.pk)
                return {"success": False, "status_code": 400, "message": "Amount mismatch.",
                        "data": {"processed": False, "payment_id": payment.pk}}
            changed = _mark_paid(payment, payment_id=str(entity.get("id") or ""), event=event)
            return {"success": True, "status_code": 200,
                    "message": "Platform order paid." if changed else "Platform order already paid.",
                    "data": {"processed": changed, "payment_id": payment.pk}}
        if event == "payment.failed" and payment.status == Payment.STATUS_CREATED:
            payment.status = Payment.STATUS_FAILED
            payment.failure_reason = str(entity.get("error_description") or "")[:500]
            payment.save(update_fields=["status", "failure_reason", "updated_at"])
            return {"success": True, "status_code": 200, "message": "Platform order failed.",
                    "data": {"processed": True, "payment_id": payment.pk}}
    return {"success": True, "status_code": 200, "message": "Webhook ignored.",
            "data": {"processed": False, "payment_id": payment.pk}}


def checkout_payload(payment: Payment) -> dict:
    plan = payment.platform_plan
    return {
        "order_id": payment.razorpay_order_id,
        "key_id": getattr(settings, "RAZORPAY_KEY_ID", ""),
        "amount": format(payment.amount, ".2f"),
        "amount_paise": int(payment.amount * 100),
        "currency": payment.currency,
        "plan_key": plan.key,
        "name": "Al Syed Initiative",
        "description": plan.title,
    }
