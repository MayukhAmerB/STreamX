"""Feature switches: a curated code registry plus audited admin overrides.

UI overhaul plan §5.1 (owner WS-F). Apps register their switches in their own
``features.py`` (autodiscovered by ``CoreConfig.ready``); ``teaching`` is
registered here so the key exists in every process from the first release::

    from apps.core import features

    features.is_enabled("teaching")          # -> bool, never raises
    features.require("teaching")             # raises FeatureDisabled (403 feature_disabled) when off
    features.snapshot()                      # -> {"teaching": False, ...}
    features.set_feature("teaching", True, by=user, note="Spring term", expected_version=0)

Resolution order for a key:

1. ``settings.FEATURE_FORCE`` (emergency lock; the admin switch is disabled),
2. the stored override (``FeatureFlag`` row, written only by ``set_feature``),
3. ``settings.FEATURE_DEFAULT_OVERRIDES`` (``{"teaching": true}`` under tests),
4. the registry default. Unknown keys are off.

Storage and caching: the overrides are read as one small snapshot, cached in
the shared cache (Redis in production) under ``FEATURE_SNAPSHOT_CACHE_KEY``
for ``FEATURE_SNAPSHOT_CACHE_SECONDS`` and memoised per process for
``FEATURE_PROCESS_MEMO_SECONDS`` (2 s), so a permission check costs no query
and a flip reaches every worker within about two seconds. ``set_feature``
deletes both on commit. If the cache and the database are both unreachable
the registry default is used (Teaching = off): a permission check never
raises because of the switch store ("fail closed").

``apps.core`` must not import other ``apps.*`` packages (tests/test_architecture.py);
models of other apps are looked up lazily with ``django.apps.apps.get_model``.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from .errors import Conflict, FeatureDisabled, NotFound, PermissionDenied, ValidationFailed

logger = logging.getLogger("apps.core.features")

# Groups match the admin navigation groups (plan §4.2).
GROUP_SETTINGS = "settings"
AUDIENCE_INSTRUCTORS = "instructors"

REASON_MAX_LENGTH = 160
NOTE_MAX_LENGTH = 500
HISTORY_LIMIT = 10
LOCKED_MESSAGE = "Locked by server configuration."


@dataclass(frozen=True)
class Feature:
    key: str
    label: str
    summary: str
    group: str = GROUP_SETTINGS
    audience: str = AUDIENCE_INSTRUCTORS
    default: bool = False
    disabled_reason: str = "This section is switched off for now."
    # "Who notices" copy for the admin card (plan §5.5).
    notices: str = ""
    # impact() -> mapping shown on the confirm panel, e.g. {"instructor_accounts": 3, "live_now": 0}.
    impact: Callable[[], Mapping[str, Any]] | None = field(default=None, compare=False, repr=False)


_registry: dict[str, Feature] = {}
_registry_lock = threading.RLock()

# Per-process memo of the stored overrides: (monotonic expiry, overrides).
_memo_lock = threading.Lock()
_memo: dict[str, Any] = {"until": 0.0, "overrides": None}
# Set while this thread holds an uncommitted switch change: its reads go to the
# database and are never published to the cache/memo (other workers must not
# see a change that may still roll back).
_pending = threading.local()


def _has_pending_write() -> bool:
    if not getattr(_pending, "dirty", False):
        return False
    from django.db import connection

    if connection.in_atomic_block:
        return True
    _pending.dirty = False
    return False


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
def register_feature(feature: Feature) -> Feature:
    """Add (or replace, for reloads) a feature in the registry."""
    if not feature.key or not feature.key.replace("_", "").isalnum() or feature.key.lower() != feature.key:
        raise ValueError(f"feature key must be snake_case: {feature.key!r}")
    with _registry_lock:
        _registry[feature.key] = feature
    return feature


def get_feature(key: str) -> Feature | None:
    with _registry_lock:
        return _registry.get(key)


def registered_features() -> list[Feature]:
    with _registry_lock:
        return [_registry[key] for key in sorted(_registry)]


def _bool_map(value) -> dict[str, bool]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): bool(flag) for key, flag in value.items()}


def forced_value(key: str) -> bool | None:
    """The ``FEATURE_FORCE`` lock for ``key`` (None when not locked)."""
    forced = _bool_map(getattr(settings, "FEATURE_FORCE", {}))
    return forced.get(key)


def default_value(key: str) -> bool:
    """Registry default, adjusted by ``FEATURE_DEFAULT_OVERRIDES`` (tests turn teaching on)."""
    feature = get_feature(key)
    if feature is None:
        return False
    overrides = _bool_map(getattr(settings, "FEATURE_DEFAULT_OVERRIDES", {}))
    return overrides.get(key, feature.default)


# ---------------------------------------------------------------------------
# Stored overrides (cache -> DB), fail closed
# ---------------------------------------------------------------------------
def _cache_key() -> str:
    return str(getattr(settings, "FEATURE_SNAPSHOT_CACHE_KEY", "features:snapshot:v1"))


def _cache_seconds() -> int:
    return max(1, int(getattr(settings, "FEATURE_SNAPSHOT_CACHE_SECONDS", 300) or 300))


def _memo_seconds() -> float:
    return max(0.0, float(getattr(settings, "FEATURE_PROCESS_MEMO_SECONDS", 2) or 0))


def _row_dict(row) -> dict[str, Any]:
    updated_by = getattr(row, "updated_by", None)
    return {
        "enabled": bool(row.enabled),
        "reason_override": str(row.reason_override or ""),
        "version": int(row.version or 0),
        "updated_by": (getattr(updated_by, "email", "") or None) if updated_by is not None else None,
        "updated_by_name": _display_name(updated_by) if updated_by is not None else "",
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def _load_from_db() -> dict[str, dict[str, Any]]:
    from .models import FeatureFlag

    rows = FeatureFlag.objects.select_related("updated_by").all()
    return {row.key: _row_dict(row) for row in rows}


def _read_overrides() -> dict[str, dict[str, Any]] | None:
    """Stored overrides, or None when neither the cache nor the DB answers."""
    if _has_pending_write():
        try:
            return _load_from_db()
        except Exception:  # noqa: BLE001
            return None
    now = time.monotonic()
    with _memo_lock:
        if _memo["overrides"] is not None and now < _memo["until"]:
            return _memo["overrides"]
    overrides = None
    try:
        cached = cache.get(_cache_key())
        if isinstance(cached, dict):
            overrides = cached
    except Exception:  # noqa: BLE001 - the cache is an optimisation only
        logger.warning("feature_flag.cache_unavailable")
    if overrides is None:
        try:
            overrides = _load_from_db()
        except Exception:  # noqa: BLE001 - fail closed (registry defaults)
            logger.warning("feature_flag.store_unavailable")
            return None
        try:
            cache.set(_cache_key(), overrides, timeout=_cache_seconds())
        except Exception:  # noqa: BLE001
            pass
    memo_seconds = _memo_seconds()
    if memo_seconds > 0:
        with _memo_lock:
            _memo["overrides"] = overrides
            _memo["until"] = time.monotonic() + memo_seconds
    return overrides


def stored_override(key: str) -> dict[str, Any] | None:
    overrides = _read_overrides() or {}
    row = overrides.get(key)
    return dict(row) if isinstance(row, dict) else None


def invalidate_cache() -> None:
    """Forget the shared snapshot and this process's memo."""
    with _memo_lock:
        _memo["overrides"] = None
        _memo["until"] = 0.0
    try:
        cache.delete(_cache_key())
    except Exception:  # noqa: BLE001
        logger.warning("feature_flag.cache_delete_failed", exc_info=True)


