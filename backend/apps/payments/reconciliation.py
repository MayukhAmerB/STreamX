"""Stuck-payment reconciliation: open orders checked against Razorpay.

Why: a course/platform/billing order is finalized by the browser's verify call
or by the Razorpay webhook. If the buyer closes the tab after paying and the
webhook never arrives (not configured, blocked, or Razorpay gave up after
24h), the payment stays ``created`` and the buyer has paid without access.

What it does, for open orders older than ``min_age`` (the browser had its
chance) and younger than ``max_age``:

* Razorpay says the order has exactly one captured payment of the right
  amount -> it is finalized through ``process_payment_webhook_payload`` (the
  same, idempotent path the webhook and checkout recovery use), so
  enrollment, platform grants and billing entitlements follow as usual.
* Razorpay says the order was never attempted, or every attempt failed, and
  it is older than ``supersede_after`` -> the local row is closed
  (``failed`` / ``superseded``). Nothing can capture on it later without a
  new payment, and if one ever did, the capture still finalizes a failed row.
  Closing it lets the buyer start a fresh checkout instead of hitting
  "an unfinished payment exists, contact support".
* Anything else (payment in progress, ambiguous, invalid) is only reported.

Safety: dry run by default; ``apply=True`` writes. Every Razorpay call is a
GET through the shared circuit breaker; when the circuit opens the run stops.
The periodic hook is OFF unless ``PAYMENT_RECONCILE_ENABLED``; the work runs
from one deduplicated outbox event per interval (``process_async_jobs``).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from config.audit import log_security_event
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import Payment
from .services import (
    RazorpayServiceError,
    RazorpayUnavailable,
    ensure_gateway_available,
    fetch_razorpay_order,
    fetch_razorpay_order_payments,
)

logger = logging.getLogger("apps.payments.reconciliation")

EVENT_RECONCILE = "payments.reconcile"

STATE_CAPTURED = "captured"
STATE_NEVER_ATTEMPTED = "never_attempted"
STATE_ATTEMPTS_FAILED = "attempts_failed"
STATE_IN_PROGRESS = "in_progress"
STATE_AMBIGUOUS = "ambiguous"
STATE_INVALID = "invalid"

SUPERSEDABLE_STATES = (STATE_NEVER_ATTEMPTED, STATE_ATTEMPTS_FAILED)
SUPERSEDED_GATEWAY_STATUS = "superseded"
SUPERSEDED_REASON = "Closed by reconciliation: Razorpay reports no successful payment for this order."


@dataclass(frozen=True)
class OpenOrder:
    kind: str  # "payment" | "purchase"
    pk: int
    order_id: str
    amount_paise: int
    currency: str
    created_at: object


@dataclass
class Inspection:
    state: str
    captured: dict | None = None
    detail: str = ""


@dataclass
class ReconcileReport:
    apply: bool
    checked: int = 0
    captured: int = 0
    finalized: int = 0
    superseded: int = 0
    unpaid: int = 0
    in_progress: int = 0
    needs_review: int = 0
    errors: int = 0
    stopped: str = ""
    rows: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "apply": self.apply,
            "checked": self.checked,
            "captured": self.captured,
            "finalized": self.finalized,
            "superseded": self.superseded,
            "unpaid": self.unpaid,
            "in_progress": self.in_progress,
            "needs_review": self.needs_review,
            "errors": self.errors,
            "stopped": self.stopped,
            "rows": self.rows,
        }


def enabled() -> bool:
    return bool(getattr(settings, "PAYMENT_RECONCILE_ENABLED", False))


def _setting(name, default):
    return int(getattr(settings, name, default) or default)


def _paise(amount) -> int:
    return int((Decimal(amount) * 100).quantize(Decimal("1")))


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def open_orders(*, now=None, min_age_minutes=None, max_age_hours=None, limit=None) -> list[OpenOrder]:
    """Open orders due a check, least recently touched first (rows rotate)."""
    now = now or timezone.now()
    min_age = timedelta(minutes=min_age_minutes if min_age_minutes is not None else _setting("PAYMENT_RECONCILE_MIN_AGE_MINUTES", 20))
    max_age = timedelta(hours=max_age_hours if max_age_hours is not None else _setting("PAYMENT_RECONCILE_MAX_AGE_HOURS", 72))
    limit = limit if limit is not None else _setting("PAYMENT_RECONCILE_BATCH_SIZE", 25)
    window = {"created_at__lte": now - min_age, "created_at__gte": now - max_age}
    rows = [
        OpenOrder("payment", row["pk"], row["razorpay_order_id"], _paise(row["amount"]), row["currency"], row["created_at"])
        for row in Payment.objects.filter(status=Payment.STATUS_CREATED, **window)
        .exclude(razorpay_order_id="")
        .exclude(plan=Payment.PLAN_PLATFORM_SUBSCRIPTION)
        .order_by("updated_at", "pk")
        .values("pk", "razorpay_order_id", "amount", "currency", "created_at")[:limit]
    ]
    try:
        from apps.billing.models import Purchase
    except Exception:  # noqa: BLE001 - billing app absent
        return rows
    rows.extend(
        OpenOrder("purchase", row["pk"], row["provider_order_id"], _paise(row["amount"]), row["currency"], row["created_at"])
        for row in Purchase.objects.filter(status=Purchase.STATUS_PENDING, provider="razorpay", **window)
        .exclude(provider_order_id="")
        .order_by("updated_at", "pk")
        .values("pk", "provider_order_id", "amount", "currency", "created_at")[: max(0, limit - len(rows))]
    )
    return rows


def has_open_orders(now=None) -> bool:
    return bool(open_orders(now=now, limit=1))


def inspect_order(order: OpenOrder, *, fetch_order=fetch_razorpay_order, fetch_payments=fetch_razorpay_order_payments) -> Inspection:
    """What Razorpay says about one open order (GET only; raises RazorpayServiceError)."""
    remote = fetch_order(razorpay_order_id=order.order_id)
    if not isinstance(remote, dict):
        return Inspection(STATE_INVALID, detail="order response is not an object")
    if (
        str(remote.get("id") or "") != order.order_id
        or remote.get("entity") != "order"
        or _int(remote.get("amount")) != order.amount_paise
        or str(remote.get("currency") or "").upper() != str(order.currency or "").upper()
    ):
        return Inspection(STATE_INVALID, detail="order does not match the local record")
    status = str(remote.get("status") or "").lower()
    if status == "created":
        return Inspection(STATE_NEVER_ATTEMPTED)
    listing = fetch_payments(razorpay_order_id=order.order_id)
    items = listing.get("items") if isinstance(listing, dict) else None
    items = [item for item in (items if isinstance(items, list) else []) if isinstance(item, dict)]
    items = [item for item in items if str(item.get("order_id") or "") == order.order_id]
    captured = [item for item in items if str(item.get("status") or "").lower() == "captured"]
    if len(captured) > 1:
        return Inspection(STATE_AMBIGUOUS, detail="more than one captured payment")
    if len(captured) == 1:
        entity = captured[0]
        if (
            _int(entity.get("amount")) != order.amount_paise
            or str(entity.get("currency") or "").upper() != str(order.currency or "").upper()
            or not str(entity.get("id") or "").startswith("pay_")
        ):
            return Inspection(STATE_INVALID, detail="captured payment does not match the order")
        return Inspection(STATE_CAPTURED, captured=entity)
    if status == "paid":
        return Inspection(STATE_AMBIGUOUS, detail="order paid but no captured payment listed")
    if items and all(str(item.get("status") or "").lower() == "failed" for item in items):
        return Inspection(STATE_ATTEMPTS_FAILED)
    return Inspection(STATE_IN_PROGRESS, detail=",".join(sorted({str(i.get("status") or "?") for i in items})) or "attempted")


def _finalize(order: OpenOrder, captured: dict) -> bool:
    from .views import process_payment_webhook_payload

    process_payment_webhook_payload(
        payload={"event": "payment.captured", "payload": {"payment": {"entity": captured}}},
        source="reconciliation",
    )
    # Judge by the stored outcome, not the handler's message: a concurrent
    # verify/webhook may have finalized it first, which is just as good.
    if order.kind == "payment":
        return Payment.objects.filter(
            pk=order.pk, status__in=(Payment.STATUS_PAID, Payment.STATUS_REFUNDED)
        ).exists()
    from apps.billing.models import Purchase

    return Purchase.objects.filter(pk=order.pk, status__in=(Purchase.STATUS_PAID, Purchase.STATUS_REFUNDED)).exists()


def _supersede(order: OpenOrder) -> bool:
    with transaction.atomic():
        if order.kind == "payment":
            row = Payment.objects.select_for_update().filter(pk=order.pk).first()
            if row is None or row.status != Payment.STATUS_CREATED or row.razorpay_order_id != order.order_id:
                return False
            row.status = Payment.STATUS_FAILED
            row.gateway_status = SUPERSEDED_GATEWAY_STATUS
            row.failure_reason = SUPERSEDED_REASON
            row.save(update_fields=["status", "gateway_status", "failure_reason", "updated_at"])
            return True
        from apps.billing.models import Purchase

        row = Purchase.objects.select_for_update().filter(pk=order.pk).first()
        if row is None or row.status != Purchase.STATUS_PENDING or row.provider_order_id != order.order_id:
            return False
        row.status = Purchase.STATUS_FAILED
        row.failure_reason = SUPERSEDED_REASON[:500]
        row.save(update_fields=["status", "failure_reason", "updated_at"])
        return True


def _touch(order: OpenOrder) -> None:
    """Move a checked, still-open row to the back of the queue."""
    # Row saves (not queryset.update) so model signals and the architecture
    # rule "no bulk writes to Payment outside service modules" hold.
    if order.kind == "payment":
        row = Payment.objects.filter(pk=order.pk, status=Payment.STATUS_CREATED).first()
    else:
        from apps.billing.models import Purchase

        row = Purchase.objects.filter(pk=order.pk, status=Purchase.STATUS_PENDING).first()
    if row is not None:
        row.save(update_fields=["updated_at"])


def reconcile_stuck_payments(
    *,
    apply: bool = False,
    now=None,
    min_age_minutes=None,
    max_age_hours=None,
    limit=None,
    supersede_after_hours=None,
    fetch_order=fetch_razorpay_order,
    fetch_payments=fetch_razorpay_order_payments,
) -> ReconcileReport:
    now = now or timezone.now()
    report = ReconcileReport(apply=bool(apply))
    supersede_hours = (
        supersede_after_hours
        if supersede_after_hours is not None
        else int(getattr(settings, "PAYMENT_RECONCILE_SUPERSEDE_AFTER_HOURS", 24) or 0)
    )
    try:
        ensure_gateway_available()
    except RazorpayUnavailable:
        report.stopped = "circuit_open"
        return report
    for order in open_orders(now=now, min_age_minutes=min_age_minutes, max_age_hours=max_age_hours, limit=limit):
        report.checked += 1
        row = {"kind": order.kind, "id": order.pk, "order_id": order.order_id}
        try:
            inspection = inspect_order(order, fetch_order=fetch_order, fetch_payments=fetch_payments)
        except RazorpayUnavailable as exc:
            report.errors += 1
            report.stopped = getattr(exc, "reason", "") or "gateway_unavailable"
            row["result"] = "gateway_unavailable"
            report.rows.append(row)
            break  # the breaker is counting; stop instead of hammering Razorpay
        except RazorpayServiceError:
            report.errors += 1
            row["result"] = "error"
            report.rows.append(row)
            continue
        row["state"] = inspection.state
        if inspection.detail:
            row["detail"] = inspection.detail
        if inspection.state == STATE_CAPTURED:
            report.captured += 1
            row["razorpay_payment_id"] = str(inspection.captured.get("id") or "")
            if apply:
                try:
                    finalized = _finalize(order, inspection.captured)
                except Exception:  # noqa: BLE001 - one bad row must not stop the run
                    logger.exception("payments.reconcile_finalize_failed kind=%s id=%s", order.kind, order.pk)
                    finalized = False
                    report.errors += 1
                report.finalized += int(finalized)
                row["result"] = "finalized" if finalized else "finalize_failed"
                log_security_event(
                    "payment.reconcile_captured_finalized" if finalized else "payment.reconcile_finalize_failed",
                    kind=order.kind,
                    record_id=order.pk,
                    razorpay_order_id=order.order_id,
                )
            else:
                row["result"] = "would_finalize"
        elif inspection.state in SUPERSEDABLE_STATES:
            report.unpaid += 1
            old_enough = bool(supersede_hours) and order.created_at <= now - timedelta(hours=supersede_hours)
            if old_enough and apply:
                closed = _supersede(order)
                report.superseded += int(closed)
                row["result"] = "superseded" if closed else "unchanged"
            elif old_enough:
                row["result"] = "would_supersede"
            else:
                row["result"] = "unpaid"
                if apply:
                    _touch(order)
        elif inspection.state == STATE_IN_PROGRESS:
            report.in_progress += 1
            row["result"] = "in_progress"
            if apply:
                _touch(order)
        else:
            report.needs_review += 1
            row["result"] = "needs_review"
            log_security_event(
                "payment.reconcile_needs_review",
                kind=order.kind,
                record_id=order.pk,
                razorpay_order_id=order.order_id,
                state=inspection.state,
                detail=inspection.detail,
            )
            if apply:
                _touch(order)
        report.rows.append(row)
    logger.info(
        "payments.reconcile apply=%s checked=%s captured=%s finalized=%s superseded=%s unpaid=%s "
        "in_progress=%s needs_review=%s errors=%s stopped=%s",
        report.apply,
        report.checked,
        report.captured,
        report.finalized,
        report.superseded,
        report.unpaid,
        report.in_progress,
        report.needs_review,
        report.errors,
        report.stopped or "-",
    )
    return report


# --- periodic hook (registered in PaymentsConfig.ready) ------------------------


def interval_seconds() -> int:
    return max(60, _setting("PAYMENT_RECONCILE_INTERVAL_SECONDS", 900))


def schedule_reconcile(now=None):
    """Cheap: one query, then at most one deduplicated outbox event per interval."""
    if not enabled():
        return None
    now = now or timezone.now()
    if not has_open_orders(now):
        return None
    from apps.core.outbox import publish

    bucket = int(now.timestamp()) // interval_seconds()
    return publish(EVENT_RECONCILE, {"bucket": bucket}, dedupe_key=f"payments-reconcile:{bucket}")
