import hashlib
import json
import re
import uuid
from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import PaymentCheckoutLock, PaymentIdempotencyRecord

IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{8,200}$")


class InvalidIdempotencyKey(ValueError):
    pass


class IdempotencyConflict(ValueError):
    pass


@dataclass(frozen=True)
class IdempotencyClaim:
    record: PaymentIdempotencyRecord
    lease_token: uuid.UUID
    replay: bool = False


def _digest(value: object) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _request_fingerprint(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return _digest(encoded)


def _identity_for_request(*, user: Any, buyer_email: object) -> str:
    if user and user.is_authenticated:
        return f"user:{user.pk}"
    return f"guest:{str(buyer_email or '').strip().lower()}"


def checkout_identity_hash(*, user: Any, buyer_email: object) -> str:
    return _digest(_identity_for_request(user=user, buyer_email=buyer_email))


def find_completed_create_order_replay(
    *,
    raw_key: object,
    user: Any,
    buyer_email: object,
    request_payload: Mapping[str, Any],
) -> IdempotencyClaim | None:
    """Read a completed checkout proof without creating or reclaiming a lease."""
    raw_key = str(raw_key or "").strip()
    if not raw_key or not IDEMPOTENCY_KEY_PATTERN.fullmatch(raw_key):
        return None
    try:
        record = PaymentIdempotencyRecord.objects.select_related("payment").get(
            scope=PaymentIdempotencyRecord.SCOPE_CREATE_ORDER,
            identity_hash=checkout_identity_hash(
                user=user,
                buyer_email=buyer_email,
            ),
            key_hash=_digest(raw_key),
        )
    except PaymentIdempotencyRecord.DoesNotExist:
        return None
    if record.request_fingerprint != _request_fingerprint(request_payload):
        raise IdempotencyConflict(
            "This Idempotency-Key was already used with a different payment request."
        )
    if record.status != PaymentIdempotencyRecord.STATUS_COMPLETED:
        return None
    return IdempotencyClaim(
        record=record,
        lease_token=record.lease_token,
        replay=True,
    )


@contextmanager
def serialized_checkout(*, user: Any, buyer_email: object, course: Any):
    """Hold a row lock for one canonical buyer/course checkout operation."""
    lookup = {
        "course": course,
        "identity_hash": checkout_identity_hash(user=user, buyer_email=buyer_email),
    }
    with transaction.atomic():
        try:
            checkout_lock = PaymentCheckoutLock.objects.select_for_update().get(**lookup)
        except PaymentCheckoutLock.DoesNotExist:
            try:
                with transaction.atomic():
                    checkout_lock = PaymentCheckoutLock.objects.create(**lookup)
            except IntegrityError:
                checkout_lock = PaymentCheckoutLock.objects.select_for_update().get(**lookup)
        yield checkout_lock


def claim_create_order(
    *,
    raw_key: object,
    user: Any,
    buyer_email: object,
    request_payload: Mapping[str, Any],
) -> IdempotencyClaim | None:
    raw_key = str(raw_key or "").strip()
    if not raw_key:
        raise InvalidIdempotencyKey("Idempotency-Key is required for payment requests.")
    if not IDEMPOTENCY_KEY_PATTERN.fullmatch(raw_key):
        raise InvalidIdempotencyKey(
            "Idempotency-Key must be 8-200 characters using letters, numbers, dot, underscore, tilde, or dash."
        )

    lookup = {
        "scope": PaymentIdempotencyRecord.SCOPE_CREATE_ORDER,
        "identity_hash": checkout_identity_hash(user=user, buyer_email=buyer_email),
        "key_hash": _digest(raw_key),
    }
    fingerprint = _request_fingerprint(request_payload)

    with transaction.atomic():
        try:
            record = PaymentIdempotencyRecord.objects.select_for_update().get(**lookup)
            created = False
        except PaymentIdempotencyRecord.DoesNotExist:
            try:
                # Keep the insert in a savepoint so a concurrent unique-key win
                # does not poison the surrounding transaction.
                with transaction.atomic():
                    record = PaymentIdempotencyRecord.objects.create(
                        **lookup,
                        request_fingerprint=fingerprint,
                    )
                created = True
            except IntegrityError:
                record = PaymentIdempotencyRecord.objects.select_for_update().get(**lookup)
                created = False

        if not created and record.request_fingerprint != fingerprint:
            raise IdempotencyConflict(
                "This Idempotency-Key was already used with a different payment request."
            )
        if not created and record.status == PaymentIdempotencyRecord.STATUS_PROCESSING:
            lease_seconds = max(
                1,
                int(getattr(settings, "PAYMENT_IDEMPOTENCY_LEASE_SECONDS", 60)),
            )
            lease_cutoff = timezone.now() - timedelta(seconds=lease_seconds)
            if record.updated_at > lease_cutoff:
                raise IdempotencyConflict("This payment request is already being processed.")

            # A new token fences a former worker that resumes after its lease
            # expired; only the current owner may publish the final response.
            record.lease_token = uuid.uuid4()
            record.save(update_fields=["lease_token", "updated_at"])
            return IdempotencyClaim(
                record=record,
                lease_token=record.lease_token,
                replay=False,
            )

        return IdempotencyClaim(
            record=record,
            lease_token=record.lease_token,
            replay=not created,
        )


def complete_claim(
    claim: IdempotencyClaim | None,
    *,
    payment: Any,
    response_payload: dict[str, Any],
    response_status: int,
) -> bool:
    if claim is None:
        return True
    updated = PaymentIdempotencyRecord.objects.filter(
        pk=claim.record.pk,
        lease_token=claim.lease_token,
        status=PaymentIdempotencyRecord.STATUS_PROCESSING,
    ).update(
        payment=payment,
        status=PaymentIdempotencyRecord.STATUS_COMPLETED,
        response_payload=response_payload,
        response_status=response_status,
    )
    return updated == 1