def _reset_stub_state_for_tests() -> None:
    """Forget cached overrides (tests and the E2E reset call this; rows live in the DB)."""
    invalidate_cache()


# ---------------------------------------------------------------------------
# Read API
# ---------------------------------------------------------------------------
def is_enabled(key: str) -> bool:
    """True when the feature is on. Fails closed to the default; never raises."""
    try:
        if get_feature(key) is None:
            return False
        forced = forced_value(key)
        if forced is not None:
            return forced
        row = stored_override(key)
        if row is not None:
            return bool(row["enabled"])
        return default_value(key)
    except Exception:  # noqa: BLE001 - a permission check must never crash
        try:
            return default_value(key)
        except Exception:  # noqa: BLE001
            return False


def snapshot() -> dict[str, bool]:
    """``{key: enabled}`` for every registered feature."""
    return {feature.key: is_enabled(feature.key) for feature in registered_features()}


def version() -> int:
    """A number that changes whenever any switch's stored state changes."""
    overrides = _read_overrides() or {}
    return 1 + sum(int(row.get("version", 0)) for row in overrides.values() if isinstance(row, dict))


def fingerprint() -> str:
    """Short hash of the effective state (stored, forced and default): an ETag seed."""
    parts = []
    for feature in registered_features():
        row = stored_override(feature.key) or {}
        parts.append(f"{feature.key}={int(is_enabled(feature.key))}:{row.get('version', 0)}:{reason_for(feature.key)}")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]


