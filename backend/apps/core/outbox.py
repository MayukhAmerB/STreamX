"""Transactional outbox: side effects that survive crashes and never fire for
rolled-back changes.

Problem: ``order.save(); send_email(...)`` either sends an email for an order
that then rolls back, or loses the email when the process dies after commit.
Fix: write the intent as a row *in the same transaction* as the business
change, and let the async worker deliver it (at least once) afterwards::

    from apps.core.outbox import publish

    with transaction.atomic():
        payment.mark_paid()
        publish("payments.receipt_email", {"payment_id": payment.pk},
                dedupe_key=f"receipt:{payment.pk}")

    # apps/payments/outbox_handlers.py (autodiscovered by CoreConfig.ready)
    from apps.core.outbox import outbox_handler

    @outbox_handler("payments.receipt_email", max_attempts=6)
    def send_receipt(event):
        payment = Payment.objects.get(pk=event.payload["payment_id"])
        if payment.receipt_sent_at:          # idempotent: effect happens once
            return
        send_receipt_email(payment)
        Payment.objects.filter(pk=payment.pk, receipt_sent_at__isnull=True).update(receipt_sent_at=now())

Delivery: ``drain_outbox`` is called by ``manage.py process_async_jobs`` (the
existing worker containers) and by ``manage.py drain_outbox``. Rows are
claimed with ``SELECT ... FOR UPDATE SKIP LOCKED`` on Postgres, so the two
worker replicas never deliver the same event concurrently. A claim that is
not finished within ``OUTBOX_LOCK_TIMEOUT_SECONDS`` (worker crashed) is
reclaimed. Failures retry with exponential backoff + jitter until
``max_attempts``, then the event is dead-lettered (``status=dead``) and can
be retried from the Django admin.

Exactly-once *effect* = at-least-once delivery + idempotent handler: the
handler checks/records that its effect already happened (a marker column, a
unique key on the produced row, or an Idempotency-Key sent to the upstream).
"""

from __future__ import annotations

import logging
import os
import random
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from config.metrics import record_outbox_event
from config.observability import get_request_id
from django.conf import settings
from django.db import IntegrityError, connection, transaction
from django.db.models import F
from django.utils import timezone

from .models import OutboxEvent

logger = logging.getLogger("apps.core.outbox")


class PermanentFailure(Exception):
    """Raise from a handler when retrying cannot help; the event dead-letters now."""


@dataclass(frozen=True)
class HandlerSpec:
    event_type: str
    func: Callable[[OutboxEvent], Any]
    max_attempts: int | None = None


_handlers: dict[str, HandlerSpec] = {}
_handlers_lock = threading.Lock()


def outbox_handler(event_type: str, *, max_attempts: int | None = None):
    """Register ``func(event)`` as the single handler for ``event_type``."""
    name = str(event_type or "").strip()
    if not name:
        raise ValueError("outbox_handler requires an event type.")

    def decorator(func):
        with _handlers_lock:
            existing = _handlers.get(name)
            if existing is not None and existing.func is not func and (
                existing.func.__module__,
                existing.func.__qualname__,
            ) != (func.__module__, func.__qualname__):
                raise ValueError(f"Outbox event type {name!r} already has a handler: {existing.func!r}")
            _handlers[name] = HandlerSpec(name, func, max_attempts)
        return func

    return decorator


def registered_handlers() -> dict[str, HandlerSpec]:
    with _handlers_lock:
        return dict(_handlers)


def unregister_handler(event_type: str) -> None:
    """Test helper."""
    with _handlers_lock:
        _handlers.pop(event_type, None)


def _default_max_attempts() -> int:
    return max(1, int(getattr(settings, "OUTBOX_DEFAULT_MAX_ATTEMPTS", 8)))


