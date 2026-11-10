"""Startup configuration guard (Django system checks).

Severity policy -- read before adding a check:

* ``backend/entrypoint.sh`` runs ``manage.py check --deploy --fail-level
  WARNING`` before every production container start, so in production a
  WARNING blocks startup exactly like an ERROR.
* ERROR   = known-broken or unsafe configuration; refusing to start is better
            than serving traffic with it.
* INFO    = advisory; printed by ``check --deploy`` but never blocks.
* WARNING is not used for production-posture checks (it would silently be a
  second kind of ERROR).

Normal checks (every manage.py command) validate value *sanity* that is
wrong in any environment. Deploy checks (``--deploy``) validate production
*posture* and only fire when ``APP_ENV`` is production, so local
``check --deploy`` stays usable.

IDs: core.E0xx errors, core.I0xx infos (listed in apps/core/README.md).
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

from django.conf import settings
from django.core.checks import Error, Info, Tags, register

CORE_TAG = "core"
PLACEHOLDER_SECRETS = {"", "admin", "change-me", "changeme", "dev-only-secret-key", "devkey", "secret", "insecure"}


def _is_production() -> bool:
    return str(getattr(settings, "APP_ENV", "") or "").strip().lower() in {"production", "prod"}


def _is_placeholder(value) -> bool:
    normalized = str(value or "").strip().lower()
    return (
        normalized in PLACEHOLDER_SECRETS
        or normalized.startswith(("replace-with-", "django-insecure-", "your-", "changeme"))
    )


def _valid_http_url(value) -> bool:
    parsed = urlparse(str(value or "").strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _as_int(name, default=None):
    value = getattr(settings, name, default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# --- normal checks (every environment) ----------------------------------------


@register(CORE_TAG)
def check_stream_recorder_settings(app_configs=None, **kwargs):
    if not bool(getattr(settings, "STREAM_RECORDER_ENABLED", False)):
        return []
    errors = []
    source_url = getattr(settings, "STREAM_RECORDER_SOURCE_URL", "")
    if not _valid_http_url(source_url):
        errors.append(
            Error(
                "STREAM_RECORDER_SOURCE_URL must be an http(s) URL of the Owncast HLS playlist.",
                hint="e.g. http://owncast:8080/hls/stream.m3u8",
                id="core.E010",
            )
        )
    work_dir = str(getattr(settings, "STREAM_RECORDER_WORK_DIR", "") or "").strip()
    if not work_dir or not (work_dir.startswith("/") or Path(work_dir).is_absolute()):
        errors.append(
            Error(
                "STREAM_RECORDER_WORK_DIR must be an absolute path.",
                hint="e.g. /recordings/class-recordings (the recordings volume).",
                id="core.E011",
            )
        )
    positive = {
        "STREAM_RECORDER_MAX_BYTES": 1,
        "STREAM_RECORDER_MAX_DURATION_SECONDS": 60,
        "STREAM_RECORDER_RESTART_BACKOFF_SECONDS": 1,
        "STREAM_RECORDER_FINALIZE_QUEUE_SIZE": 1,
    }
    for name, minimum in positive.items():
        value = _as_int(name)
        if value is None or value < minimum:
            errors.append(Error(f"{name} must be an integer >= {minimum}.", id="core.E012"))
    min_free = _as_int("STREAM_RECORDER_MIN_FREE_BYTES")
    if min_free is None or min_free < 0:
        errors.append(Error("STREAM_RECORDER_MIN_FREE_BYTES must be a non-negative integer.", id="core.E012"))
    try:
        factor = float(getattr(settings, "STREAM_RECORDER_FINALIZE_SPACE_FACTOR", 2.0))
    except (TypeError, ValueError):
        factor = 0.0
    if factor < 1.0:
        errors.append(
            Error(
                "STREAM_RECORDER_FINALIZE_SPACE_FACTOR must be >= 1.0 (finalize needs at least the input size).",
                id="core.E013",
            )
        )
    return errors


@register(CORE_TAG)
def check_prometheus_url(app_configs=None, **kwargs):
    value = str(getattr(settings, "PROMETHEUS_URL", "") or "").strip()
    if value and not _valid_http_url(value):
        return [
            Error(
                f"PROMETHEUS_URL must be an http(s) URL or empty (got {value!r}).",
                hint="Empty disables the infrastructure dashboard sections; default is http://prometheus:9090.",
                id="core.E014",
            )
        ]
    return []


@register(CORE_TAG, Tags.security)
def check_proxy_trust_settings(app_configs=None, **kwargs):
    count = _as_int("TRUSTED_PROXY_COUNT", 1)
    if count is None or count < 1 or count > 5:
        return [
            Error(
                "TRUSTED_PROXY_COUNT must be an integer between 1 and 5.",
                hint="Production chain Cloudflare -> host nginx -> gateway uses 1 (see config/client_ip.py).",
                id="core.E015",
            )
        ]
    if count > 2:
        return [
            Info(
                f"TRUSTED_PROXY_COUNT={count} strips more internal hops than the documented chain (1).",
                hint="Only raise it if another internal proxy appends to X-Forwarded-For.",
                id="core.I015",
            )
        ]
    return []


@register(CORE_TAG)
def check_core_settings(app_configs=None, **kwargs):
    errors = []
    ttl = _as_int("IDEMPOTENCY_KEY_TTL_SECONDS", 86400)
    lease = _as_int("IDEMPOTENCY_LEASE_SECONDS", 60)
    if ttl is None or lease is None or lease < 1 or ttl < lease:
        errors.append(
            Error(
                "IDEMPOTENCY_KEY_TTL_SECONDS and IDEMPOTENCY_LEASE_SECONDS must be positive with TTL >= lease.",
                id="core.E016",
            )
        )
    attempts = _as_int("OUTBOX_DEFAULT_MAX_ATTEMPTS", 8)
    if attempts is None or attempts < 1:
        errors.append(Error("OUTBOX_DEFAULT_MAX_ATTEMPTS must be an integer >= 1.", id="core.E017"))
    breakers = getattr(settings, "CIRCUIT_BREAKERS", {}) or {}
    defaults = getattr(settings, "CIRCUIT_BREAKER_DEFAULTS", {}) or {}
    allowed = {"failure_threshold", "failure_window_seconds", "open_seconds", "probe_timeout_seconds", "cache_alias"}
    if not isinstance(breakers, dict) or not isinstance(defaults, dict):
        errors.append(Error("CIRCUIT_BREAKERS / CIRCUIT_BREAKER_DEFAULTS must be dicts.", id="core.E018"))
    else:
        for name, config in [("<defaults>", defaults), *breakers.items()]:
            unknown = set((config or {}).keys()) - allowed if isinstance(config, dict) else {"<not a dict>"}
            if unknown:
                errors.append(
                    Error(
                        f"Circuit breaker {name!r} has unknown options: {', '.join(sorted(unknown))}.",
                        id="core.E018",
                    )
                )
    return errors


# --- deploy checks (production posture) ----------------------------------------


@register(CORE_TAG, Tags.security, deploy=True)
def check_production_posture(app_configs=None, **kwargs):
    if not _is_production():
        return []
    messages = []

    if _is_placeholder(getattr(settings, "SECRET_KEY", "")):
        messages.append(
            Error("SECRET_KEY is empty or a placeholder in production.", hint="Set DJANGO_SECRET_KEY.", id="core.E001")
        )
    if bool(getattr(settings, "DEBUG", False)):
        messages.append(Error("DEBUG must be False in production.", id="core.E002"))

    hosts = [str(host).strip() for host in getattr(settings, "ALLOWED_HOSTS", []) or []]
    if not hosts or "*" in hosts:
        messages.append(
            Error(
                "ALLOWED_HOSTS must list the production hostnames (and must not contain '*').",
                id="core.E003",
            )
        )

    cache_backend = str((getattr(settings, "CACHES", {}) or {}).get("default", {}).get("BACKEND", ""))
    if "redis" not in cache_backend.lower():
        messages.append(
            Error(
                f"The default cache must be Redis in production (got {cache_backend or 'none'}).",
                hint=(
                    "Set REDIS_URL. Throttles, circuit breakers, locks and single-flight caches are "
                    "per-process (i.e. broken) with LocMemCache across gunicorn workers."
                ),
                id="core.E004",
            )
        )

    if bool(getattr(settings, "DIRECT_COURSE_PAYMENTS_ENABLED", False)):
        missing = [
            name
            for name in ("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET")
            if _is_placeholder(getattr(settings, name, ""))
        ]
        if missing:
            messages.append(
                Error(
                    "Direct payments are enabled but these Razorpay settings are missing: " + ", ".join(missing) + ".",
                    hint="Set them or DIRECT_COURSE_PAYMENTS_ENABLED=0.",
                    id="core.E005",
                )
            )
        elif str(getattr(settings, "RAZORPAY_KEY_ID", "")).startswith("rzp_test_"):
            messages.append(
                Info("Razorpay TEST keys are configured in production; no real money will be collected.", id="core.I001")
            )

    if not bool(getattr(settings, "TRUST_X_FORWARDED_FOR", False)):
        messages.append(
            Error(
                "TRUST_X_FORWARDED_FOR is off in production.",
                hint=(
                    "Behind host nginx + gateway every client would resolve to the gateway address: "
                    "one shared throttle bucket for all users and useless audit IPs."
                ),
                id="core.E006",
            )
        )

    if not str(getattr(settings, "METRICS_AUTH_TOKEN", "") or "").strip():
        messages.append(
            Info(
                "METRICS_AUTH_TOKEN is empty; /metrics is limited to internal addresses only.",
                id="core.I002",
            )
        )

    email_backend = str(getattr(settings, "EMAIL_BACKEND", "") or "")
    if email_backend.endswith(("console.EmailBackend", "locmem.EmailBackend", "dummy.EmailBackend")):
        messages.append(Info(f"EMAIL_BACKEND is {email_backend}; emails are not delivered.", id="core.I003"))

    media_root = str(getattr(settings, "MEDIA_ROOT", "") or "")
    if media_root and os.path.isdir(media_root):
        if not os.access(media_root, os.W_OK):
            messages.append(
                Error(
                    f"MEDIA_ROOT ({media_root}) is not writable by this process.",
                    hint="Uploads, class recordings and HLS transcodes would fail.",
                    id="core.E007",
                )
            )
    elif media_root:
        messages.append(
            Info(f"MEDIA_ROOT ({media_root}) does not exist yet; it is created on first upload.", id="core.I004")
        )
    return messages
