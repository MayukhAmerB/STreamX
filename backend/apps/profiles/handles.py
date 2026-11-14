"""Public identity of a student inside the application: the profile HANDLE.

Owner rule (privacy, handle only): every student-facing surface (leaderboards,
profiles, Monthly CTF boards and Hall of Fame, comments, live-class chat and
meeting names, achievements shown to others, activity feeds) shows another
student by their handle only. Real names appear ONLY on certificates (the
certificate page/PDF and its delivery to the student). Staff screens keep the
identity block of ``apps.users.identity`` (roll number, real name, handle).

API (every other app imports these; no view imports involved)::

    from apps.profiles.handles import public_display_name, public_handle, public_handles

    public_display_name(user)  # -> handle for students, real name for instructors/staff
    public_handles([3, 7])   # -> {3: "night_owl_42", 7: "operative_k3q7xa"}  (ONE query)
    public_handle(user)      # -> "night_owl_42"

Every student has a handle: the profile row's handle when it exists, otherwise
the deterministic automatic handle ``derived_handle(user_id)`` -- the exact
handle ``manage.py generate_missing_handles --apply`` (and the first visit to
the profile editor) will store for that account. Automatic handles look like
``operative_k3q7xa``: a keyed HMAC of the user id (``SECRET_KEY``), never
derived from the name or e-mail, and the ``operative_`` prefix is reserved for
them (students cannot pick it), so a fallback can never show another
student's chosen handle.
"""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Iterable

from django.conf import settings
from django.contrib.auth import get_user_model

AUTO_PREFIX = "operative_"
_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
_SUFFIX_LENGTH = 6


def _key() -> bytes:
    secret = str(getattr(settings, "SECRET_KEY", "") or "")
    return hashlib.sha256(f"apps.profiles.auto-handle\x1f{secret}".encode()).digest()


def derived_handle(user_id: int, attempt: int = 0) -> str:
    """``operative_<6 chars>``: stable per account (and per ``attempt`` on a collision)."""
    message = f"{int(user_id)}:{int(attempt)}".encode()
    digest = hmac.new(_key(), message, hashlib.sha256).digest()
    number = int.from_bytes(digest[:8], "big")
    chars = []
    for _ in range(_SUFFIX_LENGTH):
        number, index = divmod(number, len(_ALPHABET))
        chars.append(_ALPHABET[index])
    return AUTO_PREFIX + "".join(chars)


def is_auto_handle(handle: str) -> bool:
    return str(handle or "").startswith(AUTO_PREFIX)


def _user_id(user_or_id) -> int | None:
    if user_or_id is None:
        return None
    if isinstance(user_or_id, int):
        return user_or_id
    value = getattr(user_or_id, "pk", None)
    if value is None:
        value = getattr(user_or_id, "id", None)
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def public_handles(user_ids: Iterable) -> dict[int, str]:
    """``{user_id: handle}`` for the existing accounts among ``user_ids`` (one query).

    Unknown or deleted ids are absent (callers skip them). Accounts without a
    profile yet get their automatic handle.
    """
    ids = sorted({uid for uid in (_user_id(item) for item in user_ids or ()) if uid})
    if not ids:
        return {}
    rows = get_user_model().objects.filter(pk__in=ids).values_list("pk", "student_profile__handle")
    return {int(pk): (handle or derived_handle(pk)) for pk, handle in rows}


def public_handle(user_or_id) -> str:
    """The handle of one account (one query; use ``public_handles`` for lists)."""
    user_id = _user_id(user_or_id)
    if not user_id:
        return ""
    cached = getattr(user_or_id, "_public_handle", None)
    if cached:
        return cached
    return public_handles([user_id]).get(user_id) or derived_handle(user_id)


CACHE_SECONDS = 300


def _cache_key(user_id: int) -> str:
    return f"profiles:handle:{int(user_id)}"


def cached_handle(user_or_id) -> str:
    """``public_handle`` through the shared cache (no query on a hit): for hot
    endpoints that show the viewer their own handle."""
    from django.core.cache import cache

    user_id = _user_id(user_or_id)
    if not user_id:
        return ""
    try:
        value = cache.get(_cache_key(user_id))
    except Exception:  # noqa: BLE001 - the cache is an optimisation only
        value = None
    if value:
        return value
    value = public_handle(user_id)
    try:
        cache.set(_cache_key(user_id), value, CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        pass
    return value


def forget_handle(user_or_id) -> None:
    """Drop the cached handle (called when a profile is created or the handle changes)."""
    from django.core.cache import cache

    user_id = _user_id(user_or_id)
    if not user_id:
        return
    try:
        cache.delete(_cache_key(user_id))
    except Exception:  # noqa: BLE001
        pass


def attach_handles(users: Iterable) -> None:
    """Set ``user._public_handle`` on model instances in one query (for loops)."""
    users = [user for user in users or () if user is not None]
    missing = []
    for user in users:
        # ``select_related("user__student_profile")`` already joined the profile: no query.
        cache = getattr(getattr(user, "_state", None), "fields_cache", {})
        if "student_profile" in cache:
            profile = cache["student_profile"]
            user._public_handle = (profile.handle if profile is not None else "") or derived_handle(user.pk)
        else:
            missing.append(user)
    if not missing:
        return
    handles = public_handles(missing)
    for user in missing:
        user._public_handle = handles.get(user.pk) or derived_handle(user.pk)


def is_staff_like(user) -> bool:
    """Staff, admins and instructors keep their real name on surfaces they author."""
    return bool(
        user is not None
        and (getattr(user, "is_staff", False) or getattr(user, "is_superuser", False) or getattr(user, "role", "") == "instructor")
    )


def public_display_name(user) -> str:
    """THE name student-facing surfaces print for ``user`` (owner rule, handle only).

    Students -> their profile handle (or automatic handle), never the real name
    or e-mail. Instructors and staff, who teach under their own name, keep it
    on what they author. Staff/admin screens (grading, payments, attendance,
    exports, Django admin) use ``apps.users.identity`` instead; certificates
    print the real name via their own helpers.
    """
    if user is None:
        return ""
    if is_staff_like(user):
        name = str(getattr(user, "full_name", "") or "").strip()
        if name:
            return name[:80]
    return public_handle(user)


# Older name kept for existing callers.
visible_name = public_display_name
