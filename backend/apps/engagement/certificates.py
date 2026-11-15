"""Verifiable certificates: reference numbers, issuing, corrections, public payloads.

Reference number
    ``ASI-<YYYY>-<TYPE>-<NNNNNN>-<C>``, e.g. ``ASI-2026-OSINT-000042-7``.

    * ``YYYY``: the issue year (IST).
    * ``TYPE``: OSINT, PEN, COURSE, EXAM, CTF, BADGE or LEVEL.
    * ``NNNNNN``: the certificate's primary key, zero-padded to six digits
      (it grows to more digits after 999,999). The database hands it out from
      a sequence, so two concurrent issues can never get the same number and
      a committed number is never reused (certificates cannot be deleted).
    * ``C``: a Luhn mod 36 check character over ``ASI``, year, type and
      sequence (alphabet ``0-9A-Z``). It catches every single-character typo
      and almost every swap of two neighbouring characters.

Unification
    The courses app does not issue certificates; course completion is the
    engagement ``Achievement`` of kind ``course``. Every ``Achievement`` (course
    completed, badge earned, level reached) gets exactly one ``Certificate``
    (one-to-one), issued in the awarding transaction or, for rows created
    before this module existed, on first use (``ensure_for_achievement``).

Name
    The holder's real name from the account (``User.full_name``), never the
    public profile handle. It is copied onto the certificate when issued.
    Staff can correct it (``correct_name``): the revision is bumped, the
    reference stays, and a ``CertificateRevision`` row records who, when, why,
    and the before/after values.

Validity
    A certificate is valid unless it, or the achievement it certifies, is
    revoked. Verification never depends on the ``engagement`` switch.
"""

from __future__ import annotations

import logging
import random
import re
import time
import unicodedata
from datetime import datetime
from functools import lru_cache
from urllib.parse import quote, urlencode

from django.conf import settings
from django.db import IntegrityError, OperationalError, connection, transaction
from django.urls import reverse
from django.utils import timezone

from apps.core.errors import NotFound, ValidationFailed

from . import badges as badge_catalogue
from . import rules
from .models import Achievement, Certificate, CertificateRevision

logger = logging.getLogger("apps.engagement.certificates")

PREFIX = "ASI"
ISSUER_NAME = "Al Syed Initiative"
SIGNATORY = "Al Syed Initiative"
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_INDEX = {char: index for index, char in enumerate(ALPHABET)}
TYPES = frozenset(code for code, _label in Certificate.TYPE_CHOICES)
TYPE_LABELS = dict(Certificate.TYPE_CHOICES)
SEQUENCE_DIGITS = 6
EXAM_BADGES = frozenset({"first_exam", "exam_ace", "batch_top_3"})
# Release-day legacy certificates (apps.engagement.legacy): their own wording.
LEGACY_WORDING = {
    "founding_member": ("Certificate of Founding Membership", "is recognised as a founding student, with the distinction"),
    "founding_graduate": ("Founding Graduate Certificate", "was certified before the platform launch, with the distinction"),
}
NAME_MAX = 160

# Digits typed as look-alike letters in the numeric parts are read as digits.
_DIGIT_LOOKALIKES = str.maketrans({"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2", "S": "5", "B": "8"})
_REFERENCE_RE = re.compile(r"^ASI-?([0-9OQDILZSB]{4})-?([A-Z]{2,8})-?([0-9OQDILZSB]{6,12})-?([0-9A-Z])$")


# --- reference numbers --------------------------------------------------------------------------------
def check_character(body: str) -> str:
    """Luhn mod 36 check character for ``body`` (characters of ``0-9A-Z``; anything else is ignored)."""
    base = len(ALPHABET)
    factor = 2
    total = 0
    for char in reversed([c for c in body.upper() if c in _INDEX]):
        addend = factor * _INDEX[char]
        factor = 1 if factor == 2 else 2
        total += addend // base + addend % base
    return ALPHABET[(base - total % base) % base]


def _check_ok(body_and_check: str) -> bool:
    base = len(ALPHABET)
    factor = 1
    total = 0
    for char in reversed([c for c in body_and_check.upper() if c in _INDEX]):
        addend = factor * _INDEX[char]
        factor = 1 if factor == 2 else 2
        total += addend // base + addend % base
    return total % base == 0


