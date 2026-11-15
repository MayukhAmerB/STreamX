"""The billing service API. Every feature uses these functions and nothing else.

    from apps import billing
    billing.list_plans(product_key=..., context=...)
    billing.quote(plan_id, user)
    billing.start_checkout(user, plan_id)
    billing.verify_checkout(user, order_id=..., payment_id=..., signature=...)
    billing.on_payment_captured(payment)
    billing.has_entitlement(user, key)
    billing.entitlements_for(user)

Amounts are always read from the database at call time (no cache), so a price
edited in the admin applies to the very next quote and checkout.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import timedelta
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from . import signals
from .models import EntitlementGrant, Plan, Price, Purchase, validate_entitlement_key
from .registry import describe

logger = logging.getLogger(__name__)

REUSE_PENDING_ORDER_FOR = timedelta(minutes=30)
REFUND_EVENTS = {"refund.processed", "payment.refunded"}


class BillingError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass(frozen=True)
class CapturedPayment:
    """What a gateway tells us about a captured payment (amount checked when given)."""

    order_id: str
    payment_id: str = ""
    amount_paise: int | None = None
    currency: str = ""
    event: str = ""


@dataclass(frozen=True)
class Quote:
    plan_id: int
    plan_key: str
    plan_name: str
    product_key: str
    price_id: int
    price_version: int
    amount: str
    amount_paise: int
    currency: str
    billing_type: str
    interval: str
    interval_count: int
    access_days: int | None
    lifetime: bool
    entitlement_keys: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def _authenticated(user) -> bool:
    return bool(user is not None and getattr(user, "is_authenticated", False))


# --------------------------------------------------------------------- catalogue
def _plans_queryset():
    return Plan.objects.select_related("product", "price").prefetch_related("features", "entitlements")


def list_plans(product_key: str | None = None, context: dict | None = None) -> list[Plan]:
    """Visible, purchasable plans in display order.

    ``context`` narrows the list without billing knowing the domain:
    ``{"course_id": 12}`` = plans granting ``course_access:12``;
    ``{"entitlement": "all_labs"}``; ``{"billing_type": "recurring"}``.
    """
    context = context or {}
    queryset = _plans_queryset().filter(is_active=True, product__is_active=True)
    if product_key:
        queryset = queryset.filter(product__key=product_key)
    if context.get("course_id") not in (None, ""):
        queryset = queryset.filter(entitlements__key=f"course_access:{int(context['course_id'])}")
    if context.get("entitlement"):
        queryset = queryset.filter(entitlements__key=str(context["entitlement"]))
    if context.get("billing_type"):
        queryset = queryset.filter(price__billing_type=str(context["billing_type"]))
    now = timezone.now()
    plans = queryset.distinct().order_by("product__sort_order", "product__name", "sort_order", "id")
    return [plan for plan in plans if plan.price.is_available(now)]


def get_plan(plan_id) -> Plan:
    """A plan by numeric id or key (404-style ``BillingError`` when missing)."""
    queryset = _plans_queryset()
    value = str(plan_id or "").strip()
    plan = queryset.filter(pk=int(value)).first() if value.isdigit() else queryset.filter(key=value).first()
    if plan is None:
        raise BillingError("plan_not_found", "This plan does not exist.", 404)
    return plan


def _purchasable(plan_id) -> Plan:
    plan = get_plan(plan_id)
    if not plan.is_purchasable():
        raise BillingError("plan_unavailable", "This plan is not available right now.", 409)
    return plan


def quote(plan_id, user=None) -> Quote:
    """The server-side amount for a plan right now. Never trust a client amount."""
    plan = _purchasable(plan_id)
    price: Price = plan.price
    days = price.period_days()
    return Quote(
        plan_id=plan.pk,
        plan_key=plan.key,
        plan_name=plan.name,
        product_key=plan.product.key,
        price_id=price.pk,
        price_version=price.version,
        amount=format(Decimal(price.amount), ".2f"),
        amount_paise=price.amount_paise,
        currency=price.currency,
        billing_type=price.billing_type,
        interval=price.interval,
        interval_count=price.interval_count,
        access_days=days,
        lifetime=days is None,
        entitlement_keys=plan.entitlement_keys(),
    )


# ---------------------------------------------------------------------- checkout
def _checkout_payload(purchase: Purchase) -> dict:
    from apps.payments.gateway import public_key_id

    return {
        "purchase_id": purchase.pk,
        "reference": str(purchase.reference),
        "provider": purchase.provider,
        "order_id": purchase.provider_order_id,
        "key_id": public_key_id(),
        "amount": format(purchase.amount, ".2f"),
        "amount_paise": purchase.amount_paise,
        "currency": purchase.currency,
        "plan_id": purchase.plan_id,
        "plan_key": purchase.plan_snapshot.get("key", ""),
        "name": "Al Syed Initiative",
        "description": purchase.plan_snapshot.get("name", ""),
    }


def _owns_lifetime(user, keys) -> bool:
    if not keys:
        return False
    for key in keys:
        if not EntitlementGrant.objects.active_at().filter(user=user, key=key, ends_at__isnull=True).exists():
            return False
    return True


def start_checkout(user, plan_id) -> dict:
    """Create a pending purchase and its Razorpay order (through ``apps.payments.gateway``)."""
    from apps.payments.gateway import GatewayError, create_order

    if not _authenticated(user):
        raise BillingError("authentication_required", "Sign in to buy a plan.", 401)
    current = quote(plan_id, user)
    if current.lifetime and _owns_lifetime(user, current.entitlement_keys):
        raise BillingError("already_owned", "You already have everything in this plan.", 409)

    reusable = (
        Purchase.objects.filter(
            user=user,
            plan_id=current.plan_id,
            price_id=current.price_id,
            amount=Decimal(current.amount),
            currency=current.currency,
            status=Purchase.STATUS_PENDING,
            created_at__gt=timezone.now() - REUSE_PENDING_ORDER_FOR,
        )
        .exclude(provider_order_id="")
        .order_by("-created_at")
        .first()
    )
    if reusable is not None:
        return _checkout_payload(reusable)

    plan = get_plan(current.plan_id)
    purchase = Purchase.objects.create(
        user=user,
        plan_id=current.plan_id,
        price_id=current.price_id,
        amount=Decimal(current.amount),
        currency=current.currency,
        billing_type=current.billing_type,
        access_days=current.access_days,
        entitlement_keys=list(current.entitlement_keys),
        plan_snapshot={
            "key": plan.key,
            "name": plan.name,
            "product": plan.product.key,
            "price_version": current.price_version,
            "features": [feature.text for feature in plan.features.all()],
        },
    )
    receipt = f"bl-{purchase.reference.hex[:30]}"
    try:
        order = create_order(amount_paise=current.amount_paise, receipt=receipt, currency=current.currency)
    except GatewayError as exc:
        purchase.status = Purchase.STATUS_FAILED
        purchase.failure_reason = str(exc)[:500]
        purchase.save(update_fields=["status", "failure_reason", "updated_at"])
        raise BillingError("upstream_unavailable", str(exc), 503) from exc
    purchase.provider_order_id = str(order["id"])
    purchase.save(update_fields=["provider_order_id", "updated_at"])
    return _checkout_payload(purchase)


def verify_checkout(user, *, order_id: str, payment_id: str, signature: str) -> Purchase:
    """The browser's Razorpay success callback: check the signature, then capture."""
    from apps.payments.gateway import GatewayError, verify_checkout_signature

    order_id = str(order_id or "").strip()
    payment_id = str(payment_id or "").strip()
    purchase = Purchase.objects.filter(user=user, provider_order_id=order_id).first() if order_id else None
    if purchase is None:
        raise BillingError("purchase_not_found", "Order not found.", 404)
    try:
        verify_checkout_signature(order_id=order_id, payment_id=payment_id, signature=str(signature or ""))
    except GatewayError as exc:
        raise BillingError("signature_invalid", "Payment verification failed.", 400) from exc
    purchase, _created = on_payment_captured(CapturedPayment(order_id=order_id, payment_id=payment_id))
    return purchase