def reason_for(key: str) -> str:
    """User-facing reason shown while ``key`` is off."""
    try:
        row = stored_override(key) or {}
    except Exception:  # noqa: BLE001
        row = {}
    feature = get_feature(key)
    if forced_value(key) is not None:
        row = {}
    return str(row.get("reason_override") or (feature.disabled_reason if feature else "This section is switched off."))


def require(key: str) -> None:
    """Raise ``FeatureDisabled`` (403 ``feature_disabled``) when ``key`` is off."""
    if not is_enabled(key):
        raise disabled_error(key)


def disabled_error(key: str) -> FeatureDisabled:
    """The ``FeatureDisabled`` for ``key`` (logged so a spike of refusals is visible)."""
    logger.info("feature_flag.denied feature=%s", key)
    return FeatureDisabled(reason_for(key), details={"feature": key})


def _display_name(user) -> str:
    if user is None:
        return ""
    name = ""
    for attr in ("full_name", "get_full_name"):
        value = getattr(user, attr, "")
        value = value() if callable(value) else value
        if value:
            name = str(value).strip()
            break
    return name or str(getattr(user, "email", "") or "")


def _history_rows(key: str, limit: int = HISTORY_LIMIT):
    from .models import FeatureFlagChange

    return list(FeatureFlagChange.objects.filter(key=key).select_related("changed_by").order_by("-changed_at", "-id")[:limit])


def history_count(key: str) -> int:
    from .models import FeatureFlagChange

    try:
        return FeatureFlagChange.objects.filter(key=key).count()
    except Exception:  # noqa: BLE001
        return 0


def state(key: str) -> dict[str, Any]:
    """Stored state of one feature for the admin card (version, who, when, last 10 changes)."""
    row = stored_override(key) or {}
    try:
        history = [
            {
                "from": change.from_enabled,
                "to": change.to_enabled,
                "note": change.note,
                "changed_by": change.changed_by_email or None,
                "changed_at": change.changed_at.isoformat(),
            }
            for change in _history_rows(key)
        ]
    except Exception:  # noqa: BLE001 - informative only
        history = []
    return {
        "version": int(row.get("version", 0)),
        "updated_by": row.get("updated_by"),
        "updated_at": row.get("updated_at"),
        "history": history,
    }


def impact(key: str) -> dict[str, Any]:
    feature = get_feature(key)
    if feature is None or feature.impact is None:
        return {}
    try:
        return dict(feature.impact())
    except Exception:  # noqa: BLE001 - impact is informative only
        logger.warning("feature_flag.impact_failed feature=%s", key, exc_info=True)
        return {}


# ---------------------------------------------------------------------------
# Write API (the only way a switch changes)
# ---------------------------------------------------------------------------
def _clean_reason(reason: str | None) -> str | None:
    if reason is None:
        return None
    text = " ".join(str(reason).split())
    if len(text) > REASON_MAX_LENGTH:
        raise ValidationFailed(details={"reason": [f"Keep the reason under {REASON_MAX_LENGTH} characters."]})
    _reject_active_content(text, "reason")
    return text


