"""Who may open which labs on labs.alsyedinitiative.com.

* ``labs_membership_required`` off (production default): everybody, every lab,
  exactly as before.
* On: staff always; an active ``ctf_labs`` entitlement opens every difficulty;
  an active ``ctf_starter`` entitlement opens easy and medium only; anybody
  else gets nothing (the labs site shows its sign-in / join page).

Entitlements come from ``PlatformSubscription.access_until`` (paid period +
grace) and active ``PlatformGrant`` rows (manual or one-time) of the plan.

The labs site cannot read the LMS session cookie (different host), so the
browser asks the LMS for a short-lived **labs pass** (``issue_pass``): an
HMAC-SHA256 token over ``{sub, dif, stf, exp}`` with ``LABS_PASS_SECRET``,
which ``OSINTCTF/server.js`` verifies locally on every request.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import datetime
from datetime import timezone as dt_timezone

from django.conf import settings
from django.db.models import Q
from django.utils import timezone

ALL_DIFFICULTIES = ["easy", "medium", "expert", "professional"]
STARTER_DIFFICULTIES = ["easy", "medium"]
PASS_VERSION = "v1"


class LabsPassNotConfigured(Exception):
    pass


def membership_required() -> bool:
    from apps.payments.features import labs_membership_required

    return labs_membership_required()


def _is_staff(user) -> bool:
    return bool(user and getattr(user, "is_authenticated", False) and (user.is_staff or user.is_superuser))


def _entitlement(user, product: str, at) -> dict:
    from apps.payments.models import PlatformGrant, PlatformSubscription

    subscription = (
        PlatformSubscription.objects.filter(user=user, plan__product=product, access_until__gt=at)
        .order_by("-access_until")
        .values("access_until")
        .first()
    )
    grant = (
        PlatformGrant.objects.filter(user=user, plan__product=product, is_active=True)
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=at))
        .order_by("-expires_at")
        .values("expires_at")
        .first()
    )
    if grant is not None:
        until = grant["expires_at"]
        if until is None:
            return {"active": True, "until": None, "source": "grant"}
        if subscription is None or until > subscription["access_until"]:
            return {"active": True, "until": until.isoformat(), "source": "grant"}
    if subscription is not None:
        return {"active": True, "until": subscription["access_until"].isoformat(), "source": "subscription"}
    return {"active": False, "until": None, "source": None}


def labs_entitlements(user, at=None) -> dict:
    at = at or timezone.now()
    required = membership_required()
    authenticated = bool(user and getattr(user, "is_authenticated", False))
    staff = _is_staff(user)
    labs = _entitlement(user, "ctf_labs", at) if authenticated else {"active": False, "until": None, "source": None}
    starter = _entitlement(user, "ctf_starter", at) if authenticated else {"active": False, "until": None, "source": None}
    if not required or staff or labs["active"]:
        allowed = list(ALL_DIFFICULTIES)
    elif starter["active"]:
        allowed = list(STARTER_DIFFICULTIES)
    else:
        allowed = []
    return {
        "membership_required": required,
        "staff": staff,
        "ctf_labs": labs,
        "ctf_starter": {"active": starter["active"], "until": starter["until"]},
        "allowed_difficulties": allowed,
    }


def exam_eligible(user) -> bool:
    from apps.courses.access import active_enrollment_q
    from apps.courses.models import Enrollment

    return Enrollment.objects.filter(active_enrollment_q(), user=user).exists()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign_pass(payload: dict, secret: str) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(secret.encode("utf-8"), f"{PASS_VERSION}.{body}".encode("ascii"), hashlib.sha256).digest()
    return f"{PASS_VERSION}.{body}.{_b64(signature)}"


def verify_pass(token: str, secret: str, *, now: float | None = None) -> dict | None:
    """Mirror of the labs server check (used by tests)."""
    try:
        version, body, signature = str(token or "").split(".")
    except ValueError:
        return None
    if version != PASS_VERSION or not secret:
        return None
    expected = _b64(hmac.new(secret.encode("utf-8"), f"{version}.{body}".encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        return None
    padded = body + "=" * (-len(body) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(payload.get("exp", 0)) <= int(now if now is not None else time.time()):
        return None
    return payload


def issue_pass(user) -> dict:
    secret = str(getattr(settings, "LABS_PASS_SECRET", "") or "")
    if not secret:
        raise LabsPassNotConfigured("LABS_PASS_SECRET is not configured.")
    info = labs_entitlements(user)
    ttl = int(getattr(settings, "LABS_PASS_TTL_SECONDS", 1800))
    now = int(time.time())
    expires = now + ttl
    payload = {
        "sub": int(user.pk),
        "dif": info["allowed_difficulties"],
        "stf": bool(info["staff"]),
        # Enrolled students may open the Examination tab (05) even without a
        # labs membership; the exam itself is enforced by the LMS exam API.
        "exm": bool(info["staff"] or exam_eligible(user)),
        "iat": now,
        "exp": expires,
    }
    return {
        "token": sign_pass(payload, secret),
        "expires_at": datetime.fromtimestamp(expires, tz=dt_timezone.utc).isoformat(),
        "allowed_difficulties": info["allowed_difficulties"],
        "membership_required": info["membership_required"],
        "exam_access": payload["exm"],
    }