def format_reference(year: int, cert_type: str, sequence: int) -> str:
    if cert_type not in TYPES:
        raise ValueError(f"Unknown certificate type {cert_type!r}.")
    if not 1000 <= int(year) <= 9999 or int(sequence) < 1:
        raise ValueError("Bad year or sequence.")
    body = f"{PREFIX}-{int(year):04d}-{cert_type}-{int(sequence):0{SEQUENCE_DIGITS}d}"
    return f"{body}-{check_character(body)}"


class BadReference(ValueError):
    """``code`` is ``format`` (not a reference) or ``check`` (a typo: the check character does not match)."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def parse_reference(text: str) -> str:
    """The canonical reference for ``text`` (case, spaces and dashes forgiven), or ``BadReference``."""
    raw = unicodedata.normalize("NFKC", str(text or "")).upper()
    raw = re.sub(r"[\s_.‐-―]+", "-", raw.strip()).strip("-")
    raw = re.sub(r"-{2,}", "-", raw)
    match = _REFERENCE_RE.match(raw) if len(raw) <= 40 else None
    if match is None:
        raise BadReference("format")
    year, cert_type, sequence, check = match.groups()
    year = year.translate(_DIGIT_LOOKALIKES)
    sequence = sequence.translate(_DIGIT_LOOKALIKES)
    if cert_type not in TYPES or int(sequence) < 1:
        raise BadReference("format")
    body = f"{PREFIX}-{year}-{cert_type}-{int(sequence):0{SEQUENCE_DIGITS}d}"
    if not _check_ok(body + check):
        raise BadReference("check")
    return f"{body}-{check}"


def is_valid_reference(text: str) -> bool:
    try:
        return parse_reference(text) == str(text)
    except BadReference:
        return False


def looks_like_reference(text: str) -> bool:
    return str(text or "").strip().upper().startswith(PREFIX)


# --- what a certificate says ----------------------------------------------------------------------------
def clean_name(value) -> str:
    text = unicodedata.normalize("NFC", str(value or ""))
    text = "".join(char for char in text if unicodedata.category(char)[0] != "C")
    return " ".join(text.split())[:NAME_MAX]


def real_name(user) -> str:
    """The account's full name (never the profile handle, never the e-mail)."""
    return clean_name(getattr(user, "full_name", "") if user is not None else "")


def _course_facts(course_id) -> tuple[str, str]:
    """``(type, programme line)`` for a course id."""
    from apps.courses.models import Course

    try:
        course = Course.objects.filter(pk=int(course_id)).only("id", "title", "batch", "category").first()
    except (TypeError, ValueError):
        course = None
    if course is None:
        return Certificate.TYPE_COURSE, "Professional training programme"
    cert_type = {
        Course.CATEGORY_OSINT: Certificate.TYPE_OSINT,
        Course.CATEGORY_WEB_PENTESTING: Certificate.TYPE_PEN,
    }.get(course.category, Certificate.TYPE_COURSE)
    programme = f"{TYPE_LABELS[cert_type]} programme"
    if course.batch:
        programme += f" · Batch {course.batch}"
    return cert_type, programme


def facts_for_achievement(achievement: Achievement) -> dict:
    """Type and printed wording for an achievement (snapshotted onto the certificate)."""
    if achievement.kind == Achievement.KIND_COURSE:
        cert_type, programme = _course_facts(achievement.key)
        return {
            "cert_type": cert_type,
            "heading": "Certificate of Completion",
            "statement": "has successfully completed the course",
            "title": (achievement.subtitle or achievement.title or "Course")[:200],
            "programme": programme[:220],
        }
    if achievement.kind == Achievement.KIND_BADGE and achievement.key in LEGACY_WORDING:
        heading, statement = LEGACY_WORDING[achievement.key]
        badge = badge_catalogue.get(achievement.key)
        return {
            "cert_type": Certificate.TYPE_BADGE,
            "heading": heading,
            "statement": statement,
            "title": (badge.title if badge else achievement.title)[:200],
            "programme": ((badge.description if badge else achievement.subtitle) or "")[:220],
        }
    if achievement.kind == Achievement.KIND_BADGE:
        badge = badge_catalogue.get(achievement.key)
        return {
            "cert_type": Certificate.TYPE_EXAM if achievement.key in EXAM_BADGES else Certificate.TYPE_BADGE,
            "heading": "Certificate of Achievement",
            "statement": "has earned the distinction",
            "title": (badge.title if badge else achievement.title)[:200],
            "programme": ((badge.description if badge else achievement.subtitle) or "")[:220],
        }
    level = next((item for item in rules.LEVELS if item.key == achievement.key), None)
    return {
        "cert_type": Certificate.TYPE_LEVEL,
        "heading": "Certificate of Achievement",
        "statement": "has attained the rank of",
        "title": (level.title if level else achievement.title)[:200],
        "programme": (achievement.subtitle or "")[:220],
    }


