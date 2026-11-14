"""Answer normalisation and peppered verification.

An accepted answer is stored only as
``HMAC-SHA256(CTF_ANSWER_PEPPER, f"{exam_slug}\\x1f{question_key}\\x1f{normalized}")``.
Binding the exam slug and question key into the message means a digest can
never be replayed for another question, and the pepper (a server secret that
is not in the database) means a database dump cannot be brute-forced offline
against a dictionary of likely answers.

Normalisation is a fixed whitelist of named rules, applied in the order the
exam file lists them, so the same rules run at load time (on the accepted
answers) and at submission time (on what the student typed).
"""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Iterable, Sequence

from django.conf import settings
from django.utils.crypto import salted_hmac

from apps.core.errors import UpstreamUnavailable

# The named rules are the shared normaliser (apps.core.textnorm), so weekly
# report targets and exam answers are folded by exactly the same code. The
# rule set and behaviour are frozen there: a stored digest never changes.
from apps.core.textnorm import DEFAULT_RULES, QUOTE_CHARACTERS, RULE_NAMES, RULES, normalize, validate_rules

SEPARATOR = "\x1f"

__all__ = [
    "DEFAULT_RULES",
    "MIN_PEPPER_LENGTH",
    "QUOTE_CHARACTERS",
    "RULE_NAMES",
    "RULES",
    "SEPARATOR",
    "CtfNotConfigured",
    "answer_digest",
    "answer_key_id",
    "answer_pepper",
    "exams_disabled_reason",
    "hash_answers",
    "normalize",
    "pepper_problem",
    "validate_rules",
    "verify",
]


class CtfNotConfigured(UpstreamUnavailable):
    status = 503
    code = "ctf_not_configured"
    default_message = "Exam answer checking is not configured on the server yet. Please tell your instructor."


def _is_production() -> bool:
    return str(getattr(settings, "APP_ENV", "") or "").strip().lower() in {"production", "prod"}


MIN_PEPPER_LENGTH = 32

# pepper_problem() codes, each with the staff-facing reason the Console
# readiness checklist and the startup check (apps/ctf/checks.py) show.
PEPPER_MISSING = "missing"
PEPPER_TOO_SHORT = "too_short"
PEPPER_EQUALS_SECRET_KEY = "equals_secret_key"
PEPPER_PROBLEMS = {
    PEPPER_MISSING: "CTF_ANSWER_PEPPER is not set on the server, so answers cannot be checked.",
    PEPPER_TOO_SHORT: (
        f"CTF_ANSWER_PEPPER is shorter than {MIN_PEPPER_LENGTH} characters, so it is not used and answers "
        "cannot be checked."
    ),
    PEPPER_EQUALS_SECRET_KEY: (
        "CTF_ANSWER_PEPPER equals DJANGO_SECRET_KEY, so it is not used and answers cannot be checked."
    ),
}


def _configured_pepper() -> str:
    return str(getattr(settings, "CTF_ANSWER_PEPPER", "") or "").strip()


def pepper_problem() -> str:
    """Why the configured pepper cannot be used ("" when it can).

    A missing pepper is reported in every environment (development then uses
    the stand-in below); a weak one (too short, or equal to SECRET_KEY so one
    leaked secret exposes both) is reported only when one is actually set."""
    pepper = _configured_pepper()
    if not pepper:
        return PEPPER_MISSING
    if len(pepper) < MIN_PEPPER_LENGTH:
        return PEPPER_TOO_SHORT
    if pepper == str(getattr(settings, "SECRET_KEY", "") or "").strip():
        return PEPPER_EQUALS_SECRET_KEY
    return ""


def exams_disabled_reason() -> str:
    """Staff-facing reason exams are switched off on this server ("" when they
    are not). Only production disables them: a missing or weak pepper turns
    off exam publishing, starting and answering, never the rest of the LMS."""
    if not _is_production():
        return ""
    return PEPPER_PROBLEMS.get(pepper_problem(), "")


def answer_pepper() -> bytes:
    """The HMAC key. Production must configure a strong ``CTF_ANSWER_PEPPER``:
    a missing or weak one raises ``CtfNotConfigured`` (503), which disables
    exams only. Development and tests derive a stable stand-in from
    ``SECRET_KEY`` when none is set so they work out of the box."""
    if _is_production():
        if pepper_problem():
            raise CtfNotConfigured()
        return _configured_pepper().encode("utf-8")
    pepper = _configured_pepper()
    if pepper:
        return pepper.encode("utf-8")
    return salted_hmac("apps.ctf.development-pepper", "ctf", algorithm="sha256").hexdigest().encode("ascii")


def answer_key_id() -> str:
    """Short public fingerprint of the pepper, stored on the exam at load time so
    a rotated pepper is detected instead of marking every answer wrong."""
    return hmac.new(answer_pepper(), b"apps.ctf.answer-key-id", hashlib.sha256).hexdigest()[:16]


def answer_digest(exam_slug: str, question_key: str, normalized: str) -> str:
    message = SEPARATOR.join((str(exam_slug), str(question_key), str(normalized))).encode("utf-8")
    return hmac.new(answer_pepper(), message, hashlib.sha256).hexdigest()


def hash_answers(exam_slug: str, question_key: str, answers: Iterable[str], rules: Sequence[str] | None) -> list[str]:
    """Digests of every accepted variant (sorted, de-duplicated)."""
    digests = set()
    for answer in answers:
        normalized = normalize(answer, rules)
        if not normalized:
            raise ValueError("an accepted answer is empty after normalisation")
        digests.add(answer_digest(exam_slug, question_key, normalized))
    return sorted(digests)


def verify(
    exam_slug: str, question_key: str, submitted: str, rules: Sequence[str] | None, hashes: Iterable[str]
) -> tuple[bool, str]:
    """Return ``(is_correct, normalized)``. Compares against every stored digest
    in constant time per digest, without short-circuiting."""
    normalized = normalize(submitted, rules)
    if not normalized:
        return False, normalized
    digest = answer_digest(exam_slug, question_key, normalized)
    matched = False
    for expected in hashes or []:
        matched |= hmac.compare_digest(digest, str(expected))
    return matched, normalized
