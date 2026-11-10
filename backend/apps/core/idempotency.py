"""Idempotency keys for unsafe API calls (Stripe-style ``Idempotency-Key``).

A client that retries a POST after a timeout must not create a second order.
The client sends a random ``Idempotency-Key`` header (UUID) per logical
operation; the server stores the first response for 24h and replays it.

Semantics (per scope + caller + key):

* first request            -> runs, response stored (2xx and deterministic 4xx)
* repeat, same body        -> stored response replayed, ``Idempotent-Replayed: true``
* repeat while 1st running -> 409 ``idempotency_in_progress`` + ``Retry-After``
* repeat, different body   -> 422 ``idempotency_key_reused``
* 1st request failed 5xx / raised / answered 401/403/409/429
                           -> key released; the retry runs again
* 1st request crashed      -> after ``IDEMPOTENCY_LEASE_SECONDS`` the next
                              retry takes over with a new lease token, which
                              fences the crashed one out of storing a result.

Atomicity: unique constraint on (scope, owner_hash, key_hash), row lock via
``select_for_update`` and the insert inside a savepoint so a concurrent
insert race resolves to "the other one won" instead of an IntegrityError.

Adoption (DRF)::

    class CreateOrderView(IdempotencyMixin, APIView):
        idempotency_scope = "payments.create_order"
        idempotency_required = True          # 400 when the header is missing

    # or per method
    class VerifyView(APIView):
        @idempotent(scope="payments.verify")
        def post(self, request): ...
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from config.client_ip import resolve_client_ip
from config.metrics import record_idempotency_outcome
from django.conf import settings
from django.core.files.uploadedfile import UploadedFile
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.renderers import JSONRenderer
from rest_framework.request import Request
from rest_framework.response import Response

from .errors import (
    IdempotencyInProgress,
    IdempotencyKeyInvalid,
    IdempotencyKeyRequired,
    IdempotencyKeyReused,
)
from .models import IdempotencyKey

logger = logging.getLogger("apps.core.idempotency")

HEADER = "Idempotency-Key"
REPLAY_HEADER = "Idempotent-Replayed"
KEY_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{8,200}$")
DEFAULT_METHODS = ("POST", "PUT", "PATCH", "DELETE")
# Responses that depend on transient state are not cached: the retry should
# run again (auth refreshed, conflict resolved, throttle window passed).
NON_STORABLE_STATUSES = frozenset({401, 403, 408, 409, 423, 425, 429})


def _ttl_seconds() -> int:
    return max(60, int(getattr(settings, "IDEMPOTENCY_KEY_TTL_SECONDS", 86400)))


def _lease_seconds() -> int:
    return max(1, int(getattr(settings, "IDEMPOTENCY_LEASE_SECONDS", 60)))


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical(value: Any) -> Any:
    if isinstance(value, UploadedFile):
        return {"__file__": value.name, "size": value.size}
    if hasattr(value, "lists") and callable(value.lists):  # QueryDict / MultiValueDict
        return {str(key): [_canonical(item) for item in items] for key, items in sorted(value.lists())}
    if isinstance(value, dict):
        return {str(key): _canonical(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    return value


def request_fingerprint(request: Request) -> str:
    """Stable digest of method + path + query + parsed body."""
    try:
        body = request.data
    except Exception:  # noqa: BLE001 - unparseable body fingerprints as raw marker
        body = {"__unparsed__": True}
    material = {
        "method": request.method,
        "path": request.path,
        "query": sorted((key, value) for key, value in request.query_params.lists()) if request.query_params else [],
        "body": _canonical(body),
    }
    return _digest(json.dumps(material, sort_keys=True, separators=(",", ":"), default=str))


def owner_identity(request: Request) -> str:
    user = getattr(request, "user", None)
    if getattr(user, "is_authenticated", False):
        return f"user:{user.pk}"
    return f"anon:{resolve_client_ip(request)}"


@dataclass(frozen=True)
class Claim:
    record_id: int
    lease_token: uuid.UUID
    scope: str


@dataclass(frozen=True)
class Begin:
    """Result of ``begin``: either a claim to run the request, or a replay."""

    claim: Claim | None = None
    replay: Response | None = None


def begin(request: Request, *, scope: str, required: bool = False) -> Begin:
    raw_key = str(request.headers.get(HEADER, "") or "").strip()
    if not raw_key:
        if required:
            record_idempotency_outcome(scope=scope, outcome="missing")
            raise IdempotencyKeyRequired()
        return Begin()
    if not KEY_PATTERN.fullmatch(raw_key):
        record_idempotency_outcome(scope=scope, outcome="invalid")
        raise IdempotencyKeyInvalid()

    now = timezone.now()
    lookup = {
        "scope": scope,
        "owner_hash": _digest(owner_identity(request)),
        "key_hash": _digest(raw_key),
    }
    fingerprint = request_fingerprint(request)
    fresh = {
        "request_fingerprint": fingerprint,
        "status": IdempotencyKey.STATUS_IN_PROGRESS,
        "lease_token": uuid.uuid4(),
        "locked_until": now + timedelta(seconds=_lease_seconds()),
        "response_status": None,
        "response_body": None,
        "created_at": now,
        "expires_at": now + timedelta(seconds=_ttl_seconds()),
    }

    with transaction.atomic():
        try:
            record = IdempotencyKey.objects.select_for_update().get(**lookup)
            created = False
        except IdempotencyKey.DoesNotExist:
            try:
                with transaction.atomic():  # savepoint: losing the race must not poison the outer tx
                    record = IdempotencyKey.objects.create(**lookup, **fresh)
                created = True
            except IntegrityError:
                record = IdempotencyKey.objects.select_for_update().get(**lookup)
                created = False

        if created:
            record_idempotency_outcome(scope=scope, outcome="new")
            return Begin(claim=Claim(record.pk, record.lease_token, scope))

        if record.expires_at <= now:
            # The previous use is older than the retention window: start over.
            for name, value in fresh.items():
                setattr(record, name, value)
            record.save()
            record_idempotency_outcome(scope=scope, outcome="new")
            return Begin(claim=Claim(record.pk, record.lease_token, scope))

        if record.request_fingerprint != fingerprint:
            record_idempotency_outcome(scope=scope, outcome="mismatch")
            raise IdempotencyKeyReused()

        if record.status == IdempotencyKey.STATUS_COMPLETED:
            record_idempotency_outcome(scope=scope, outcome="replay")
            response = Response(record.response_body, status=record.response_status or 200)
            response[REPLAY_HEADER] = "true"
            return Begin(replay=response)

        if record.locked_until > now:
            record_idempotency_outcome(scope=scope, outcome="in_progress")
            retry_after = max(1, int((record.locked_until - now).total_seconds()))
            raise IdempotencyInProgress(
                headers={"Retry-After": str(min(retry_after, 5))},
                details={"retry_after": min(retry_after, 5)},
            )

        # The previous attempt crashed or overran its lease: take over.
        record.lease_token = uuid.uuid4()
        record.locked_until = now + timedelta(seconds=_lease_seconds())
        record.save(update_fields=["lease_token", "locked_until", "updated_at"])
        record_idempotency_outcome(scope=scope, outcome="takeover")
        logger.warning("idempotency %s: lease expired, request %s taken over", scope, record.pk)
        return Begin(claim=Claim(record.pk, record.lease_token, scope))


def _json_safe(data: Any) -> Any:
    if data is None:
        return None
    return json.loads(JSONRenderer().render(data).decode("utf-8") or "null")


def complete(claim: Claim | None, response: Response | None) -> bool:
    """Store ``response`` for replay, or release the key. Returns True if stored."""
    if claim is None:
        return False
    status_code = int(getattr(response, "status_code", 500) or 500)
    storable = response is not None and status_code < 500 and status_code not in NON_STORABLE_STATUSES
    if storable:
        try:
            body = _json_safe(getattr(response, "data", None))
        except Exception:  # noqa: BLE001 - non-JSON response: don't cache it
            storable = False
    if not storable:
        release(claim)
        return False
    updated = IdempotencyKey.objects.filter(
        pk=claim.record_id,
        lease_token=claim.lease_token,
        status=IdempotencyKey.STATUS_IN_PROGRESS,
    ).update(
        status=IdempotencyKey.STATUS_COMPLETED,
        response_status=status_code,
        response_body=body,
        updated_at=timezone.now(),
    )
    if not updated:
        logger.warning("idempotency %s: lease for record %s lost before completion", claim.scope, claim.record_id)
    return bool(updated)


def release(claim: Claim | None) -> None:
    """Forget an in-progress key so the client's retry runs again."""
    if claim is None:
        return
    IdempotencyKey.objects.filter(
        pk=claim.record_id,
        lease_token=claim.lease_token,
        status=IdempotencyKey.STATUS_IN_PROGRESS,
    ).delete()