# --- issuing --------------------------------------------------------------------------------------------
def _is_lock_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "locked" in text or "deadlock" in text or "could not serialize" in text


def _issue_year(issued_at: datetime) -> int:
    return timezone.localtime(issued_at, rules.IST).year


def _create(*, user_id: int, issued_at, name: str, facts: dict, link: dict) -> Certificate:
    certificate = Certificate.objects.create(user_id=user_id, recipient_name=name, issued_at=issued_at, **link, **facts)
    certificate.reference = format_reference(_issue_year(issued_at), certificate.cert_type, certificate.pk)
    Certificate.objects.filter(pk=certificate.pk).update(reference=certificate.reference)
    CertificateRevision.objects.create(
        certificate=certificate, revision=1, action=CertificateRevision.ACTION_ISSUE, name_after=name
    )
    return certificate


def _ensure(link: dict, build, *, attempts: int = 10) -> Certificate:
    """The certificate for ``link`` (one source object), issuing it once (idempotent, race-safe).

    ``build()`` returns ``(user_id, issued_at, name, facts)``. Two concurrent
    callers both try to insert; the one-to-one constraint lets exactly one in
    and the other reads the winner's row on its next attempt. Outside a
    transaction a transient lock error (SQLite under concurrent writers; a
    PostgreSQL deadlock or serialization failure) is retried.
    """
    retry_locks = not connection.in_atomic_block
    built = None
    for attempt in range(max(1, attempts)):
        last = attempt + 1 >= attempts
        try:
            existing = Certificate.objects.filter(**{f"{key}_id": value.pk for key, value in link.items()}).first()
            if existing is not None:
                return existing
            if built is None:
                built = build()
            user_id, issued_at, name, facts = built
            with transaction.atomic():
                return _create(user_id=user_id, issued_at=issued_at, name=name, facts=facts, link=link)
        except IntegrityError:
            if last:
                raise
            # Another caller won the one-to-one race: the next attempt reads its row.
        except OperationalError as exc:
            if not (retry_locks and _is_lock_error(exc)) or last:
                raise
            time.sleep(0.01 * (attempt + 1) + random.random() * 0.02)
    raise RuntimeError("unreachable")  # pragma: no cover


def _user(user_id):
    from django.contrib.auth import get_user_model

    return get_user_model().objects.filter(pk=user_id).only("id", "full_name").first()


def ensure_for_achievement(achievement: Achievement, *, user=None, attempts: int = 10) -> Certificate:
    """The achievement's certificate, issuing it once (idempotent and race-safe)."""

    def build():
        holder = user if user is not None else _user(achievement.user_id)
        name = real_name(holder) or clean_name(achievement.recipient_name)
        return achievement.user_id, achievement.earned_at or timezone.now(), name, facts_for_achievement(achievement)

    return _ensure({"achievement": achievement}, build, attempts=attempts)


# --- Monthly CTF finalist certificates -------------------------------------------------------------------
def _ordinal(number: int) -> str:
    suffix = "th" if 10 <= number % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return f"{number}{suffix}"