def _reject_active_content(text: str, field_name: str) -> None:
    from django.core.exceptions import ValidationError

    from config.model_validators import validate_no_active_content

    try:
        validate_no_active_content(text, field_name)
    except ValidationError as exc:
        raise ValidationFailed(details={field_name: ["Remove the script or markup from this text."]}) from exc


def _ago(when) -> str:
    if not when:
        return "just now"
    seconds = max(0, int((timezone.now() - when).total_seconds()))
    if seconds < 60:
        return f"{seconds} s ago" if seconds > 1 else "just now"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} h ago"
    return f"{hours // 24} d ago"


def _request_meta(request) -> tuple[str, str | None]:
    request_id = ""
    ip = None
    try:
        from config.observability import get_request_id

        value = get_request_id()
        request_id = "" if value in (None, "-") else str(value)[:64]
    except Exception:  # noqa: BLE001
        request_id = ""
    if request is not None:
        request_id = str(getattr(request, "request_id", "") or request_id)[:64]
        try:
            from config.client_ip import resolve_client_ip

            ip = resolve_client_ip(request) or None
        except Exception:  # noqa: BLE001
            ip = None
    return request_id, ip


def _log_entry(user, row, *, enabled: bool, note: str) -> None:
    """Django admin ``LogEntry`` so the flip shows in "Recent activity"."""
    if user is None or not getattr(user, "pk", None):
        return
    from django.contrib.admin.models import CHANGE, LogEntry

    message = f"Turned {'on' if enabled else 'off'}" + (f": {note}" if note else "")
    try:
        LogEntry.objects.log_actions(user.pk, [row], CHANGE, change_message=message, single_object=True)
    except AttributeError:  # Django < 5.1
        from django.contrib.contenttypes.models import ContentType

        LogEntry.objects.log_action(  # pragma: no cover - older Django only
            user_id=user.pk,
            content_type_id=ContentType.objects.get_for_model(row).pk,
            object_id=row.pk,
            object_repr=str(row)[:200],
            action_flag=CHANGE,
            change_message=message,
        )


def set_feature(
    key: str,
    enabled: bool,
    *,
    by,
    note: str = "",
    reason: str | None = None,
    expected_version: int | None = None,
    request=None,
) -> dict[str, Any]:
    """Turn ``key`` on or off. Returns the new :func:`state`.

    * ``NotFound`` (``feature_not_found``) for an unknown key;
    * ``PermissionDenied`` (``feature_locked``) while ``FEATURE_FORCE`` locks it;
    * ``Conflict`` 409 ``feature_changed_meanwhile`` when ``expected_version``
      is not the stored version (someone else changed it since the page loaded);
    * a no-op (same state and reason) writes nothing.

    Otherwise, in one transaction: the ``FeatureFlag`` row (version + 1), a
    ``FeatureFlagChange`` history row and a Django ``LogEntry``; on commit the
    cache is dropped and ``feature_flag.changed`` is logged.
    """
    from .models import FeatureFlag, FeatureFlagChange

    feature = get_feature(key)
    if feature is None:
        raise NotFound("Unknown feature.", code="feature_not_found", details={"feature": key})
    if forced_value(key) is not None:
        raise PermissionDenied(LOCKED_MESSAGE, code="feature_locked", details={"feature": key})
    enabled = bool(enabled)
    note = " ".join(str(note or "").split())[:NOTE_MAX_LENGTH]
    if note:
        _reject_active_content(note, "note")
    clean_reason = _clean_reason(reason)
    request_id, ip = _request_meta(request)

    with transaction.atomic():
        _pending.dirty = True
        row = FeatureFlag.objects.select_for_update(of=("self",)).select_related("updated_by").filter(key=key).first()
        current_version = int(row.version) if row else 0
        if expected_version is not None and int(expected_version) != current_version:
            who = _display_name(row.updated_by) if row and row.updated_by_id else "Someone"
            raise Conflict(
                f"{who} changed this {_ago(row.updated_at if row else None)}. Review and try again.",
                code="feature_changed_meanwhile",
                details={"feature": key, "version": current_version},
            )
        before_enabled = bool(row.enabled) if row else default_value(key)
        before_reason = str(row.reason_override or "") if row else ""
        # A reason is only meaningful while off; turning on clears it.
        after_reason = "" if enabled else (before_reason if clean_reason is None else clean_reason)
        if row is not None and before_enabled == enabled and before_reason == after_reason:
            return state(key)
        if row is None and before_enabled == enabled and not after_reason:
            return state(key)
        if row is None:
            row = FeatureFlag(key=key, version=0)
        row.enabled = enabled
        row.reason_override = after_reason
        row.version = current_version + 1
        row.updated_by = by if getattr(by, "pk", None) else None
        row.save()
        FeatureFlagChange.objects.create(
            key=key,
            from_enabled=before_enabled,
            to_enabled=enabled,
            reason_before=before_reason,
            reason_after=after_reason,
            note=note,
            changed_by=row.updated_by,
            changed_by_email=str(getattr(by, "email", "") or "")[:254],
            request_id=request_id,
            ip=ip,
        )
        _log_entry(row.updated_by, row, enabled=enabled, note=note)
        # Visible to this process at once (the same transaction can read it);
        # every other process sees it once the commit drops the shared snapshot.
        invalidate_cache()
        changed_by = getattr(by, "email", "") or ""
        new_version = row.version

        def _after_commit():
            _pending.dirty = False
            invalidate_cache()
            logger.info(
                "feature_flag.changed feature=%s from=%s to=%s version=%s by=%s request_id=%s",
                key,
                before_enabled,
                enabled,
                new_version,
                changed_by,
                request_id,
            )

        transaction.on_commit(_after_commit)
    return state(key)


