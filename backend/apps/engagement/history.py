"""Reward history for the profile tabs and the student's highlighted rewards.

``GET /api/engagement/me/history/`` (the XP ledger, badges, batches and the
caller's own certificates) and ``PATCH /api/engagement/me/highlights/`` (up to
``RewardHighlight.MAX`` badges/certificates featured on the public profile).

Public surfaces (``public_highlights``) show the handle's chosen highlights
only: badge facts, and a certificate as a plain "Certified ..." badge with no
reference, no link and never the real name (certificates are private).
These work whatever the ``engagement`` switch says (history is the student's
own record); with the switch off the XP list is simply what the ledger holds.
"""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone

from apps.core.errors import ValidationFailed

from . import badges as badge_catalogue
from . import certificates, rules
from .models import BadgeAward, Certificate, EngagementSummary, RewardHighlight, XpEvent

DEFAULT_PAGE_SIZE = 25
MAX_PAGE_SIZE = 100
KIND_LABELS = dict(rules.KIND_CHOICES)


def certificate_badge_title(certificate: Certificate) -> str:
    """The badge-style name a certificate shows as (no name, no reference)."""
    if certificate.cert_type == Certificate.TYPE_OSINT:
        return "Certified OSINT Investigator"
    if certificate.cert_type == Certificate.TYPE_PEN:
        return "Certified Penetration Tester"
    label = certificates.TYPE_LABELS.get(certificate.cert_type, "")
    return f"Certified: {label}" if label else "Certified"


def _issued_on(certificate: Certificate) -> str:
    return timezone.localtime(certificate.issued_at, rules.IST).date().isoformat()


def _badge_dict(key: str, earned_at) -> dict | None:
    badge = badge_catalogue.get(key)
    if badge is None:
        return None
    return {**badge.as_dict(), "earned_at": earned_at.isoformat() if earned_at else None}


def _held_badges(user_id: int) -> dict:
    return dict(BadgeAward.objects.filter(user_id=user_id, revoked_at__isnull=True).values_list("badge_key", "awarded_at"))


def _own_certificates(user_id: int):
    return list(
        Certificate.objects.filter(user_id=user_id, reference__isnull=False)
        .select_related("achievement", "ctf_reward")
        .order_by("-issued_at", "-id")[:200]
    )


def _highlight_keys(user_id: int) -> dict[str, list[str]]:
    keys = {RewardHighlight.KIND_BADGE: [], RewardHighlight.KIND_CERTIFICATE: []}
    for kind, key in RewardHighlight.objects.filter(user_id=user_id).order_by("position", "id").values_list("kind", "key"):
        keys.setdefault(kind, []).append(key)
    return keys


def highlights_dict(user_id: int) -> dict:
    keys = _highlight_keys(user_id)
    return {
        "badges": keys[RewardHighlight.KIND_BADGE],
        "certificates": keys[RewardHighlight.KIND_CERTIFICATE],
        "max": RewardHighlight.MAX,
    }


def _xp_page(user_id: int, page: int, page_size: int) -> dict:
    queryset = XpEvent.objects.filter(user_id=user_id).order_by("-occurred_at", "-id")
    total = queryset.count()
    start = (page - 1) * page_size
    rows = list(queryset[start : start + page_size])
    items = []
    for event in rows:
        label = KIND_LABELS.get(event.kind, event.kind.replace("_", " ").capitalize())
        items.append(
            {
                "id": event.pk,
                "date": event.occurred_at.isoformat(),
                "day": timezone.localtime(event.occurred_at, rules.IST).date().isoformat(),
                "source": event.kind,
                "source_label": label,
                "amount": event.points,
                "description": label,
            }
        )
    return {"items": items, "page": page, "page_size": page_size, "total": total, "has_more": start + len(rows) < total}


def _enrollment_status(enrollment, now) -> str:
    if enrollment.payment_status == enrollment.STATUS_PAID:
        return "active" if enrollment.has_active_access(now) else "expired"
    return enrollment.payment_status  # pending | failed


def _batches(user_id: int) -> list[dict]:
    from apps.courses.models import Enrollment

    now = timezone.now()
    rows = Enrollment.objects.filter(user_id=user_id).select_related("course").order_by("-enrolled_at", "-id")[:100]
    return [
        {
            "enrollment_id": row.pk,
            "course_id": row.course_id,
            "course_title": row.course.title,
            "course_slug": row.course.slug or "",
            "batch": row.course.batch or "",
            "status": _enrollment_status(row, now),
            "payment_status": row.payment_status,
            "access_type": row.access_type,
            "enrolled_at": row.enrolled_at.isoformat() if row.enrolled_at else None,
            "start_date": row.course.start_date.isoformat() if row.course.start_date else None,
            "access_expires_at": row.access_expires_at.isoformat() if row.access_expires_at else None,
        }
        for row in rows
    ]


