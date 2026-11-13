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
import re
import unicodedata
from collections.abc import Iterable, Sequence

from django.conf import settings
from django.utils.crypto import salted_hmac

from apps.core.errors import UpstreamUnavailable

DEFAULT_RULES: tuple[str, ...] = ("nfkc", "trim", "collapse_whitespace", "casefold")
SEPARATOR = "\x1f"
QUOTE_CHARACTERS = "\"'`‘’“”«»"

_WHITESPACE = re.compile(r"\s+")
_URL_SCHEME = re.compile(r"^[a-z][a-z0-9+.\-]*://", re.IGNORECASE)
_WWW = re.compile(r"^www\.", re.IGNORECASE)


def _strip_punctuation(text: str) -> str:
    return "".join(ch for ch in text if not unicodedata.category(ch).startswith("P"))


def _strip_diacritics(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return unicodedata.normalize("NFC", "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn"))


def _digits_only(text: str) -> str:
    # Any script's decimal digits (e.g. Urdu ۱۲۳) count, written as ASCII.
    digits = []
    for ch in text:
        value = unicodedata.decimal(ch, None)
        if value is not None:
            digits.append(str(value))
    return "".join(digits)


RULES = {
    "nfkc": lambda text: unicodedata.normalize("NFKC", text),
    "trim": lambda text: text.strip(),
    "collapse_whitespace": lambda text: _WHITESPACE.sub(" ", text),
    "remove_whitespace": lambda text: _WHITESPACE.sub("", text),
    "casefold": lambda text: text.casefold(),
    "strip_punctuation": _strip_punctuation,
    "strip_diacritics": _strip_diacritics,
    "strip_url_scheme": lambda text: _URL_SCHEME.sub("", text),
    "strip_www": lambda text: _WWW.sub("", text),
    "strip_trailing_slash": lambda text: text.rstrip("/"),
    "strip_leading_at": lambda text: text.lstrip("@"),
    "strip_quotes": lambda text: text.strip(QUOTE_CHARACTERS),
    "digits_only": _digits_only,
}
RULE_NAMES = tuple(RULES)


class CtfNotConfigured(UpstreamUnavailable):
    status = 503
    code = "ctf_not_configured"
    default_message = "Exam answer checking is not configured on the server yet. Please tell your instructor."


def validate_rules(rules: Iterable[str] | None) -> list[str]:
    """Return the rule list (default when empty); raise ValueError on unknown names."""
    names = [str(name) for name in (rules or [])]
    unknown = [name for name in names if name not in RULES]
    if unknown:
        raise ValueError(f"unknown normalisation rule(s): {', '.join(unknown)}")
    if len(set(names)) != len(names):
        raise ValueError("normalisation rules must not repeat")
    return names or list(DEFAULT_RULES)


def normalize(text: str, rules: Sequence[str] | None = None) -> str:
    value = str(text or "")
    for name in validate_rules(rules):
        value = RULES[name](value)
    return value


def _is_production() -> bool:
    return str(getattr(settings, "APP_ENV", "") or "").strip().lower() in {"production", "prod"}


def answer_pepper() -> bytes:
    """The HMAC key. Production must configure ``CTF_ANSWER_PEPPER``; development
    and tests derive a stable stand-in from ``SECRET_KEY`` so they work out of
    the box (``ctf.E001`` keeps that fallback out of production)."""
    pepper = str(getattr(settings, "CTF_ANSWER_PEPPER", "") or "").strip()
    if pepper:
        return pepper.encode("utf-8")
    if _is_production():
        raise CtfNotConfigured()
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