def publish(
    event_type: str,
    payload: dict | None = None,
    *,
    dedupe_key: str | None = None,
    max_attempts: int | None = None,
    delay_seconds: float = 0,
) -> OutboxEvent:
    """Record a side effect in the CURRENT transaction.

    Call it inside the same ``transaction.atomic()`` block as the business
    change: if that rolls back, the event disappears with it. Outside a
    transaction it is a plain autocommit insert (still durable, but no longer
    atomic with anything else). ``dedupe_key`` makes publishing idempotent:
    a second publish with the same key returns the existing event.
    """
    name = str(event_type or "").strip()
    if not name:
        raise ValueError("publish() requires an event type.")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError("Outbox payloads must be JSON objects (dict).")
    spec = registered_handlers().get(name)
    if spec is None:
        logger.warning("outbox: publishing %r with no registered handler; it will dead-letter", name)
    attempts = max_attempts or (spec.max_attempts if spec else None) or _default_max_attempts()
    fields = {
        "event_type": name,
        "payload": payload or {},
        "max_attempts": max(1, int(attempts)),
        "available_at": timezone.now() + timedelta(seconds=max(0.0, float(delay_seconds or 0))),
        "request_id": "" if get_request_id() == "-" else str(get_request_id())[:128],
    }
    if not dedupe_key:
        return OutboxEvent.objects.create(**fields)
    dedupe_key = str(dedupe_key)[:200]
    try:
        with transaction.atomic():  # savepoint so a duplicate does not break the caller's transaction
            return OutboxEvent.objects.create(dedupe_key=dedupe_key, **fields)
    except IntegrityError:
        return OutboxEvent.objects.get(dedupe_key=dedupe_key)


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{threading.get_ident()}"[:120]


def _lock_timeout() -> timedelta:
    return timedelta(seconds=max(30, int(getattr(settings, "OUTBOX_LOCK_TIMEOUT_SECONDS", 300))))


def backoff_seconds(attempts: int, *, rng: Callable[[float, float], float] = random.uniform) -> float:
    """Exponential backoff with "equal jitter": half fixed, half random.

    attempts=1 -> 7.5..15s, 2 -> 15..30s, ... capped at OUTBOX_MAX_BACKOFF_SECONDS.
    """
    base = max(1.0, float(getattr(settings, "OUTBOX_BACKOFF_BASE_SECONDS", 15)))
    cap = max(base, float(getattr(settings, "OUTBOX_MAX_BACKOFF_SECONDS", 3600)))
    ceiling = min(cap, base * (2 ** max(0, int(attempts) - 1)))
    return ceiling / 2 + rng(0.0, ceiling / 2)


def reclaim_stale(now=None) -> int:
    """Return events whose worker died mid-delivery to the queue.

    An event that already used all its attempts (it keeps killing workers)
    is dead-lettered instead of being retried forever.
    """
    now = now or timezone.now()
    stale = OutboxEvent.objects.filter(
        status=OutboxEvent.STATUS_PROCESSING,
        locked_at__lt=now - _lock_timeout(),
    )
    exhausted = stale.filter(attempts__gte=F("max_attempts")).update(
        status=OutboxEvent.STATUS_DEAD,
        locked_at=None,
        last_error="Delivery never finished (worker lost the lock) and max_attempts is used up.",
    )
    if exhausted:
        logger.error("outbox: %s event(s) dead-lettered after repeated worker loss", exhausted)
    reclaimed = stale.update(status=OutboxEvent.STATUS_PENDING, locked_at=None, locked_by="", available_at=now)
    return reclaimed + exhausted


def claim_batch(limit: int, *, worker_id: str | None = None, now=None) -> list[OutboxEvent]:
    """Atomically move up to ``limit`` due events to PROCESSING and return them.

    ``attempts`` is incremented at claim time, so an event whose handler
    crashes the process still burns an attempt (no infinite poison loop).
    """
    now = now or timezone.now()
    worker_id = worker_id or _worker_id()
    with transaction.atomic():
        queryset = OutboxEvent.objects.filter(
            status=OutboxEvent.STATUS_PENDING,
            available_at__lte=now,
        ).order_by("available_at", "id")
        if connection.vendor == "postgresql":
            queryset = queryset.select_for_update(skip_locked=True)
        else:
            queryset = queryset.select_for_update()
        ids = list(queryset.values_list("id", flat=True)[: max(1, int(limit))])
        if not ids:
            return []
        OutboxEvent.objects.filter(id__in=ids).update(
            status=OutboxEvent.STATUS_PROCESSING,
            locked_at=now,
            locked_by=worker_id,
            attempts=F("attempts") + 1,
        )
    return list(OutboxEvent.objects.filter(id__in=ids).order_by("available_at", "id"))


