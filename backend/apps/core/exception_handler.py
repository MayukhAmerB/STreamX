"""Project-wide DRF exception handler: every error leaves as the API envelope.

Shape (all keys always present unless noted)::

    {
      "success": false,
      "message": "<human sentence>",
      "data": null,
      "errors": {
        "detail": "<human sentence>",      # omitted for field validation errors
        "<field>": ["..."],                # validation errors only
        "<extra>": ...,                    # e.g. terms_version, retry_after
        "code": "<machine_code>",
        "request_id": "<id>"               # 5xx only
      },
      "code": "<machine_code>",
      # Backward compatibility with DRF's default shape, which clients and
      # tests read today: "detail" and any other top-level keys DRF emitted
      # (field names for validation errors, "code"/"terms_version"/"messages"
      # for dict details) are mirrored at the top level unless they collide
      # with an envelope key.
      "detail": "<human sentence>"
    }

Ordering matters: ``frontend/src/utils/api.js::apiMessage`` shows the first
value of ``errors``, so ``detail`` (or the first field error) comes first and
``code`` last.
"""

from __future__ import annotations

import logging
from typing import Any

from config.observability import get_request_id
from django.conf import settings
from django.core import signals as django_signals
from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from rest_framework import exceptions as drf_exceptions
from rest_framework import status as http_status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler
from rest_framework.views import set_rollback

from .errors import DomainError

logger = logging.getLogger("apps.core.errors")

ENVELOPE_KEYS = ("success", "message", "data", "errors", "code")
INTERNAL_ERROR_MESSAGE = "An unexpected error occurred. Please try again."
VALIDATION_FALLBACK_MESSAGE = "Please correct the highlighted fields."

# DRF exception class -> stable envelope code. Codes not listed fall back to
# the exception's own ``default_code``.
_DRF_CODE_MAP = {
    drf_exceptions.ValidationError: "validation_failed",
    drf_exceptions.ParseError: "parse_error",
    drf_exceptions.AuthenticationFailed: "authentication_failed",
    drf_exceptions.NotAuthenticated: "not_authenticated",
    drf_exceptions.PermissionDenied: "permission_denied",
    drf_exceptions.NotFound: "not_found",
    drf_exceptions.MethodNotAllowed: "method_not_allowed",
    drf_exceptions.NotAcceptable: "not_acceptable",
    drf_exceptions.UnsupportedMediaType: "unsupported_media_type",
    drf_exceptions.Throttled: "rate_limited",
}


def _plain(value: Any) -> Any:
    """Convert ErrorDetail/lazy strings into JSON-friendly plain values."""
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return str(value) if isinstance(value, str) else value
    return str(value)