def facts_for_ctf_reward(reward) -> dict:
    """Wording for a Monthly CTF finalist certificate (champion, podium or top ten)."""
    season = reward.season
    rank = int(reward.rank or 0)
    if rank == 1:
        heading, statement = "Certificate of Excellence", "won first place in"
    elif rank in (2, 3):
        heading, statement = "Certificate of Excellence", f"placed {_ordinal(rank)} in"
    else:
        heading, statement = "Certificate of Achievement", "finished as a top-ten finalist in"
    month = getattr(season, "month_label", "") or ""
    programme = "Monthly OSINT CTF" + (f" · {month}" if month else "") + (f" · Final rank {rank}" if rank else "")
    return {
        "cert_type": Certificate.TYPE_CTF,
        "heading": heading,
        "statement": statement,
        "title": (season.title or "Monthly OSINT CTF")[:200],
        "programme": programme[:220],
    }


def _ctf_certificate_rewards():
    from apps.ctf.season_models import CtfSeasonReward

    return CtfSeasonReward.objects.filter(kind=CtfSeasonReward.KIND_CERTIFICATE).select_related("season")


def ensure_for_ctf_reward(reward, *, attempts: int = 10) -> Certificate:
    """The certificate for a Monthly CTF reward of kind ``certificate`` (idempotent, race-safe)."""

    def build():
        name = real_name(_user(reward.user_id))
        return reward.user_id, reward.starts_at or timezone.now(), name, facts_for_ctf_reward(reward)

    return _ensure({"ctf_reward": reward}, build, attempts=attempts)


def issue_for_ctf_season(season_id: int) -> int:
    """Certify every finalist certificate of a finalised season. Safe to repeat."""
    issued = 0
    for reward in _ctf_certificate_rewards().filter(season_id=season_id, engagement_certificate__isnull=True):
        ensure_for_ctf_reward(reward)
        issued += 1
    return issued


def issue_for_new_achievements(user_id: int, keys) -> int:
    """Issue certificates for achievements just created in the awarding transaction.

    Runs inside that transaction under a savepoint: a failure is logged and
    rolled back alone (the award stands; the certificate is issued on first use).
    """
    keys = {(kind, str(key)) for kind, key in keys}
    if not keys:
        return 0
    issued = 0
    try:
        with transaction.atomic():
            rows = [
                row
                for row in Achievement.objects.filter(user_id=user_id, kind__in={kind for kind, _ in keys}, certificate__isnull=True)
                if (row.kind, row.key) in keys
            ]
            if not rows:
                return 0
            user = _user(user_id)
            for row in rows:
                ensure_for_achievement(row, user=user)
                issued += 1
    except Exception:  # noqa: BLE001 - never break an award over a certificate
        logger.warning("engagement.certificate_issue_failed user=%s", user_id, exc_info=True)
        return 0
    return issued


# --- lookups --------------------------------------------------------------------------------------------
def _queryset():
    return Certificate.objects.select_related("achievement", "ctf_reward")


def by_reference(reference: str) -> Certificate | None:
    return _queryset().filter(reference=reference).first()


def resolve(identifier: str) -> tuple[Certificate, bool]:
    """``(certificate, canonical)`` for a reference number (any spelling) or an achievement slug.

    ``canonical`` is False when ``identifier`` is not the canonical reference
    (the caller redirects). Raises ``ValidationFailed`` for a reference with a
    typo and ``NotFound`` for an unknown one.
    """
    identifier = str(identifier or "").strip()[:64]
    if looks_like_reference(identifier):
        try:
            reference = parse_reference(identifier)
        except BadReference as exc:
            if exc.code == "check":
                raise ValidationFailed(
                    "This reference number has a typo: its last character does not match. Check it and try again.",
                    code="certificate_reference_typo",
                    details={"reference": ["The check character does not match."]},
                ) from None
            raise ValidationFailed(
                "That is not a certificate reference number. It looks like ASI-2026-OSINT-000123-X.",
                code="certificate_reference_invalid",
                details={"reference": ["Not a reference number."]},
            ) from None
        certificate = by_reference(reference)
        if certificate is None:
            raise NotFound("No certificate has this reference number.", code="certificate_not_found")
        return certificate, reference == identifier
    slug = identifier[:32]
    achievement = Achievement.objects.filter(slug=slug).first() if slug else None
    if achievement is not None:
        return ensure_for_achievement(achievement), False
    reward = _ctf_certificate_rewards().filter(verify_slug=slug).first() if slug else None
    if reward is not None:  # an older Monthly CTF certificate link
        return ensure_for_ctf_reward(reward), False
    raise NotFound("No certificate has this reference number.", code="certificate_not_found")