def _fenced(event: OutboxEvent):
    """Rows still owned by this delivery (not reclaimed by another worker)."""
    return OutboxEvent.objects.filter(
        pk=event.pk,
        status=OutboxEvent.STATUS_PROCESSING,
        locked_at=event.locked_at,
        locked_by=event.locked_by,
    )


def _mark_delivered(event: OutboxEvent) -> None:
    _fenced(event).update(
        status=OutboxEvent.STATUS_DELIVERED,
        delivered_at=timezone.now(),
        locked_at=None,
        last_error="",
    )


def _mark_failed(event: OutboxEvent, error_text: str, *, permanent: bool) -> str:
    now = timezone.now()
    error_text = str(error_text or "")[:5000]
    if permanent or event.attempts >= event.max_attempts:
        _fenced(event).update(status=OutboxEvent.STATUS_DEAD, last_error=error_text, locked_at=None)
        return "dead"
    _fenced(event).update(
        status=OutboxEvent.STATUS_PENDING,
        last_error=error_text,
        locked_at=None,
        locked_by="",
        available_at=now + timedelta(seconds=backoff_seconds(event.attempts)),
    )
    return "retry"


def deliver(event: OutboxEvent) -> str:
    """Run the handler for one claimed event. Returns delivered|retry|dead."""
    spec = registered_handlers().get(event.event_type)
    if spec is None:
        outcome = _mark_failed(event, f"No outbox handler registered for {event.event_type!r}.", permanent=True)
        record_outbox_event(event=event.event_type, result=outcome)
        logger.error("outbox: event %s (%s) has no handler; dead-lettered", event.pk, event.event_type)
        return outcome
    try:
        spec.func(event)
    except PermanentFailure as exc:
        outcome = _mark_failed(event, f"PermanentFailure: {exc}", permanent=True)
    except Exception as exc:  # noqa: BLE001 - handler bugs/outages become retries
        outcome = _mark_failed(event, f"{type(exc).__name__}: {exc}", permanent=False)
        log = logger.error if outcome == "dead" else logger.warning
        log(
            "outbox: event %s (%s) attempt %s/%s failed -> %s: %s",
            event.pk, event.event_type, event.attempts, event.max_attempts, outcome, exc,
        )
    else:
        _mark_delivered(event)
        outcome = "delivered"
    record_outbox_event(event=event.event_type, result=outcome)
    return outcome


def drain_outbox(*, batch_size: int = 50, worker_id: str | None = None) -> dict[str, int]:
    """Deliver one batch of due events. Safe to call concurrently from many workers."""
    stats = {"reclaimed": reclaim_stale(), "claimed": 0, "delivered": 0, "retried": 0, "dead": 0}
    events = claim_batch(batch_size, worker_id=worker_id)
    stats["claimed"] = len(events)
    for event in events:
        outcome = deliver(event)
        key = {"delivered": "delivered", "retry": "retried", "dead": "dead"}[outcome]
        stats[key] += 1
    return stats


def retry_events(queryset) -> int:
    """Admin action helper: put dead/pending events back for immediate delivery."""
    return queryset.exclude(status=OutboxEvent.STATUS_DELIVERED).exclude(
        status=OutboxEvent.STATUS_PROCESSING
    ).update(
        status=OutboxEvent.STATUS_PENDING,
        attempts=0,
        available_at=timezone.now(),
        locked_at=None,
        locked_by="",
    )


def prune_delivered(*, older_than_days: int | None = None, batch_size: int = 1000) -> int:
    days = older_than_days if older_than_days is not None else int(getattr(settings, "OUTBOX_RETENTION_DAYS", 14))
    cutoff = timezone.now() - timedelta(days=max(1, days))
    ids = list(
        OutboxEvent.objects.filter(status=OutboxEvent.STATUS_DELIVERED, delivered_at__lt=cutoff).values_list(
            "pk", flat=True
        )[: max(1, batch_size)]
    )
    if not ids:
        return 0
    deleted, _ = OutboxEvent.objects.filter(pk__in=ids).delete()
    return deleted