def _first_message(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for item in value.values():
            message = _first_message(item)
            if message:
                return message
        return ""
    if isinstance(value, (list, tuple)):
        for item in value:
            message = _first_message(item)
            if message:
                return message
    return ""


def _humanize_field(name: str) -> str:
    return str(name).replace("_", " ").strip().capitalize()


def _validation_message(errors: dict) -> str:
    for field, value in errors.items():
        message = _first_message(value)
        if not message:
            continue
        if field in {"non_field_errors", "detail", drf_settings_non_field_key()}:
            return message
        return f"{_humanize_field(field)}: {message}"
    return VALIDATION_FALLBACK_MESSAGE


def drf_settings_non_field_key() -> str:
    from rest_framework.settings import api_settings

    return api_settings.NON_FIELD_ERRORS_KEY


def build_error_envelope(
    *,
    message: str,
    code: str,
    status_code: int,
    errors: dict | None = None,
    legacy: dict | None = None,
) -> dict:
    """Assemble the envelope. ``errors`` keeps insertion order; code goes last."""
    error_body = dict(errors or {})
    # A *field* named "code" (e.g. the 2FA code) carries a list of messages and
    # wins; the machine code is then still available at the top level.
    if not isinstance(error_body.get("code"), list):
        error_body.pop("code", None)
        error_body["code"] = code
    if status_code >= 500:
        error_body["request_id"] = get_request_id()
    payload = {
        "success": False,
        "message": message,
        "data": None,
        "errors": error_body,
        "code": code,
    }
    for key, value in (legacy or {}).items():
        if key not in payload:
            payload[key] = value
    payload.setdefault("detail", message)
    return payload


def _code_for_drf(exc: drf_exceptions.APIException, data: Any) -> str:
    if isinstance(data, dict) and not isinstance(exc, drf_exceptions.ValidationError):
        explicit = data.get("code")
        if isinstance(explicit, str) and explicit.strip():
            return explicit.strip()
    detail = getattr(exc, "detail", None)
    if isinstance(exc, drf_exceptions.PermissionDenied) and "csrf" in str(detail or "").lower():
        return "csrf_failed"
    for exc_class, code in _DRF_CODE_MAP.items():
        if isinstance(exc, exc_class):
            return code
    explicit_code = getattr(detail, "code", None)
    if isinstance(explicit_code, str) and explicit_code:
        return explicit_code
    return str(getattr(exc, "default_code", "error") or "error")


def _retry_after_seconds(response: Response) -> int | None:
    raw = response.get("Retry-After") if response.has_header("Retry-After") else None
    try:
        return max(0, int(raw)) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _envelope_for_drf(exc: drf_exceptions.APIException, response: Response) -> dict:
    data = _plain(response.data)
    code = _code_for_drf(exc, data)
    status_code = response.status_code

    if isinstance(exc, drf_exceptions.ValidationError):
        if isinstance(data, dict):
            field_errors = data
        else:
            field_errors = {drf_settings_non_field_key(): data if isinstance(data, list) else [data]}
        message = _validation_message(field_errors)
        legacy = data if isinstance(data, dict) else {}
        return build_error_envelope(
            message=message,
            code=code,
            status_code=status_code,
            errors=field_errors,
            legacy=legacy,
        )

    if isinstance(data, dict):
        detail = data.get("detail")
        message = _first_message(detail) if detail is not None else _first_message(data)
        message = message or str(getattr(exc, "default_detail", "") or "Request failed.")
        extras = {key: value for key, value in data.items() if key not in {"detail", "code"}}
        errors = {"detail": message, **extras}
        retry_after = _retry_after_seconds(response)
        if retry_after is not None:
            errors.setdefault("retry_after", retry_after)
        return build_error_envelope(
            message=message,
            code=code,
            status_code=status_code,
            errors=errors,
            legacy=data,
        )

    message = _first_message(data) or str(getattr(exc, "default_detail", "") or "Request failed.")
    return build_error_envelope(
        message=message,
        code=code,
        status_code=status_code,
        errors={"detail": message, "items": data} if isinstance(data, list) else {"detail": message},
    )


def _domain_response(exc: DomainError) -> Response:
    details = _plain(exc.details)
    if exc.status == 400 and exc.code.startswith("validation") and details:
        errors = dict(details)
        message = exc.message
    else:
        errors = {"detail": exc.message, **details}
        message = exc.message
    payload = build_error_envelope(
        message=message,
        code=exc.code,
        status_code=exc.status,
        errors=errors,
    )
    response = Response(payload, status=exc.status)
    for header, value in exc.headers.items():
        response[header] = value
    return response


def _log_server_error(exc: BaseException, context: dict, status_code: int, *, unhandled: bool) -> None:
    request = context.get("request")
    view = context.get("view")
    extra = {
        "request_id": get_request_id(),
        "status_code": status_code,
        "method": getattr(request, "method", ""),
        "path": getattr(request, "path", ""),
        "view": type(view).__name__ if view is not None else "",
    }
    if unhandled:
        logger.error(
            "Unhandled API exception request_id=%s %s %s view=%s",
            extra["request_id"],
            extra["method"],
            extra["path"],
            extra["view"],
            exc_info=(type(exc), exc, exc.__traceback__),
        )
    else:
        logger.warning(
            "API %s request_id=%s %s %s view=%s error=%r",
            status_code,
            extra["request_id"],
            extra["method"],
            extra["path"],
            extra["view"],
            exc,
        )


def _signal_unhandled(context: dict) -> None:
    """Keep Django's unhandled-exception integrations working.

    ``got_request_exception`` is how Sentry's Django integration captures the
    error and how Django's test client re-raises server errors in tests.
    """
    request = context.get("request")
    django_request = getattr(request, "_request", request)
    try:
        django_signals.got_request_exception.send(sender=None, request=django_request)
    except Exception:  # noqa: BLE001 - a broken receiver must not mask the original error
        logger.exception("got_request_exception receiver failed")


DEFAULT_RETRY_AFTER_SECONDS = 5


def _ensure_retry_after(response: Response) -> Response:
    """Every 429 tells the client when to come back (RFC 9110 section 10.2.3)."""
    if response.status_code == http_status.HTTP_429_TOO_MANY_REQUESTS and not response.has_header("Retry-After"):
        response["Retry-After"] = str(DEFAULT_RETRY_AFTER_SECONDS)
        if isinstance(response.data, dict) and isinstance(response.data.get("errors"), dict):
            response.data["errors"].setdefault("retry_after", DEFAULT_RETRY_AFTER_SECONDS)
    return response


def api_exception_handler(exc: BaseException, context: dict) -> Response | None:
    if isinstance(exc, DomainError):
        set_rollback()
        if exc.status >= 500:
            _log_server_error(exc, context, exc.status, unhandled=False)
        return _ensure_retry_after(_domain_response(exc))

    if isinstance(exc, DjangoValidationError):
        # Model/field validators raised from a view are client errors, not 500s.
        if hasattr(exc, "message_dict"):
            detail = exc.message_dict
        else:
            detail = exc.messages
        exc = drf_exceptions.ValidationError(detail=detail)

    response = drf_exception_handler(exc, context)
    if response is not None:
        if isinstance(exc, (Http404, DjangoPermissionDenied)):
            # DRF converts these internally; re-derive the API exception for codes.
            exc = drf_exceptions.NotFound() if isinstance(exc, Http404) else drf_exceptions.PermissionDenied()
        response.data = _envelope_for_drf(exc, response)
        if response.status_code >= 500:
            _log_server_error(exc, context, response.status_code, unhandled=False)
        return _ensure_retry_after(response)

    # Unhandled exception.
    if getattr(settings, "DEBUG", False) and getattr(settings, "API_DEBUG_RAISE_UNHANDLED", True):
        # Developers keep Django's technical 500 page locally.
        return None
    set_rollback()
    _log_server_error(exc, context, http_status.HTTP_500_INTERNAL_SERVER_ERROR, unhandled=True)
    _signal_unhandled(context)
    payload = build_error_envelope(
        message=INTERNAL_ERROR_MESSAGE,
        code="internal_error",
        status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
        errors={"detail": INTERNAL_ERROR_MESSAGE},
    )
    return Response(payload, status=http_status.HTTP_500_INTERNAL_SERVER_ERROR)