# --- staff actions (audited) --------------------------------------------------------------------------
def _reason(reason) -> str:
    text = " ".join(str(reason or "").split())
    if len(text) < 3:
        raise ValidationFailed(details={"reason": ["Give a short reason (at least 3 characters)."]})
    return text[:300]


def _audit_line(action: str, certificate: Certificate, request=None) -> None:
    try:
        from config.audit import log_security_event

        log_security_event(
            f"engagement.certificate_{action}", request, reference=certificate.reference, target_user_id=certificate.user_id
        )
    except Exception:  # noqa: BLE001 - logging only
        logger.debug("certificate audit log line failed", exc_info=True)


def _record(certificate, *, action, actor, reason, request, name_before="", name_after=""):
    CertificateRevision.objects.create(
        certificate=certificate,
        revision=certificate.revision,
        action=action,
        name_before=name_before,
        name_after=name_after,
        reason=reason,
        actor=actor if getattr(actor, "pk", None) else None,
        actor_email=str(getattr(actor, "email", "") or "")[:254],
        request_id=str(getattr(request, "request_id", "") or "")[:64] if request is not None else "",
    )
    _audit_line(action, certificate, request)


def validate_name(value) -> str:
    name = clean_name(value)
    if len(name) < 2:
        raise ValidationFailed(details={"recipient_name": ["Enter the holder's full name."]})
    if any(char in name for char in "<>{}[]\\|@"):
        raise ValidationFailed(details={"recipient_name": ["Use letters, spaces and ordinary punctuation only."]})
    return name


def correct_name(certificate: Certificate, *, recipient_name: str, actor, reason: str, request=None) -> Certificate:
    """Re-issue with a corrected name: same reference, revision + 1, audited."""
    name = validate_name(recipient_name)
    reason = _reason(reason)
    with transaction.atomic():
        row = Certificate.objects.select_for_update().get(pk=certificate.pk)
        if row.recipient_name == name:
            raise ValidationFailed(details={"recipient_name": ["The certificate already shows this name."]})
        before = row.recipient_name
        row.recipient_name = name
        row.revision += 1
        row.save(update_fields=["recipient_name", "revision", "updated_at"])
        _record(row, action=CertificateRevision.ACTION_CORRECT_NAME, actor=actor, reason=reason, request=request,
                name_before=before, name_after=name)
    return row


def revoke(certificate: Certificate, *, actor, reason: str, request=None) -> Certificate:
    reason = _reason(reason)
    with transaction.atomic():
        row = Certificate.objects.select_for_update().get(pk=certificate.pk)
        if row.revoked_at is not None:
            raise ValidationFailed(details={"reference": ["This certificate is already revoked."]})
        row.revoked_at = timezone.now()
        row.revoked_reason = reason
        row.save(update_fields=["revoked_at", "revoked_reason", "updated_at"])
        _record(row, action=CertificateRevision.ACTION_REVOKE, actor=actor, reason=reason, request=request)
    return row


def reinstate(certificate: Certificate, *, actor, reason: str, request=None) -> Certificate:
    reason = _reason(reason)
    with transaction.atomic():
        row = Certificate.objects.select_for_update().get(pk=certificate.pk)
        if row.revoked_at is None:
            raise ValidationFailed(details={"reference": ["This certificate is not revoked."]})
        row.revoked_at = None
        row.revoked_reason = ""
        row.save(update_fields=["revoked_at", "revoked_reason", "updated_at"])
        _record(row, action=CertificateRevision.ACTION_REINSTATE, actor=actor, reason=reason, request=request)
    return row


# --- URLs and payloads ------------------------------------------------------------------------------------
PRODUCTION_ORIGIN = "https://alsyedinitiative.com"


def is_production() -> bool:
    return str(getattr(settings, "APP_ENV", "") or "").strip().lower() in {"production", "prod"}