def prune_expired(*, batch_size: int = 1000) -> int:
    """Delete expired keys in bounded batches; called by the async worker."""
    ids = list(
        IdempotencyKey.objects.filter(expires_at__lte=timezone.now()).values_list("pk", flat=True)[: max(1, batch_size)]
    )
    if not ids:
        return 0
    deleted, _ = IdempotencyKey.objects.filter(pk__in=ids).delete()
    return deleted


class _Replay(Exception):
    def __init__(self, response: Response):
        super().__init__("idempotent replay")
        self.response = response


class IdempotencyMixin:
    """DRF APIView/ViewSet mixin. Put it FIRST in the bases.

    Runs after authentication/permissions/throttling (inside ``initial``) so
    the owner is the authenticated user and rejected requests never claim keys.
    """

    idempotency_scope: str | None = None
    idempotency_methods: tuple[str, ...] = DEFAULT_METHODS
    idempotency_required: bool = False

    def get_idempotency_scope(self) -> str:
        return self.idempotency_scope or f"{type(self).__module__}.{type(self).__name__}"

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        self._idempotency_claim = None
        if request.method.upper() not in self.idempotency_methods:
            return
        outcome = begin(request, scope=self.get_idempotency_scope(), required=self.idempotency_required)
        if outcome.replay is not None:
            raise _Replay(outcome.replay)
        self._idempotency_claim = outcome.claim

    def handle_exception(self, exc):
        if isinstance(exc, _Replay):
            return exc.response
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        claim = getattr(self, "_idempotency_claim", None)
        if claim is not None:
            self._idempotency_claim = None
            try:
                complete(claim, response)
            except Exception:  # noqa: BLE001 - never fail the real response on bookkeeping
                logger.exception("idempotency %s: failed to store response", claim.scope)
        return response


def idempotent(scope: str | None = None, *, required: bool = False):
    """Decorator for a DRF view method or ``@api_view`` function."""

    def decorator(view_func):
        resolved_scope = scope or f"{view_func.__module__}.{view_func.__qualname__}"

        @functools.wraps(view_func)
        def wrapper(*args, **kwargs):
            request = next((arg for arg in args if isinstance(arg, Request)), None)
            if request is None:
                raise TypeError("@idempotent must decorate a DRF view (no rest_framework Request found).")
            outcome = begin(request, scope=resolved_scope, required=required)
            if outcome.replay is not None:
                return outcome.replay
            try:
                response = view_func(*args, **kwargs)
            except BaseException:
                release(outcome.claim)
                raise
            try:
                complete(outcome.claim, response)
            except Exception:  # noqa: BLE001
                logger.exception("idempotency %s: failed to store response", resolved_scope)
            return response

        return wrapper

    return decorator