# ---------------------------------------------------------------------------
# Built-in switches
# ---------------------------------------------------------------------------
def _teaching_impact() -> dict[str, int]:
    """Instructor accounts the switch covers and their classes on air now."""
    from django.apps import apps as django_apps
    from django.contrib.auth import get_user_model
    from django.db.models import Q

    user_model = get_user_model()
    try:
        instructors = user_model.objects.filter(
            role="instructor", is_staff=False, is_superuser=False, is_active=True
        ).count()
    except Exception:  # noqa: BLE001
        instructors = 0
    live_now = 0
    try:
        session_model = django_apps.get_model("realtime", "RealtimeSession")
        non_staff = {"is_staff": False, "is_superuser": False}
        hosted = Q(**{f"host__{name}": value for name, value in non_staff.items()}, host__role="instructor")
        owned = Q(
            **{f"linked_course__instructor__{name}": value for name, value in non_staff.items()},
            linked_course__instructor__role="instructor",
        )
        live_now = session_model.objects.filter(status="live").filter(hosted | owned).distinct().count()
    except Exception:  # noqa: BLE001 - informative only
        live_now = 0
    return {"instructor_accounts": instructors, "live_now": live_now}


TEACHING = register_feature(
    Feature(
        key="teaching",
        label="Teachers section",
        summary="Lets instructor accounts create courses, host classes, upload recordings, grade reports and read exams.",
        group=GROUP_SETTINGS,
        audience=AUDIENCE_INSTRUCTORS,
        default=False,
        disabled_reason="Teaching tools are switched off for now. An admin can turn them on.",
        notices=(
            "When off: instructors see the section greyed out with a short reason · "
            "Students: never affected · Admins: your own tools stay on"
        ),
        impact=_teaching_impact,
    )
)


# Engagement (apps.engagement): XP, levels, streaks, badges, leaderboards,
# achievements and certificates. Ships ON (owner decision: rewards from release
# day; run engagement_backfill and engagement_issue_certificates once at release).
# Off => its APIs answer 403 feature_disabled and no XP is awarded; all stored
# data is kept.
ENGAGEMENT = register_feature(
    Feature(
        key="engagement",
        label="Engagement (XP, streaks, badges)",
        summary="XP for learning activity, levels, study streaks, badges, batch leaderboards and shareable achievements.",
        group=GROUP_SETTINGS,
        audience="students",
        default=True,  # owner decision: on from release day
        disabled_reason="XP, streaks and leaderboards are switched off for now.",
        notices=(
            "When off: students see no XP, streaks, badges or leaderboards and earn no XP · "
            "Stored XP and badges are kept · Teachers and admins: not affected"
        ),
    )
)