# ------------------------------------------------------------------ fulfilment
def _coverage_end(user_id, key, at):
    """End of the user's current dated coverage for ``key`` (None when there is none)."""
    return (
        EntitlementGrant.objects.live()
        .filter(user_id=user_id, key=key, ends_at__isnull=False, ends_at__gt=at)
        .order_by("-ends_at")
        .values_list("ends_at", flat=True)
        .first()
    )


def _grant_for_purchase(purchase: Purchase, now) -> list[EntitlementGrant]:
    grants = []
    for key in purchase.entitlement_keys or []:
        if purchase.access_days is None:
            starts_at, ends_at = now, None
        else:
            # A renewal extends from max(now, current end).
            starts_at = max(now, _coverage_end(purchase.user_id, key, now) or now)
            ends_at = starts_at + timedelta(days=int(purchase.access_days))
        grant, _ = EntitlementGrant.objects.get_or_create(
            purchase=purchase,
            key=key,
            defaults={
                "user_id": purchase.user_id,
                "source": EntitlementGrant.SOURCE_PURCHASE,
                "starts_at": starts_at,
                "ends_at": ends_at,
            },
        )
        grants.append(grant)
    return grants


def on_payment_captured(payment) -> tuple[Purchase, bool]:
    """Mark the purchase paid and create its grants. Idempotent: (purchase, changed)."""
    if isinstance(payment, dict):
        payment = CapturedPayment(**{k: v for k, v in payment.items() if k in CapturedPayment.__dataclass_fields__})
    order_id = str(payment.order_id or "").strip()
    with transaction.atomic():
        purchase = (
            Purchase.objects.select_for_update().filter(provider_order_id=order_id).first() if order_id else None
        )
        if purchase is None:
            raise BillingError("purchase_not_found", "Order not found.", 404)
        if purchase.status in (Purchase.STATUS_PAID, Purchase.STATUS_REFUNDED):
            return purchase, False
        if purchase.user_id is None:
            raise BillingError("purchase_orphaned", "The buyer's account no longer exists.", 409)
        if payment.amount_paise is not None:
            currency = str(payment.currency or purchase.currency).upper()
            try:
                amount_ok = int(payment.amount_paise) == purchase.amount_paise
            except (TypeError, ValueError):
                amount_ok = False
            if not amount_ok or currency != purchase.currency:
                raise BillingError("amount_mismatch", "Payment amount mismatch.", 400)
        now = timezone.now()
        grants = _grant_for_purchase(purchase, now)
        purchase.status = Purchase.STATUS_PAID
        purchase.provider_payment_id = str(payment.payment_id or purchase.provider_payment_id or "")[:255]
        purchase.paid_at = now
        purchase.failure_reason = ""
        purchase.period_start = min((grant.starts_at for grant in grants), default=now)
        ends = [grant.ends_at for grant in grants]
        purchase.period_end = None if (not ends or None in ends) else max(ends)
        purchase.save()
        for grant in grants:
            signals.send(signals.entitlement_granted, grant=grant, user=purchase.user, key=grant.key)
        signals.send(signals.purchase_paid, purchase=purchase)
    return purchase, True


