"""The Hall of Fame: automatic entries on certification, curated entries, staff moderation.

Owner rule: public surfaces show the student's HANDLE only, never the real
name or e-mail. The handle is the linked user's live profile handle
(``profiles.StudentProfile``) ONLY when the student chose it themselves
(``handle_auto`` False and not an ``operative_`` handle), else a
``display_handle`` set by staff (legacy entries keep theirs). An entry with
neither is not public: a graduate who still has only the automatic
``operative_xxxxxx`` handle (or no profile) appears automatically once they
choose a handle (``awaiting_handle_queryset`` lists them for staff).

Certificates are private to their holder: cards never link to one.

An entry is public when: not hidden by staff, the student has not opted out
(``CertificationPreferences.hall_of_fame_listed``), its certificate (if any)
is not revoked, and it has a handle.
"""

from __future__ import annotations

import logging
import re

from django.apps import apps as django_apps
from django.db import transaction
from django.db.models import Case, CharField, Count, F, IntegerField, Min, OuterRef, Q, Subquery, Value, When
from django.db.models.functions import Coalesce, NullIf
from django.utils import timezone

from apps.core.errors import ValidationFailed

from .models import HallOfFameAudit, HallOfFameEntry

logger = logging.getLogger("apps.certification.hall_of_fame")

PAGE_SIZE = 48
MAX_PAGE_SIZE = 96
FEATURED = 3
# The academy was founded in 2025: the curated Batch 1 and 2 graduates (seeded
# without a date) were honoured that year, and no honour predates it.
FOUNDING_YEAR = 2025
AUTO_HANDLE_PREFIX = "operative_"  # profiles.handles.AUTO_PREFIX (reserved for automatic handles)
HANDLE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,38}[A-Za-z0-9._-]?$")


def _profile_model():
    try:
        return django_apps.get_model("profiles", "StudentProfile")
    except LookupError:  # profiles app not installed
        return None


def _annotated(queryset):
    profile = _profile_model()
    if profile is None:
        return queryset.annotate(
            profile_handle=Value("", output_field=CharField()), profile_public=Value(0, output_field=IntegerField())
        ).annotate(public_handle=NullIf(F("display_handle"), Value("")))  # pragma: no cover
    profiles = profile.objects.filter(user_id=OuterRef("user_id"))
    chosen = profiles.filter(handle_auto=False).exclude(handle__startswith=AUTO_HANDLE_PREFIX)
    linkable = chosen.filter(
        status=profile.STATUS_ACTIVE, visibility=profile.VISIBILITY_PUBLIC, published_at__isnull=False
    )
    return queryset.annotate(
        profile_handle=Subquery(chosen.values("handle")[:1]),
        profile_public=Coalesce(Subquery(linkable.annotate(one=Value(1, output_field=IntegerField())).values("one")[:1]), 0),
    ).annotate(
        staff_handle=Case(
            When(display_handle__startswith=AUTO_HANDLE_PREFIX, then=Value("")),
            default=F("display_handle"),
            output_field=CharField(),
        )
    ).annotate(public_handle=Coalesce(NullIf(F("profile_handle"), Value("")), NullIf(F("staff_handle"), Value(""))))


def _eligible():
    return (
        HallOfFameEntry.objects.filter(is_hidden=False)
        .exclude(user__certification_preferences__hall_of_fame_listed=False)
        .exclude(certificate__revoked_at__isnull=False)
        .select_related("certificate")
    )


def public_queryset():
    return _annotated(_eligible()).filter(public_handle__isnull=False)


def awaiting_handle_queryset():
    """Graduates who would be on the wall but have no chosen handle yet (only the
    automatic ``operative_`` one, or no profile). Staff ask them to choose one."""
    return (
        _annotated(_eligible())
        .filter(public_handle__isnull=True, user__isnull=False)
        .select_related("user")
        .order_by("-batch_order", "position", "id")
    )


def group_key(entry) -> str:
    if entry.batch_label:
        return entry.batch_label
    if entry.achieved_on:
        return str(entry.achieved_on.year)
    return "Graduates"


def entry_dict(entry) -> dict:
    """Public card. Handle, batch, achievement and date only (certificates are private to their holder)."""
    handle = entry.public_handle
    return {
        "id": entry.pk,
        "handle": handle,
        "profile_url": f"/u/{entry.profile_handle}" if entry.profile_public and entry.profile_handle else None,
        "batch": entry.batch_label or "",
        "group": group_key(entry),
        "achievement": entry.achievement,
        "achieved_on": entry.achieved_on.isoformat() if entry.achieved_on else None,
        "year": entry.achieved_on.year if entry.achieved_on else None,
        "band": entry.band or "",
        "has_certificate": bool(entry.certificate_id),
        "certificate_reference": None,
        "certificate_url": None,
    }


