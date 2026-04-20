import json
import logging
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from django.conf import settings
from rest_framework import status

from config.audit import log_security_event
from config.client_ip import resolve_client_ip
from config.response import api_response

logger = logging.getLogger(__name__)

TOKEN_FIELD_NAMES = ("turnstile_token", "cf-turnstile-response")


def turnstile_enabled():
    return bool(getattr(settings, "TURNSTILE_ENABLED", False))


def turnstile_site_key():
    return str(getattr(settings, "TURNSTILE_SITE_KEY", "") or "").strip()


def turnstile_public_config():
    site_key = turnstile_site_key()
    return {
        "turnstile_enabled": bool(turnstile_enabled() and site_key),
        "turnstile_site_key": site_key if turnstile_enabled() else "",
    }


def enforce_turnstile(request, *, action):
    if not turnstile_enabled():
        return None

    secret = str(getattr(settings, "TURNSTILE_SECRET_KEY", "") or "").strip()
    if not secret:
        logger.error("TURNSTILE_ENABLED is true but TURNSTILE_SECRET_KEY is empty")
        return _turnstile_error(
            "Security verification is not configured correctly.",
            code="turnstile_not_configured",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    token = _extract_token(request)
    if not token:
        log_security_event("turnstile.token_missing", request=request, action=action)
        return _turnstile_error("Complete the security check and try again.", code="turnstile_required")

    if len(token) > int(getattr(settings, "TURNSTILE_MAX_TOKEN_LENGTH", 2048)):
        log_security_event("turnstile.token_too_long", request=request, action=action)
        return _turnstile_error("Security verification failed. Please try again.", code="turnstile_failed")

    result = _call_siteverify(secret=secret, token=token, remote_ip=resolve_client_ip(request))
    if not result.get("success"):
        log_security_event(
            "turnstile.verify_failed",
            request=request,
            action=action,
            error_codes=list(result.get("error-codes") or []),
            hostname=result.get("hostname"),
        )
        return _turnstile_error("Security verification failed. Please try again.", code="turnstile_failed")

    action_error = _validate_action(result, action)
    if action_error is not None:
        return action_error

    hostname_error = _validate_hostname(result, action, request)
    if hostname_error is not None:
        return hostname_error

    return None


def _extract_token(request):
    data = getattr(request, "data", {}) or {}
    for field_name in TOKEN_FIELD_NAMES:
        token = str(data.get(field_name) or "").strip()
        if token:
            return token
    return ""


def _call_siteverify(*, secret, token, remote_ip):
    payload = {
        "secret": secret,
        "response": token,
    }
    if remote_ip:
        payload["remoteip"] = remote_ip

    body = urlencode(payload).encode("utf-8")
    verify_url = (
        str(getattr(settings, "TURNSTILE_VERIFY_URL", "") or "").strip()
        or "https://challenges.cloudflare.com/turnstile/v0/siteverify"
    )
    request = Request(
        verify_url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=int(getattr(settings, "TURNSTILE_VERIFY_TIMEOUT_SECONDS", 5))) as response:
            result = json.loads(response.read().decode("utf-8"))
            if isinstance(result, dict):
                return result
            return {"success": False, "error-codes": ["invalid-response"]}
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        logger.warning("Turnstile Siteverify request failed: %s", exc)
        return {"success": False, "error-codes": ["internal-error"]}


def _validate_action(result, expected_action):
    actual_action = str(result.get("action") or "").strip()
    if not actual_action or actual_action == expected_action:
        return None

    logger.warning("Turnstile action mismatch: expected=%s actual=%s", expected_action, actual_action)
    return _turnstile_error("Security verification failed. Please try again.", code="turnstile_failed")


def _validate_hostname(result, action, request):
    allowed_hostnames = list(getattr(settings, "TURNSTILE_ALLOWED_HOSTNAMES", []) or [])
    if not allowed_hostnames:
        return None

    hostname = str(result.get("hostname") or "").strip().lower()
    allowed = {str(item).strip().lower() for item in allowed_hostnames if str(item).strip()}
    if hostname in allowed:
        return None

    log_security_event(
        "turnstile.hostname_mismatch",
        request=request,
        action=action,
        hostname=hostname,
        allowed_hostnames=sorted(allowed),
    )
    return _turnstile_error("Security verification failed. Please try again.", code="turnstile_failed")


def _turnstile_error(message, *, code, status_code=status.HTTP_400_BAD_REQUEST):
    return api_response(
        success=False,
        message="Security verification failed.",
        errors={"detail": message, "code": code},
        status_code=status_code,
    )
