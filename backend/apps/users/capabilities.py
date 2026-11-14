"""What the signed-in viewer may use in the Console (plan §5.2, Appendix A.1).

OWNER: WS-F (created by WS-0). The Console reads this to decide whether each
workspace / nav item is ``enabled``, ``disabled`` (with a reason) or
``hidden``. The server still enforces every rule (``apps/users/teaching.py``,
WS-F); this is only the map the UI draws.

Viewer matrix (``teaching`` off → on):

- student:     teach hidden → hidden
- instructor:  teach disabled with reason → enabled   (non-staff only)
- staff:       teach hidden, admin enabled, ``status`` lists the switch while off
"""

from __future__ import annotations

import hashlib
import json

from apps.core import features

from . import teaching

TEACH_ITEM_KEYS = (
    "teach-today",
    "teach-courses",
    "teach-classes",
    "teach-recordings",
    "teach-grading",
    "teach-exams",
)
FEATURES_MANAGE_URL = "/console/admin/settings/features"
STATES = ("enabled", "disabled", "hidden")
# (capabilities item, feature switch) pairs for purchase gates.
PURCHASE_ITEMS = (("pentesting-purchase", "pentesting"), ("memberships", "memberships"))


def _entry(state: str, reason: str = "") -> dict:
    return {"state": state, "reason": reason} if state == "disabled" else {"state": state}


def capabilities_version() -> int:
    """Changes whenever any switch's stored state changes."""
    return features.version()


def build_capabilities(user) -> dict:
    snap = features.snapshot()
    teaching_on = bool(snap.get(teaching.FEATURE_KEY))
    staff = teaching.is_staff(user)
    instructor = teaching.acts_as_instructor(user)

    if instructor:
        teach = _entry("enabled") if teaching_on else _entry("disabled", teaching.reason())
    else:
        teach = _entry("hidden")

    payload = {
        "version": capabilities_version(),
        "features": {key: {"enabled": value} for key, value in snap.items()},
        "workspaces": {
            "learn": _entry("enabled"),
            "teach": teach,
            "admin": _entry("enabled" if staff else "hidden"),
        },
        "items": {key: dict(teach) for key in TEACH_ITEM_KEYS},
    }
    # Purchase gates (WS catalog-plans, contract §6): the UI disables, never hides.
    for item_key, feature_key in PURCHASE_ITEMS:
        on = bool(snap.get(feature_key))
        payload["items"][item_key] = _entry("enabled") if on else _entry("disabled", features.reason_for(feature_key))
    if staff:
        feature = features.get_feature(teaching.FEATURE_KEY)
        # Owner decision D2 default: staff see the switch's status only while it is off.
        payload["status"] = (
            []
            if teaching_on
            else [{"key": feature.key, "label": feature.label, "enabled": False, "manage_url": FEATURES_MANAGE_URL}]
        )
        for _item_key, feature_key in PURCHASE_ITEMS:
            gate = features.get_feature(feature_key)
            if gate is not None and not snap.get(feature_key):
                payload["status"].append(
                    {"key": gate.key, "label": gate.label, "enabled": False, "manage_url": FEATURES_MANAGE_URL}
                )
    return payload


def capabilities_etag(payload: dict) -> str:
    """Strong ETag of one viewer's capabilities (the payload itself is hashed)."""
    body = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return '"caps-' + hashlib.sha256(body.encode("utf-8")).hexdigest()[:24] + '"'