def public_payload(*, page: int = 1, page_size: int = PAGE_SIZE, group: str = "") -> dict:
    base = public_queryset()
    page_size = max(1, min(MAX_PAGE_SIZE, int(page_size or PAGE_SIZE)))
    page = max(1, int(page or 1))
    groups = list(
        base.annotate(
            group_label=Case(
                When(~Q(batch_label=""), then=F("batch_label")),
                default=Value(""),
                output_field=CharField(),
            )
        )
        .values("group_label", "batch_order")
        .annotate(count=Count("id"))
        .order_by("-batch_order", "group_label")
    )
    batches, seen = [], {}
    for row in groups:
        label = row["group_label"] or "Graduates"
        if label in seen:
            seen[label]["count"] += row["count"]
            continue
        seen[label] = {"label": label, "count": row["count"]}
        batches.append(seen[label])
    listing = base.filter(batch_label=group) if group and group != "Graduates" else base
    if group == "Graduates":
        listing = base.filter(batch_label="")
    total = listing.count()
    offset = (page - 1) * page_size
    rows = list(listing.order_by("-batch_order", "position", "achieved_on", "id")[offset:offset + page_size])
    recent = list(base.order_by(F("achieved_on").desc(nulls_last=True), "-batch_order", "position", "id")[:FEATURED])
    top = list(base.filter(percent__isnull=False).order_by("-percent", F("achieved_on").asc(nulls_last=True), "id")[:FEATURED])
    graduates = base.count()
    with_certificate = base.filter(certificate__isnull=False).count()
    first = base.aggregate(first=Min("achieved_on"))["first"]
    years = [first.year] if first else []
    if base.filter(achieved_on__isnull=True).exists():
        years.append(FOUNDING_YEAR)
    since = max(FOUNDING_YEAR, min(years)) if years else None
    return {
        "counters": {
            "graduates": graduates,
            "batches": len(batches),
            "verified_certificates": with_certificate,
            "since": since,
        },
        "featured": {"recent": [entry_dict(e) for e in recent], "top": [entry_dict(e) for e in top]},
        "batches": batches,
        "entries": [entry_dict(e) for e in rows],
        "page": page,
        "page_size": page_size,
        "total": total,
        "has_more": offset + len(rows) < total,
    }


# --- writes ---------------------------------------------------------------------------------------------
def _audit(entry, action, *, actor=None, reason=""):
    HallOfFameAudit.objects.create(
        entry=entry,
        action=action,
        reason=str(reason or "")[:300],
        actor=actor if getattr(actor, "pk", None) else None,
        actor_email=str(getattr(actor, "email", "") or "")[:254],
    )


# "Batch 3", "BATCH III", "(batch iv)", "Batch-2", "Batch #5", "Batch No. 6".
_BATCH_IN_TEXT = re.compile(r"\bbatch\s*(?:no\.?|#|-|:)?\s*(\d{1,4}|[ivxlcdm]{1,12})\b", re.IGNORECASE)
_BARE_BATCH = re.compile(r"^\s*(\d{1,4}|[ivxlcdm]{1,12})\s*$", re.IGNORECASE)
_ROMAN = re.compile(r"^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$")
_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
MAX_BATCH_NUMBER = 999


def _number(token: str) -> int | None:
    """An Arabic or (strictly formed) Roman batch number, 1-999; else None."""
    token = (token or "").strip().upper()
    if token.isdigit():
        value = int(token)
    elif token and _ROMAN.match(token):
        value, previous = 0, 0
        for char in reversed(token):
            digit = _ROMAN_VALUES[char]
            value = value - digit if digit < previous else value + digit
            previous = max(previous, digit)
    else:
        return None
    return value if 0 < value <= MAX_BATCH_NUMBER else None


def batch_number(text: str, *, bare: bool = False) -> int | None:
    """The batch number named in ``text``: "OSINT ... (BATCH III)" -> 3, "Batch 4" -> 4.

    ``bare`` also accepts a lone number or numeral ("3", "III"), as written in a
    course's ``batch`` field. Never guesses from other numbers ("January 2027").
    """
    text = str(text or "")
    match = _BATCH_IN_TEXT.search(text) or (_BARE_BATCH.match(text) if bare else None)
    return _number(match.group(1)) if match else None


def _batch_course(decision):
    participation = getattr(decision, "participation", None)
    return getattr(participation, "batch_course", None) if participation is not None else None