def public_origin() -> str:
    """The origin printed on certificates and in their QR codes: ``FRONTEND_PUBLIC_ORIGIN``.

    Production must set ``FRONTEND_PUBLIC_ORIGIN=https://alsyedinitiative.com``
    (deploy check ``engagement.I001``). If it is missing there, the public site
    is used rather than an internal address, because a printed PDF is permanent.
    Outside production ``FRONTEND_URL`` is the fallback (local development).
    """
    origin = str(getattr(settings, "FRONTEND_PUBLIC_ORIGIN", "") or "").strip().rstrip("/")
    if origin:
        return origin
    if is_production():
        return PRODUCTION_ORIGIN
    return str(getattr(settings, "FRONTEND_URL", "") or "").strip().rstrip("/")


def public_url(reference: str) -> str:
    """The page that shows the certificate: ``<origin>/certificates/<reference>``."""
    return f"{public_origin()}/certificates/{reference}"


def short_url(reference: str) -> str:
    """The verification address printed on the certificate (no scheme)."""
    return re.sub(r"^https?://", "", public_url(reference))


def linkedin_add_url(certificate: Certificate) -> str:
    """LinkedIn "Add to profile" (Licenses & certifications) with the certification URL and ID."""
    issued = timezone.localtime(certificate.issued_at, rules.IST)
    params = {
        "startTask": "CERTIFICATION_NAME",
        "name": f"{certificate.title} ({certificate.heading})"[:200],
        "organizationName": ISSUER_NAME,
        "issueYear": issued.year,
        "issueMonth": issued.month,
        "certUrl": public_url(certificate.reference),
        "certId": certificate.reference,
    }
    return "https://www.linkedin.com/profile/add?" + urlencode(params, quote_via=quote)


def render_version(certificate: Certificate) -> str:
    """Changes whenever what is printed changes (name, revision, validity, QR availability)."""
    return f"{certificate.revision}{'v' if certificate.is_valid else 'r'}{'q' if qr_available() else ''}"


# --- QR code (segno, pure Python) -------------------------------------------------------------------------
QR_QUIET_ZONE = 2  # modules; the layout's paper square adds the rest of the margin


def qr_available() -> bool:
    try:
        import segno  # noqa: F401
    except ImportError:
        return False
    return True


@lru_cache(maxsize=512)
def _qr_rows(url: str) -> tuple[tuple[int, ...], ...] | None:
    try:
        import segno
    except ImportError:
        logger.warning("engagement.certificate_qr_unavailable: segno is not installed; certificates print the address only")
        return None
    code = segno.make(url, error="m", micro=False)
    return tuple(tuple(1 if module else 0 for module in row) for row in code.matrix)


def qr_matrix(url: str) -> list[list[int]] | None:
    """Dark (1) / light (0) modules of a monochrome QR code for ``url`` (no quiet zone), or None."""
    rows = _qr_rows(str(url or ""))
    return [list(row) for row in rows] if rows else None


def qr_path(matrix) -> str:
    """An SVG path (one unit per module) drawing the dark modules, merged into horizontal runs."""
    parts = []
    for y, row in enumerate(matrix):
        x = 0
        width = len(row)
        while x < width:
            if row[x]:
                start = x
                while x < width and row[x]:
                    x += 1
                parts.append(f"M{start} {y}h{x - start}v1h-{x - start}z")
            else:
                x += 1
    return "".join(parts)


def qr_payload(certificate: Certificate) -> dict | None:
    """``{"modules", "quiet", "path", "url"}`` for the web page, or None when no QR library is installed."""
    url = public_url(certificate.reference)
    matrix = qr_matrix(url)
    if not matrix:
        return None
    return {"modules": len(matrix), "quiet": QR_QUIET_ZONE, "path": qr_path(matrix), "url": url}


def file_urls(certificate: Certificate, request=None) -> dict:
    reference = certificate.reference
    version = render_version(certificate)
    urls = {
        "pdf_url": reverse("engagement-certificate-pdf", kwargs={"ref": reference}) + f"?v={version}",
        "image_url": reverse("engagement-certificate-png", kwargs={"ref": reference}) + f"?v={version}",
        "og_image_url": reverse("engagement-certificate-og", kwargs={"ref": reference}) + f"?v={version}",
        "share_url": reverse("engagement-certificate-share", kwargs={"ref": reference}),
        "api_url": reverse("engagement-certificate", kwargs={"ref": reference}),
    }
    if request is not None:
        urls = {key: request.build_absolute_uri(value) for key, value in urls.items()}
    return urls


