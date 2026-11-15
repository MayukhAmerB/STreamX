"""Entitlement key registry.

Built-in keys live here; admins add more under Billing > Entitlement keys (no
code change). A key that ``takes_argument`` is a prefix: ``course_access``
allows ``course_access:12``. Other apps may also call ``register_key`` from
their ``AppConfig.ready``.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class KeySpec:
    key: str
    label: str
    takes_argument: bool = False
    description: str = ""


BUILTIN_KEYS: dict[str, KeySpec] = {}


def register_key(key: str, label: str, *, takes_argument: bool = False, description: str = "") -> KeySpec:
    spec = KeySpec(key=key, label=label, takes_argument=takes_argument, description=description)
    BUILTIN_KEYS[key] = spec
    return spec


register_key("course_access", "Course access (live classes and recordings)", takes_argument=True,
             description="course_access:<course id>; the courses app creates or extends the enrolment.")
register_key("free_ctfs", "Free CTFs")
register_key("easy_ctfs", "Easy CTFs")
register_key("side_courses", "Side courses that bridge the gap")
register_key("weekly_challenges", "Weekly OSINT challenges")
register_key("special_ctfs", "Special OSINT CTFs")
register_key("resources", "Extra resources")
register_key("all_labs", "All labs (every difficulty)")


def split_key(key: str) -> tuple[str, str | None]:
    base, sep, arg = str(key or "").partition(":")
    return base, (arg if sep else None)


def all_specs() -> dict[str, KeySpec]:
    """Built-in plus active admin-registered keys (read fresh, never cached)."""
    from .models import EntitlementKey

    specs = dict(BUILTIN_KEYS)
    for row in EntitlementKey.objects.filter(is_active=True):
        specs.setdefault(row.key, KeySpec(row.key, row.label, row.takes_argument, row.description))
    return specs


def is_registered(key: str) -> bool:
    base, arg = split_key(key)
    spec = BUILTIN_KEYS.get(base)
    if spec is None:
        from .models import EntitlementKey

        row = EntitlementKey.objects.filter(key=base, is_active=True).first()
        if row is None:
            return False
        spec = KeySpec(row.key, row.label, row.takes_argument)
    return bool(arg) if spec.takes_argument else arg is None


def describe(key: str) -> str:
    base, arg = split_key(key)
    spec = all_specs().get(base)
    if spec is None:
        return key
    return f"{spec.label} ({arg})" if arg else spec.label