def batch_identity(decision, batch_label: str = "") -> tuple[str, int | None]:
    """(wall label, batch number) for an automatic entry.

    A batch number found in the given label, the batch course's ``batch`` field
    or its title gives "Batch N" (so "BATCH III" and "Batch 3" share one group).
    Otherwise the given label, else the course title, with no number.
    """
    course = _batch_course(decision)
    course_batch = str(getattr(course, "batch", "") or "").strip()
    course_title = " ".join(str(getattr(course, "title", "") or "").split())
    label = " ".join(str(batch_label or "").split())
    for text, bare in ((label, True), (course_batch, True), (course_title, False)):
        number = batch_number(text, bare=bare)
        if number:
            return f"Batch {number}", number
    return (label or course_batch or course_title)[:80], None


def add_for_decision(decision, *, batch_label: str, achievement: str):
    """The automatic entry for a passing decision (idempotent: one per certificate)."""
    certificate = decision.certificate
    existing = HallOfFameEntry.objects.filter(Q(decision=decision) | Q(certificate=certificate)).first()
    if existing is not None:
        return existing
    batch_label, number = batch_identity(decision, batch_label)
    achieved_on = timezone.localdate(certificate.issued_at) if certificate else timezone.localdate()
    # Merge: a curated entry already mapped to this student in this batch, without a certificate.
    curated = (
        HallOfFameEntry.objects.select_for_update()
        .filter(source=HallOfFameEntry.SOURCE_MANUAL, user_id=decision.user_id, certificate__isnull=True)
        .filter(Q(batch_label=batch_label) | Q(batch_label=""))
        .first()
    )
    if curated is not None:
        curated.certificate = certificate
        curated.decision = decision
        curated.achieved_on = curated.achieved_on or achieved_on
        curated.band = decision.band
        curated.percent = decision.percent
        if not curated.batch_label and batch_label:
            curated.batch_label = batch_label
            curated.batch_order = number or curated.batch_order or achieved_on.year
        curated.save()
        _audit(curated, HallOfFameAudit.ACTION_MERGED, reason="Certification passed")
        return curated
    entry = HallOfFameEntry.objects.create(
        user_id=decision.user_id,
        batch_label=batch_label[:80],
        batch_order=number or achieved_on.year,  # no batch number: newest first, by year
        achievement=achievement[:160],
        achieved_on=achieved_on,
        band=decision.band,
        percent=decision.percent,
        certificate=certificate,
        decision=decision,
        source=HallOfFameEntry.SOURCE_AUTO,
    )
    _audit(entry, HallOfFameAudit.ACTION_ADDED, reason="Certification passed")
    return entry


def _reason(reason) -> str:
    text = " ".join(str(reason or "").split())
    if len(text) < 3:
        raise ValidationFailed(details={"reason": ["Give a short reason (at least 3 characters)."]})
    return text[:300]


def set_hidden(entry, *, hidden: bool, actor, reason) -> HallOfFameEntry:
    reason = _reason(reason)
    with transaction.atomic():
        row = HallOfFameEntry.objects.select_for_update().get(pk=entry.pk)
        if row.is_hidden == hidden:
            raise ValidationFailed(details={"entry": ["Already hidden." if hidden else "Not hidden."]})
        row.is_hidden = hidden
        row.hidden_reason = reason if hidden else ""
        row.hidden_at = timezone.now() if hidden else None
        row.hidden_by = actor if (hidden and getattr(actor, "pk", None)) else None
        row.save(update_fields=["is_hidden", "hidden_reason", "hidden_at", "hidden_by", "updated_at"])
        _audit(row, HallOfFameAudit.ACTION_HIDDEN if hidden else HallOfFameAudit.ACTION_RESTORED, actor=actor, reason=reason)
    return row


def validate_handle(value) -> str:
    text = " ".join(str(value or "").split()).lstrip("@")
    if not text or len(text) > 40 or not HANDLE_RE.match(text):
        raise ValidationFailed(details={"display_handle": ["Use 1-40 letters, digits, spaces, dots, dashes or underscores."]})
    return text


def set_display_handle(entry, *, handle, actor, reason="") -> HallOfFameEntry:
    handle = validate_handle(handle)
    with transaction.atomic():
        row = HallOfFameEntry.objects.select_for_update().get(pk=entry.pk)
        row.display_handle = handle
        row.save(update_fields=["display_handle", "updated_at"])
        _audit(row, HallOfFameAudit.ACTION_HANDLE_SET, actor=actor, reason=(reason or f"Handle set to {handle}")[:300])
    return row