def public_dict(certificate: Certificate, request=None) -> dict:
    """What anyone may see: the name and the achievement. No e-mail, phone, user id or revocation reason.

    ``print`` carries every string printed on the certificate and the font
    sizes after fitting, so the web page draws exactly what the PDF shows.
    """
    from .certificate_render import print_block

    valid = certificate.is_valid
    issued = timezone.localtime(certificate.issued_at, rules.IST)
    return {
        "print": {key: value for key, value in print_block(certificate).items() if key != "qr"},
        "reference": certificate.reference,
        "status": "verified" if valid else "revoked",
        "valid": valid,
        "type": certificate.cert_type,
        "type_label": TYPE_LABELS.get(certificate.cert_type, ""),
        "recipient_name": certificate.recipient_name,
        "heading": certificate.heading,
        "statement": certificate.statement,
        "title": certificate.title,
        "programme": certificate.programme,
        "issued_at": certificate.issued_at.isoformat(),
        "issued_on": issued.date().isoformat(),
        "issuer": {"name": ISSUER_NAME, "signatory": SIGNATORY},
        "revision": certificate.revision,
        "revoked_at": None if valid else certificate.source_revoked_at.isoformat(),
        "verify_url": public_url(certificate.reference),
        "verify_short_url": short_url(certificate.reference),
        "linkedin_add_url": linkedin_add_url(certificate),
        "qr": qr_payload(certificate),
        **file_urls(certificate, request),
    }


def can_view_full(certificate: Certificate, user) -> bool:
    """Owner privacy rule: only the certified person (signed in) and staff see the
    full certificate (name, artwork, PDF/PNG). Everyone else gets ``minimal_dict``."""
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    if getattr(user, "is_staff", False) or getattr(user, "is_superuser", False):
        return True
    return bool(certificate.user_id and certificate.user_id == user.pk)


def minimal_dict(certificate: Certificate) -> dict:
    """What anyone may see: genuine or not, the certificate type, the issue date and the reference.

    No name, no title text, no artwork and no file links.
    """
    valid = certificate.is_valid
    issued = timezone.localtime(certificate.issued_at, rules.IST)
    return {
        "reference": certificate.reference,
        "status": "verified" if valid else "revoked",
        "valid": valid,
        "type": certificate.cert_type,
        "type_label": TYPE_LABELS.get(certificate.cert_type, ""),
        "issued_at": certificate.issued_at.isoformat(),
        "issued_on": issued.date().isoformat(),
        "issuer": {"name": ISSUER_NAME},
        "revoked_at": None if valid else certificate.source_revoked_at.isoformat(),
        "full": False,
        "is_owner": False,
    }


def viewer_dict(certificate: Certificate, user, request=None) -> dict:
    """The full payload for the owner and staff, the minimal one for everyone else."""
    if not can_view_full(certificate, user):
        return minimal_dict(certificate)
    data = public_dict(certificate, request)
    data["full"] = True
    data["is_owner"] = bool(certificate.user_id and certificate.user_id == getattr(user, "pk", None))
    return data


def staff_dict(certificate: Certificate, request=None) -> dict:
    data = public_dict(certificate, request)
    data.update(
        {
            "id": certificate.pk,
            "user_id": certificate.user_id,
            "achievement_slug": certificate.achievement.slug if certificate.achievement_id else None,
            "ctf_reward_id": certificate.ctf_reward_id,
            "revoked_reason": certificate.revoked_reason,
            "audit": [
                {
                    "action": row.action,
                    "revision": row.revision,
                    "name_before": row.name_before,
                    "name_after": row.name_after,
                    "reason": row.reason,
                    "actor_email": row.actor_email,
                    "created_at": row.created_at.isoformat(),
                }
                for row in certificate.revisions.order_by("created_at", "id")
            ],
        }
    )
    return data