def history_payload(user, *, page: int = 1, page_size: int = DEFAULT_PAGE_SIZE) -> dict:
    from apps.core.features import is_enabled

    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
    keys = _highlight_keys(user.pk)
    badge_keys = set(keys[RewardHighlight.KIND_BADGE])
    cert_keys = set(keys[RewardHighlight.KIND_CERTIFICATE])
    held = _held_badges(user.pk)
    badges = []
    for key, earned_at in sorted(held.items(), key=lambda item: item[1], reverse=True):
        row = _badge_dict(key, earned_at)
        if row is not None:
            badges.append({**row, "highlighted": key in badge_keys})
    certs = [
        {
            "reference": certificate.reference,
            "type": certificate.cert_type,
            "type_label": certificates.TYPE_LABELS.get(certificate.cert_type, ""),
            "title": certificate_badge_title(certificate),
            "issued_at": certificate.issued_at.isoformat(),
            "issued_on": _issued_on(certificate),
            "valid": certificate.is_valid,
            "highlighted": certificate.reference in cert_keys and certificate.is_valid,
            "url": f"/certificates/{certificate.reference}",
        }
        for certificate in _own_certificates(user.pk)
    ]
    summary = EngagementSummary.objects.filter(user_id=user.pk).first()
    return {
        "summary": {
            "total_xp": int(summary.total_xp) if summary else 0,
            "level": int(summary.level) if summary else 1,
            "badges_count": len(badges),
            "current_streak": int(summary.current_streak) if summary else 0,
            "best_streak": int(summary.best_streak) if summary else 0,
        },
        "xp": _xp_page(user.pk, page, page_size),
        "badges": badges,
        "batches": _batches(user.pk),
        "certificates": certs,
        "highlights": {"badges": keys[RewardHighlight.KIND_BADGE], "certificates": keys[RewardHighlight.KIND_CERTIFICATE],
                       "max": RewardHighlight.MAX},
        "engagement_enabled": bool(is_enabled(rules.FEATURE_KEY)),
    }


def _clean_list(value, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise ValidationFailed(details={field: ["Send a list."]})
    cleaned: list[str] = []
    for item in value:
        text = str(item or "").strip()[:64]
        if not text:
            raise ValidationFailed(details={field: ["Items must be non-empty strings."]})
        if text not in cleaned:
            cleaned.append(text)
    return cleaned


def _canonical_ref(text: str) -> str:
    try:
        return certificates.parse_reference(text)
    except certificates.BadReference:
        return text


def set_highlights(user, data) -> dict:
    """Replace the lists that were sent; at most ``RewardHighlight.MAX`` items in total."""
    if not isinstance(data, dict):
        raise ValidationFailed(details={"highlights": ["Send an object with badges and/or certificates."]})
    current = _highlight_keys(user.pk)
    badge_list = (
        _clean_list(data.get("badges"), "badges") if "badges" in data else current[RewardHighlight.KIND_BADGE]
    )
    cert_list = (
        [_canonical_ref(ref) for ref in _clean_list(data.get("certificates"), "certificates")]
        if "certificates" in data
        else current[RewardHighlight.KIND_CERTIFICATE]
    )
    if len(badge_list) + len(cert_list) > RewardHighlight.MAX:
        raise ValidationFailed(details={"highlights": [f"Highlight at most {RewardHighlight.MAX} items."]})
    held = _held_badges(user.pk)
    missing_badges = [key for key in badge_list if key not in held or badge_catalogue.get(key) is None]
    if missing_badges:
        raise ValidationFailed(details={"badges": [f"You do not hold: {', '.join(missing_badges)}."]})
    owned = {certificate.reference: certificate for certificate in _own_certificates(user.pk)}
    bad_certs = [ref for ref in cert_list if ref not in owned or not owned[ref].is_valid]
    if bad_certs:
        raise ValidationFailed(details={"certificates": [f"Not a valid certificate of yours: {', '.join(bad_certs)}."]})
    with transaction.atomic():
        RewardHighlight.objects.filter(user_id=user.pk).delete()
        position = 0
        rows = []
        for kind, keys in ((RewardHighlight.KIND_BADGE, badge_list), (RewardHighlight.KIND_CERTIFICATE, cert_list)):
            for key in keys:
                rows.append(RewardHighlight(user_id=user.pk, kind=kind, key=key, position=position))
                position += 1
        RewardHighlight.objects.bulk_create(rows)
    return highlights_dict(user.pk)


def public_highlights(user_id: int) -> list[dict]:
    """What a public profile shows: badge facts and certificate badges (no reference, no link, no name).

    Items that stopped being valid (badge revoked, certificate revoked) are skipped.
    """
    rows = list(RewardHighlight.objects.filter(user_id=user_id).order_by("position", "id")[: RewardHighlight.MAX])
    if not rows:
        return []
    held = _held_badges(user_id)
    refs = [row.key for row in rows if row.kind == RewardHighlight.KIND_CERTIFICATE]
    certs = {
        certificate.reference: certificate
        for certificate in Certificate.objects.filter(user_id=user_id, reference__in=refs).select_related("achievement", "ctf_reward")
    }
    items: list[dict] = []
    for row in rows:
        if row.kind == RewardHighlight.KIND_BADGE:
            if row.key not in held:
                continue
            badge = _badge_dict(row.key, held[row.key])
            if badge is not None:
                items.append({"kind": "badge", **{k: badge[k] for k in ("key", "title", "tier", "earned_at")}})
        else:
            certificate = certs.get(row.key)
            if certificate is None or not certificate.is_valid:
                continue
            items.append(
                {
                    "kind": "certificate",
                    "title": certificate_badge_title(certificate),
                    "type": certificate.cert_type,
                    "issued_on": _issued_on(certificate),
                }
            )
    return items
