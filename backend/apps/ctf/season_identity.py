"""Public identity on Monthly CTF boards and the Hall of Fame: the HANDLE, always.

Owner rule (privacy, handle only): students see each other by their profile
handle only; real names appear ONLY on certificates. The handle comes from
``apps.profiles.handles`` (the profile handle, or the account's automatic
``operative_...`` handle until the profile exists). ``derived_handle`` (the
older HMAC pseudonym, e.g. ``QuietFalcon42``) is kept only for callers that
still import it; it is no longer shown anywhere.
"""

from __future__ import annotations

import hashlib
import hmac

from django.conf import settings


REAL_NAMES_FEATURE = "public_real_names"

_ADJECTIVES = (
    "Quiet", "Amber", "Silent", "Steady", "Patient", "Keen", "Lucid", "Calm",
    "Bright", "Swift", "Careful", "Candid", "Sharp", "Still", "Bold", "Clear",
    "Noble", "Brisk", "Gentle", "Hidden", "Lunar", "Polar", "Rapid", "Sober",
    "Subtle", "Tidal", "Vivid", "Wise", "Golden", "Ivory", "Silver", "Nimble",
)
_NOUNS = (
    "Falcon", "Heron", "Lynx", "Owl", "Kestrel", "Fox", "Raven", "Otter",
    "Ibex", "Marten", "Osprey", "Wren", "Badger", "Crane", "Hare", "Stag",
    "Atlas", "Beacon", "Cipher", "Compass", "Lantern", "Ledger", "Meridian", "Quill",
    "Sextant", "Signal", "Tracer", "Vector", "Harbour", "Archive", "Prism", "Summit",
)


def _key() -> bytes:
    secret = str(getattr(settings, "SECRET_KEY", "") or "")
    return hashlib.sha256(f"apps.ctf.season-handle\x1f{secret}".encode()).digest()


def derived_handle(user_id: int) -> str:
    digest = hmac.new(_key(), str(int(user_id)).encode(), hashlib.sha256).digest()
    adjective = _ADJECTIVES[digest[0] % len(_ADJECTIVES)]
    noun = _NOUNS[digest[1] % len(_NOUNS)]
    number = 10 + int.from_bytes(digest[2:4], "big") % 90
    return f"{adjective}{noun}{number}"


def real_names_enabled() -> bool:
    """Always False: boards and the Hall of Fame never show real names (owner rule).

    The ``public_real_names`` switch, if an admin ever registers it, is ignored."""
    return False


def public_handle(user) -> str:
    from apps.profiles.handles import public_handle as profile_handle

    return profile_handle(user)


def attach_handles(users) -> None:
    """Resolve the handles of many users in one query before a loop."""
    from apps.profiles.handles import attach_handles as attach

    attach(users)


def public_name(user, *, real_names: bool | None = None) -> str:
    """What boards and the Hall of Fame print for ``user``: the handle (``real_names`` is ignored)."""
    return public_handle(user)


def certificate_name(user) -> str:
    """The name printed on a certificate (the only place a real name appears)."""
    full_name = str(getattr(user, "full_name", "") or "").strip()
    return full_name[:80] if full_name else public_handle(user)
