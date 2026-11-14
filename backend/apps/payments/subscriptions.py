"""Razorpay Subscriptions for platform memberships (webhook-authoritative).

Lifecycle (contract ``hackpath/contracts/catalog.md`` §5, BUILD_PLAN §4.4):

* ``create_subscription``: gates (``memberships`` switch, ``pentesting`` for
  Pentesting plans, the plan's confirmed price + ``is_enabled``), then a
  Razorpay subscription. A still-unpaid ``created`` row for the same plan is
  resumed instead of creating a second one.
* ``verify_checkout``: the Checkout success signature
  ``HMAC(payment_id|subscription_id)``; the subscription is then re-read from
  Razorpay (or, if that fails, given one provisional day).
* ``handle_event``: every ``subscription.*`` webhook. Events are de-duplicated
  upstream by ``X-Razorpay-Event-Id`` (``PaymentWebhookEvent``); here the row
  is locked and events older than ``last_event_at`` may only move dates and
  counters forward, never the status (out-of-order safety).
* Access: ``access_until = current_end + SUBSCRIPTION_GRACE_DAYS`` once at
  least one charge succeeded. It only ever moves forward: cancelling,
  halting or switching ``memberships`` off never cuts a paid period short.
* ``reconcile``: re-reads stale live subscriptions from Razorpay (missed
  webhooks), applying the same snapshot rules.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal

from config.audit import log_security_event
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.courses.models import Enrollment

from .models import Payment, PlatformPlan, PlatformSubscription
from .platform_plans import STATE_AVAILABLE, gate_feature_key, plan_gate, plan_scope_course_ids, total_count_for
from .services import (
    RazorpayServiceError,
    cancel_razorpay_subscription,
    create_razorpay_subscription,
    fetch_razorpay_subscription,
    verify_razorpay_subscription_signature,
)

logger = logging.getLogger("apps.payments.subscriptions")

EVENT_STATUS = {
    "subscription.authenticated": PlatformSubscription.STATUS_AUTHENTICATED,
    "subscription.activated": PlatformSubscription.STATUS_ACTIVE,
    "subscription.charged": PlatformSubscription.STATUS_ACTIVE,
    "subscription.resumed": PlatformSubscription.STATUS_ACTIVE,
    "subscription.pending": PlatformSubscription.STATUS_PENDING,
    "subscription.halted": PlatformSubscription.STATUS_HALTED,
    "subscription.paused": PlatformSubscription.STATUS_PAUSED,
    "subscription.cancelled": PlatformSubscription.STATUS_CANCELLED,
    "subscription.completed": PlatformSubscription.STATUS_COMPLETED,
    "subscription.expired": PlatformSubscription.STATUS_EXPIRED,
}
KNOWN_STATUSES = {value for value, _label in PlatformSubscription.STATUS_CHOICES}
PROVISIONAL_ACCESS = timedelta(days=1)


@dataclass
class SubscriptionError(Exception):
    code: str
    message: str
    status: int = 400
    feature: str | None = None

    def __str__(self):
        return self.message


def grace() -> timedelta:
    return timedelta(days=max(0, int(getattr(settings, "SUBSCRIPTION_GRACE_DAYS", 3))))


def _from_unix(value):
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    return datetime.fromtimestamp(seconds, tz=dt_timezone.utc)


def _later(current, candidate):
    if candidate is None:
        return current
    if current is None or candidate > current:
        return candidate
    return current


# ---------------------------------------------------------------------------
# Snapshot application (webhooks, verify and reconcile share it)
# ---------------------------------------------------------------------------
def apply_snapshot(sub: PlatformSubscription, entity: dict, *, event_name: str = "", event_time=None) -> list[str]:
    """Merge a Razorpay subscription entity into ``sub`` (caller holds the row lock and saves)."""
    entity = entity if isinstance(entity, dict) else {}
    changed: list[str] = []
    stale = bool(event_time and sub.last_event_at and event_time < sub.last_event_at)

    def set_field(name, value):
        if getattr(sub, name) != value:
            setattr(sub, name, value)
            changed.append(name)

    set_field("current_start", _later(sub.current_start, _from_unix(entity.get("current_start"))))
    set_field("current_end", _later(sub.current_end, _from_unix(entity.get("current_end"))))
    try:
        paid_count = int(entity.get("paid_count") or 0)
    except (TypeError, ValueError):
        paid_count = 0
    if paid_count > sub.paid_count:
        set_field("paid_count", paid_count)
    if entity.get("short_url"):
        set_field("short_url", str(entity["short_url"])[:200])

    if not stale:
        status = EVENT_STATUS.get(event_name) or str(entity.get("status") or "").strip().lower()
        if status in KNOWN_STATUSES and status != sub.status:
            set_field("status", status)
        if status == PlatformSubscription.STATUS_CANCELLED:
            set_field("cancelled_at", sub.cancelled_at or _from_unix(entity.get("ended_at")) or timezone.now())
        if status in (PlatformSubscription.STATUS_COMPLETED, PlatformSubscription.STATUS_EXPIRED,
                      PlatformSubscription.STATUS_CANCELLED):
            set_field("ended_at", sub.ended_at or _from_unix(entity.get("ended_at")) or timezone.now())
        if event_name:
            set_field("last_event", event_name[:60])
        if event_time:
            set_field("last_event_at", event_time)

    if sub.paid_count >= 1 and sub.current_end is not None:
        set_field("access_until", _later(sub.access_until, sub.current_end + grace()))
    return changed


def _save(sub: PlatformSubscription, changed: list[str]):
    if changed:
        sub.save(update_fields=sorted({*changed, "updated_at"}))


def sync_subscription_enrollments(sub: PlatformSubscription) -> int:
    """Pentesting membership: extend time-limited Enrollments to ``access_until`` (never shortens)."""
    if sub.plan.product != PlatformPlan.PRODUCT_PT_MEMBERSHIP or not sub.has_access():
        return 0
    from apps.realtime.domain import invalidate_course_join_access_cache

    touched = 0
    for course_id in plan_scope_course_ids(sub.plan):
        enrollment, created = Enrollment.objects.select_for_update().get_or_create(
            user_id=sub.user_id,
            course_id=course_id,
            defaults={
                "payment_status": Enrollment.STATUS_PAID,
                "access_type": Enrollment.ACCESS_INSTALLMENT,
                "access_expires_at": sub.access_until,
            },
        )
        if not created:
            if enrollment.payment_status == Enrollment.STATUS_PAID and enrollment.access_type in (
                Enrollment.ACCESS_LIFETIME,
                Enrollment.ACCESS_LEGACY,
            ):
                continue
            expires = enrollment.access_expires_at if enrollment.payment_status == Enrollment.STATUS_PAID else None
            if (
                enrollment.payment_status == Enrollment.STATUS_PAID
                and enrollment.access_type == Enrollment.ACCESS_INSTALLMENT
                and expires is not None
                and expires >= sub.access_until
            ):
                continue
            enrollment.payment_status = Enrollment.STATUS_PAID
            enrollment.access_type = Enrollment.ACCESS_INSTALLMENT
            enrollment.access_expires_at = sub.access_until
            enrollment.save(update_fields=["payment_status", "access_type", "access_expires_at"])
        invalidate_course_join_access_cache(user_id=sub.user_id, course_id=course_id)
        touched += 1
    return touched


def _record_charge(sub: PlatformSubscription, payment_entity: dict) -> Payment | None:
    payment_id = str(payment_entity.get("id") or "").strip()
    if not payment_id.startswith("pay_"):
        return None
    try:
        amount = (Decimal(int(payment_entity.get("amount") or 0)) / 100).quantize(Decimal("0.01"))
    except (TypeError, ValueError, ArithmeticError):
        amount = sub.amount
    existing = Payment.objects.filter(plan=Payment.PLAN_PLATFORM_SUBSCRIPTION, razorpay_payment_id=payment_id).first()
    if existing is not None:
        return existing
    try:
        with transaction.atomic():
            return Payment.objects.create(
                user_id=sub.user_id,
                platform_plan_id=sub.plan_id,
                subscription=sub,
                plan=Payment.PLAN_PLATFORM_SUBSCRIPTION,
                razorpay_order_id=str(payment_entity.get("order_id") or "")[:255],
                razorpay_payment_id=payment_id,
                amount=amount,
                currency=str(payment_entity.get("currency") or "INR")[:10],
                status=Payment.STATUS_PAID,
                provisioning_status=Payment.PROVISION_CREDENTIALS_ISSUED,
                gateway_status=str(payment_entity.get("status") or "captured")[:64],
                payment_method=str(payment_entity.get("method") or "")[:64],
                course_title_snapshot=sub.plan.title[:255],
                paid_at=_from_unix(payment_entity.get("created_at")) or timezone.now(),
                last_webhook_event="subscription.charged",
                terms_snapshot={
                    "platform_plan": sub.plan.key,
                    "billing_period": sub.plan.billing_period,
                    "subscription": sub.razorpay_subscription_id,
                },
            )
    except IntegrityError:
        return Payment.objects.filter(plan=Payment.PLAN_PLATFORM_SUBSCRIPTION, razorpay_payment_id=payment_id).first()


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------
def _result(processed: bool, message: str, **data) -> dict:
    return {"success": True, "status_code": 200, "message": message, "data": {"processed": processed, **data}}


def handle_event(payload: dict, *, request=None) -> dict:
    """Process one ``subscription.*`` webhook (already signature-checked and de-duplicated)."""
    event = str(payload.get("event") or "").strip().lower()
    body = payload.get("payload") or {}
    entity = (body.get("subscription") or {}).get("entity") or {}
    subscription_id = str(entity.get("id") or "").strip()
    event_time = _from_unix(payload.get("created_at"))
    if not subscription_id:
        return _result(False, "Webhook ignored.", reason="missing_subscription_id")
    with transaction.atomic():
        sub = (
            PlatformSubscription.objects.select_for_update()
            .select_related("plan")
            .filter(razorpay_subscription_id=subscription_id)
            .first()
        )
        if sub is None:
            log_security_event("subscription.webhook_unknown", request=request, webhook_event=event)
            return _result(False, "Webhook ignored.", reason="unknown_subscription")
        changed = apply_snapshot(sub, entity, event_name=event, event_time=event_time)
        charge = None
        if event == "subscription.charged":
            charge = _record_charge(sub, (body.get("payment") or {}).get("entity") or {})
        _save(sub, changed)
        sync_subscription_enrollments(sub)
    log_security_event(
        "subscription.webhook_processed",
        request=request,
        webhook_event=event,
        subscription=sub.pk,
        status=sub.status,
    )
    return _result(True, "Subscription updated.", subscription=sub.pk, status=sub.status,
                   payment_id=getattr(charge, "pk", None))


def handle_payment_event(payload: dict, *, request=None) -> dict:
    """``payment.*`` events of a subscription charge: audit only (charged carries the access)."""
    event = str(payload.get("event") or "").strip().lower()
    entity = ((payload.get("payload") or {}).get("payment") or {}).get("entity") or {}
    subscription_id = str(entity.get("subscription_id") or "").strip()
    with transaction.atomic():
        sub = PlatformSubscription.objects.select_for_update().filter(razorpay_subscription_id=subscription_id).first()
        if sub is None:
            return _result(False, "Webhook ignored.", reason="unknown_subscription")
        if event == "payment.failed":
            details = dict(sub.gateway_details or {})
            details["last_failure"] = {
                "payment_id": str(entity.get("id") or "")[:64],
                "error_code": str(entity.get("error_code") or "")[:64],
                "error_description": str(entity.get("error_description") or "")[:250],
                "at": timezone.now().isoformat(),
            }
            sub.gateway_details = details
            sub.save(update_fields=["gateway_details", "updated_at"])
            log_security_event("subscription.charge_failed", request=request, subscription=sub.pk)
            return _result(True, "Subscription charge failure recorded.", subscription=sub.pk)
    return _result(False, "Webhook ignored.", reason="handled_by_subscription_events")


# ---------------------------------------------------------------------------
# Student actions
# ---------------------------------------------------------------------------
def _plan_or_404(plan_key) -> PlatformPlan:
    plan = PlatformPlan.objects.select_related("starter_course").filter(key=str(plan_key or "").strip()).first()
    if plan is None:
        raise SubscriptionError("plan_not_found", "This plan does not exist.", 404)
    return plan


def check_subscribable(plan: PlatformPlan) -> None:
    if not plan.is_subscription:
        raise SubscriptionError("plan_not_subscription", "This plan is a one-time payment.", 400)
    feature = gate_feature_key(plan)
    if feature:
        from apps.core import features

        raise SubscriptionError("feature_disabled", features.reason_for(feature), 403, feature=feature)
    state, code, reason = plan_gate(plan)
    if state != STATE_AVAILABLE:
        raise SubscriptionError("plan_unavailable", reason, 403)


def create_subscription(user, plan_key, *, request=None) -> PlatformSubscription:
    plan = _plan_or_404(plan_key)
    check_subscribable(plan)
    live = (
        PlatformSubscription.objects.filter(user=user, plan=plan, status__in=PlatformSubscription.LIVE_STATUSES)
        .order_by("-created_at")
        .first()
    )
    if live is not None:
        if live.status == PlatformSubscription.STATUS_CREATED and live.razorpay_plan_id == plan.razorpay_plan_id:
            return live  # resume the unfinished checkout
        if live.status != PlatformSubscription.STATUS_CREATED:
            raise SubscriptionError("already_subscribed", "You already have this membership.", 409)
        # An unfinished checkout for an older Razorpay plan: retire it.
        live.status = PlatformSubscription.STATUS_EXPIRED
        live.ended_at = timezone.now()
        live.save(update_fields=["status", "ended_at", "updated_at"])
    try:
        remote = create_razorpay_subscription(
            plan_id=plan.razorpay_plan_id,
            total_count=total_count_for(plan),
            notes={"user_id": user.pk, "plan_key": plan.key, "email": getattr(user, "email", "")},
        )
    except RazorpayServiceError as exc:
        log_security_event("subscription.create_gateway_error", request=request, plan=plan.key)
        raise SubscriptionError("upstream_unavailable", str(exc), 503) from exc
    try:
        with transaction.atomic():
            sub = PlatformSubscription.objects.create(
                user=user,
                plan=plan,
                razorpay_subscription_id=str(remote["id"]),
                razorpay_plan_id=plan.razorpay_plan_id,
                status=PlatformSubscription.STATUS_CREATED,
                amount=plan.price_inr,
                total_count=int(remote.get("total_count") or total_count_for(plan)),
                short_url=str(remote.get("short_url") or "")[:200],
            )
    except IntegrityError as exc:
        try:
            cancel_razorpay_subscription(subscription_id=remote["id"], at_cycle_end=False)
        except RazorpayServiceError:
            logger.warning("subscription.orphan_cancel_failed id=%s", remote.get("id"))
        raise SubscriptionError("already_subscribed", "You already have this membership.", 409) from exc
    log_security_event("subscription.created", request=request, plan=plan.key, subscription=sub.pk)
    return sub


def verify_checkout(user, *, payment_id, subscription_id, signature, request=None) -> PlatformSubscription:
    sub = (
        PlatformSubscription.objects.select_related("plan")
        .filter(user=user, razorpay_subscription_id=str(subscription_id or "").strip())
        .first()
    )
    if sub is None:
        raise SubscriptionError("subscription_not_found", "Subscription not found.", 404)
    try:
        verify_razorpay_subscription_signature(
            razorpay_payment_id=str(payment_id or "").strip(),
            razorpay_subscription_id=sub.razorpay_subscription_id,
            razorpay_signature=signature,
        )
    except RazorpayServiceError as exc:
        log_security_event("subscription.verify_signature_failed", request=request, subscription=sub.pk)
        raise SubscriptionError("signature_invalid", "Payment verification failed.", 400) from exc
    try:
        remote = fetch_razorpay_subscription(subscription_id=sub.razorpay_subscription_id)
    except RazorpayServiceError:
        remote = None
    with transaction.atomic():
        sub = PlatformSubscription.objects.select_for_update().select_related("plan").get(pk=sub.pk)
        if remote is not None:
            changed = apply_snapshot(sub, remote)
        else:
            changed = []
        if sub.status == PlatformSubscription.STATUS_CREATED:
            sub.status = PlatformSubscription.STATUS_AUTHENTICATED
            changed.append("status")
        if not sub.has_access():
            # The signature proves a successful charge; webhooks confirm the period.
            sub.access_until = timezone.now() + PROVISIONAL_ACCESS
            changed.append("access_until")
        _save(sub, changed)
        sync_subscription_enrollments(sub)
    log_security_event("subscription.verified", request=request, subscription=sub.pk)
    return sub


def cancel_subscription(user, pk, *, at_cycle_end=True, request=None) -> PlatformSubscription:
    sub = PlatformSubscription.objects.select_related("plan").filter(user=user, pk=pk).first()
    if sub is None:
        raise SubscriptionError("subscription_not_found", "Subscription not found.", 404)
    if sub.status in PlatformSubscription.TERMINAL_STATUSES:
        return sub
    if sub.status != PlatformSubscription.STATUS_CREATED:
        try:
            cancel_razorpay_subscription(subscription_id=sub.razorpay_subscription_id, at_cycle_end=bool(at_cycle_end))
        except RazorpayServiceError as exc:
            raise SubscriptionError("upstream_unavailable", str(exc), 503) from exc
    with transaction.atomic():
        sub = PlatformSubscription.objects.select_for_update().get(pk=sub.pk)
        if at_cycle_end and sub.status != PlatformSubscription.STATUS_CREATED:
            sub.cancel_at_cycle_end = True
            sub.save(update_fields=["cancel_at_cycle_end", "updated_at"])
        else:
            sub.status = PlatformSubscription.STATUS_CANCELLED
            sub.cancelled_at = timezone.now()
            sub.ended_at = sub.ended_at or timezone.now()
            sub.save(update_fields=["status", "cancelled_at", "ended_at", "updated_at"])
    log_security_event("subscription.cancel_requested", request=request, subscription=sub.pk, at_cycle_end=at_cycle_end)
    return sub


def serialize(sub: PlatformSubscription) -> dict:
    def iso(value):
        return value.isoformat() if value else None

    return {
        "id": sub.pk,
        "plan_key": sub.plan.key,
        "plan_title": sub.plan.title,
        "product": sub.plan.product,
        "status": sub.status,
        "current_start": iso(sub.current_start),
        "current_end": iso(sub.current_end),
        "access_until": iso(sub.access_until),
        "has_access": sub.has_access(),
        "cancel_at_cycle_end": bool(sub.cancel_at_cycle_end),
        "cancelled_at": iso(sub.cancelled_at),
        "paid_count": int(sub.paid_count),
        "entitlements": sub.plan.entitlement_keys(),
    }


# ---------------------------------------------------------------------------
# Reconciliation (missed webhooks)
# ---------------------------------------------------------------------------
def reconcile(*, apply: bool = False, stale_hours: int = 26, fetch=fetch_razorpay_subscription) -> dict:
    cutoff = timezone.now() - timedelta(hours=max(1, int(stale_hours)))
    rows = PlatformSubscription.objects.filter(
        status__in=PlatformSubscription.LIVE_STATUSES, updated_at__lt=cutoff
    ).select_related("plan")
    report = {"checked": 0, "changed": 0, "failed": 0, "changes": []}
    for sub in rows.iterator():
        report["checked"] += 1
        try:
            remote = fetch(subscription_id=sub.razorpay_subscription_id)
        except RazorpayServiceError:
            report["failed"] += 1
            continue
        with transaction.atomic():
            locked = PlatformSubscription.objects.select_for_update().select_related("plan").get(pk=sub.pk)
            changed = apply_snapshot(locked, remote)
            if changed:
                report["changed"] += 1
                report["changes"].append({"id": locked.pk, "fields": changed, "status": locked.status})
            if apply:
                if changed:
                    _save(locked, changed)
                else:
                    locked.save(update_fields=["updated_at"])
                sync_subscription_enrollments(locked)
            else:
                transaction.set_rollback(True)
    return report
