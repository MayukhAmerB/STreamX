import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from django.db import IntegrityError, transaction

from .models import PaymentIdempotencyRecord

IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{8,200}$")


class InvalidIdempotencyKey(ValueError):
    pass


class IdempotencyConflict(ValueError):
    pass


@dataclass(frozen=True)
class IdempotencyClaim:
    record: PaymentIdempotencyRecord
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


def claim_create_order(
    *,
    raw_key: object,
    user: Any,
    buyer_email: object,
    request_payload: Mapping[str, Any],
) -> IdempotencyClaim | None:
    raw_key = str(raw_key or "").strip()
    if not raw_key:
        return None
    if not IDEMPOTENCY_KEY_PATTERN.fullmatch(raw_key):
        raise InvalidIdempotencyKey(
            "Idempotency-Key must be 8-200 characters using letters, numbers, dot, underscore, tilde, or dash."
        )

    lookup = {
        "scope": PaymentIdempotencyRecord.SCOPE_CREATE_ORDER,
        "identity_hash": _digest(_identity_for_request(user=user, buyer_email=buyer_email)),
        "key_hash": _digest(raw_key),
    }
    fingerprint = _request_fingerprint(request_payload)

    try:
        with transaction.atomic():
            record, created = PaymentIdempotencyRecord.objects.get_or_create(
                **lookup,
                defaults={"request_fingerprint": fingerprint},
            )
    except IntegrityError:
        record = PaymentIdempotencyRecord.objects.get(**lookup)
        created = False

    if not created and record.request_fingerprint != fingerprint:
        raise IdempotencyConflict(
            "This Idempotency-Key was already used with a different payment request."
        )
    if not created and record.status == PaymentIdempotencyRecord.STATUS_PROCESSING:
        raise IdempotencyConflict("This payment request is already being processed.")
    return IdempotencyClaim(record=record, replay=not created)


def complete_claim(
    claim: IdempotencyClaim | None,
    *,
    payment: Any,
    response_payload: dict[str, Any],
    response_status: int,
) -> None:
    if claim is None:
        return
    PaymentIdempotencyRecord.objects.filter(pk=claim.record.pk).update(
        payment=payment,
        status=PaymentIdempotencyRecord.STATUS_COMPLETED,
        response_payload=response_payload,
        response_status=response_status,
    )
