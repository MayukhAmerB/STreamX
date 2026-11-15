"""Domain exception hierarchy rendered by ``apps.core.exception_handler``.

Raise these from services and views instead of hand-building error responses::

    from apps.core.errors import Conflict, NotFound

    raise NotFound("Course not found.", code="course_not_found")
    raise Conflict("This order was already captured.", code="order_already_captured",
                   details={"order_id": order.pk})

Every error renders as the project envelope with a stable machine code::

    {"success": false, "message": "...", "data": null,
     "errors": {"detail": "...", ...details, "code": "course_not_found"},
     "code": "course_not_found", "detail": "..."}

``code`` is part of the API contract: clients may branch on it, so never
reuse a code for a different meaning and never put user data in it.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any


class DomainError(Exception):
    """Base class for expected, client-visible failures.

    ``status`` is the HTTP status, ``code`` a stable snake_case identifier,
    ``message`` a human sentence safe to show to end users, ``details`` an
    optional JSON-serialisable mapping merged into ``errors`` (field errors
    for validation, ids for conflicts, ...). ``headers`` are added to the
    HTTP response (e.g. ``Retry-After``).
    """

    status: int = 400
    code: str = "domain_error"
    default_message: str = "The request could not be completed."

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        status: int | None = None,
        details: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ):
        self.message = str(message or self.default_message)
        if code:
            self.code = str(code)
        if status:
            self.status = int(status)
        self.details = dict(details or {})
        self.headers = dict(headers or {})
        super().__init__(self.message)

    def __repr__(self):
        return f"{type(self).__name__}(code={self.code!r}, status={self.status}, message={self.message!r})"


class ValidationFailed(DomainError):
    """Input is invalid. ``details`` should map field -> [messages]."""

    status = 400
    code = "validation_failed"
    default_message = "Please correct the highlighted fields."


class AuthenticationRequired(DomainError):
    status = 401
    code = "not_authenticated"
    default_message = "Authentication credentials were not provided."


class PermissionDenied(DomainError):
    status = 403
    code = "permission_denied"
    default_message = "You do not have permission to perform this action."


class NotFound(DomainError):
    status = 404
    code = "not_found"
    default_message = "Not found."


class Conflict(DomainError):
    """The request conflicts with the current state (duplicate, wrong state)."""

    status = 409
    code = "conflict"
    default_message = "The request conflicts with the current state of the resource."


class Unprocessable(DomainError):
    status = 422
    code = "unprocessable"
    default_message = "The request was understood but cannot be processed."


def _retry_after_header(retry_after: float | int | None) -> dict[str, str]:
    if retry_after is None:
        return {}
    try:
        seconds = max(1, int(math.ceil(float(retry_after))))
    except (TypeError, ValueError):
        return {}
    return {"Retry-After": str(seconds)}


class RateLimited(DomainError):
    status = 429
    code = "rate_limited"
    default_message = "Too many requests. Please wait a moment and try again."

    def __init__(self, message: str | None = None, *, retry_after: float | int | None = None, **kwargs):
        headers = {**_retry_after_header(retry_after), **dict(kwargs.pop("headers", None) or {})}
        details = dict(kwargs.pop("details", None) or {})
        if "Retry-After" in headers:
            details.setdefault("retry_after", int(headers["Retry-After"]))
        super().__init__(message, headers=headers, details=details, **kwargs)
        self.retry_after = retry_after


class UpstreamUnavailable(DomainError):
    """A dependency (Owncast, LiveKit, Razorpay, SMTP...) failed or is open-circuited."""

    status = 503
    code = "upstream_unavailable"
    default_message = "A required service is temporarily unavailable. Please try again shortly."

    def __init__(
        self,
        message: str | None = None,
        *,
        upstream: str = "",
        retry_after: float | int | None = None,
        **kwargs,
    ):
        headers = {**_retry_after_header(retry_after), **dict(kwargs.pop("headers", None) or {})}
        details = dict(kwargs.pop("details", None) or {})
        if upstream:
            details.setdefault("upstream", upstream)
        if "Retry-After" in headers:
            details.setdefault("retry_after", int(headers["Retry-After"]))
        super().__init__(message, headers=headers, details=details, **kwargs)
        self.upstream = upstream
        self.retry_after = retry_after


# --- idempotency ------------------------------------------------------------


class IdempotencyKeyInvalid(ValidationFailed):
    code = "idempotency_key_invalid"
    default_message = (
        "Idempotency-Key must be 8-200 characters using letters, numbers, dot, underscore, tilde, or dash."
    )


class IdempotencyKeyRequired(ValidationFailed):
    code = "idempotency_key_required"
    default_message = "An Idempotency-Key header is required for this request."


class IdempotencyInProgress(Conflict):
    code = "idempotency_in_progress"
    default_message = "An identical request is still being processed. Please retry shortly."


class IdempotencyKeyReused(Unprocessable):
    code = "idempotency_key_reused"
    default_message = "This Idempotency-Key was already used with a different request."