def on_payment_failed(order_id: str, reason: str = "") -> Purchase | None:
    with transaction.atomic():
        purchase = Purchase.objects.select_for_update().filter(provider_order_id=str(order_id or "")).first()
        if purchase is not None and purchase.status == Purchase.STATUS_PENDING:
            purchase.status = Purchase.STATUS_FAILED
            purchase.failure_reason = str(reason or "")[:500]
            purchase.save(update_fields=["status", "failure_reason", "updated_at"])
    return purchase


def revoke_grant(grant: EntitlementGrant, *, by=None, reason: str = "") -> bool:
    with transaction.atomic():
        grant = EntitlementGrant.objects.select_for_update().select_related("user").get(pk=grant.pk)
        if grant.revoked_at is not None:
            return False
        grant.revoked_at = timezone.now()
        grant.revoked_by = by if _authenticated(by) else None
        grant.revoke_reason = str(reason or "")[:255]
        grant.save(update_fields=["revoked_at", "revoked_by", "revoke_reason"])
        signals.send(signals.entitlement_revoked, grant=grant, user=grant.user, key=grant.key)
    return True


def on_payment_refunded(purchase: Purchase, *, amount_refunded=None, by=None, reason: str = "Refunded") -> Purchase:
    """Record a refund; a full refund revokes every grant of the purchase."""
    with transaction.atomic():
        purchase = Purchase.objects.select_for_update().get(pk=purchase.pk)
        refunded = purchase.amount if amount_refunded is None else Decimal(amount_refunded)
        purchase.amount_refunded = max(Decimal(purchase.amount_refunded or 0), refunded)
        purchase.refunded_at = purchase.refunded_at or timezone.now()
        fully = purchase.amount_refunded >= purchase.amount
        if fully and purchase.status != Purchase.STATUS_REFUNDED:
            purchase.status = Purchase.STATUS_REFUNDED
        purchase.save(update_fields=["amount_refunded", "refunded_at", "status", "updated_at"])
        if fully:
            for grant in purchase.grants.live():
                revoke_grant(grant, by=by, reason=reason)
            signals.send(signals.purchase_refunded, purchase=purchase)
    return purchase


def grant_manually(user, key: str, *, ends_at=None, starts_at=None, by=None, note: str = "") -> EntitlementGrant:
    try:
        validate_entitlement_key(key)
    except ValidationError as exc:
        raise BillingError("invalid_entitlement_key", "; ".join(exc.messages), 400) from exc
    with transaction.atomic():
        grant = EntitlementGrant.objects.create(
            user=user,
            key=key,
            source=EntitlementGrant.SOURCE_MANUAL,
            starts_at=starts_at or timezone.now(),
            ends_at=ends_at,
            granted_by=by if _authenticated(by) else None,
            note=str(note or "")[:255],
        )
        signals.send(signals.entitlement_granted, grant=grant, user=user, key=key)
    return grant


def resend_hooks(grant: EntitlementGrant) -> None:
    """Replay the grant/revoke hook (repairs a receiver that failed earlier)."""
    signal = signals.entitlement_granted if grant.revoked_at is None else signals.entitlement_revoked
    with transaction.atomic():
        signals.send(signal, grant=grant, user=grant.user, key=grant.key)


# ----------------------------------------------------------------- entitlements
def has_entitlement(user, key: str, at=None) -> bool:
    if not _authenticated(user):
        return False
    return EntitlementGrant.objects.active_at(at).filter(user=user, key=key).exists()


def entitlement_window(user, key: str, at=None) -> dict:
    """``{active, lifetime, ends_at}`` for one key, following back-to-back renewals."""
    at = at or timezone.now()
    empty = {"key": key, "active": False, "lifetime": False, "ends_at": None}
    if not _authenticated(user):
        return empty
    grants = list(
        EntitlementGrant.objects.live()
        .filter(user=user, key=key)
        .filter(Q(ends_at__isnull=True) | Q(ends_at__gt=at))
        .order_by("starts_at")
        .values("starts_at", "ends_at")
    )
    active = [row for row in grants if row["starts_at"] <= at]
    if not active:
        return empty
    if any(row["ends_at"] is None for row in active):
        return {"key": key, "active": True, "lifetime": True, "ends_at": None}
    end = max(row["ends_at"] for row in active)
    for row in grants:
        if row["starts_at"] > at and row["starts_at"] <= end:
            if row["ends_at"] is None:
                return {"key": key, "active": True, "lifetime": True, "ends_at": None}
            end = max(end, row["ends_at"])
    return {"key": key, "active": True, "lifetime": False, "ends_at": end}


def entitlements_for(user, at=None) -> list[dict]:
    """Every key the user can use now: ``[{key, label, lifetime, ends_at}]`` (ISO dates)."""
    at = at or timezone.now()
    if not _authenticated(user):
        return []
    keys = sorted(set(EntitlementGrant.objects.active_at(at).filter(user=user).values_list("key", flat=True)))
    rows = []
    for key in keys:
        window = entitlement_window(user, key, at)
        rows.append(
            {
                "key": key,
                "label": describe(key),
                "lifetime": window["lifetime"],
                "ends_at": window["ends_at"].isoformat() if window["ends_at"] else None,
            }
        )
    return rows


def entitlement_keys(user, at=None) -> list[str]:
    return [row["key"] for row in entitlements_for(user, at)]


# -------------------------------------------------------------------- webhooks
def handle_gateway_event(payload: dict, *, request=None):
    """Razorpay webhook for billing orders (registered with ``apps.payments.gateway``).

    Returns None for orders billing does not own, so every other flow is untouched.
    """
    event = str(payload.get("event") or "").strip().lower()
    body = payload.get("payload") or {}
    entity = (body.get("payment") or {}).get("entity") or {}
    refund = (body.get("refund") or {}).get("entity") or {}
    order_id = str(entity.get("order_id") or ((body.get("order") or {}).get("entity") or {}).get("id") or "").strip()
    purchase = None
    if order_id:
        purchase = Purchase.objects.filter(provider_order_id=order_id).first()
    elif event in REFUND_EVENTS:
        payment_id = str(entity.get("id") or refund.get("payment_id") or "").strip()
        if payment_id:
            purchase = Purchase.objects.filter(provider_payment_id=payment_id).first()
    if purchase is None:
        return None

    def result(message, processed, success=True, status_code=200):
        return {
            "success": success,
            "status_code": status_code,
            "message": message,
            "data": {"processed": processed, "billing_purchase_id": purchase.pk},
        }

    if event in REFUND_EVENTS:
        try:
            paise = max(int(refund.get("amount") or 0), int(entity.get("amount_refunded") or 0))
        except (TypeError, ValueError):
            paise = 0
        on_payment_refunded(purchase, amount_refunded=Decimal(paise) / 100, reason=f"Razorpay {event}")
        return result("Billing refund recorded.", True)
    if event == "payment.captured" or str(entity.get("status") or "").lower() == "captured":
        try:
            _purchase, changed = on_payment_captured(
                CapturedPayment(
                    order_id=purchase.provider_order_id,
                    payment_id=str(entity.get("id") or ""),
                    amount_paise=entity.get("amount"),
                    currency=str(entity.get("currency") or ""),
                    event=event,
                )
            )
        except BillingError as exc:
            logger.warning("billing webhook rejected for purchase %s: %s", purchase.pk, exc.code)
            return result("Webhook verification failed.", False, success=False, status_code=exc.status)
        return result("Billing purchase paid." if changed else "Billing purchase already paid.", changed)
    if event == "payment.failed":
        on_payment_failed(purchase.provider_order_id, str(entity.get("error_description") or ""))
        return result("Billing purchase failed.", True)
    return result("Webhook ignored.", False)
