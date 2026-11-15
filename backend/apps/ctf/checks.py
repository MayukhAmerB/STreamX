"""Startup checks for CTF exams (same severity policy as apps/core/checks.py:
ERROR blocks a production start, INFO never does, WARNING is not used).

ctf.E001  CTF_ANSWER_PEPPER is set but weak: shorter than 32 characters or
          equal to DJANGO_SECRET_KEY (one leaked secret must not expose both)
ctf.I001  production without CTF_ANSWER_PEPPER: the exam API answers 503
          ``ctf_not_configured`` and the loader refuses to run, but the rest
          of the LMS starts normally
"""

from __future__ import annotations

from django.conf import settings
from django.core.checks import Error, Info, Tags, register

CTF_TAG = "ctf"
MIN_PEPPER_LENGTH = 32


def _is_production() -> bool:
    return str(getattr(settings, "APP_ENV", "") or "").strip().lower() in {"production", "prod"}


@register(CTF_TAG, Tags.security)
def check_answer_pepper(app_configs=None, **kwargs):
    pepper = str(getattr(settings, "CTF_ANSWER_PEPPER", "") or "").strip()
    if not pepper:
        if _is_production():
            return [
                Info(
                    "CTF_ANSWER_PEPPER is not set: OSINT CTF exams are disabled until it is.",
                    hint='Generate one with: python -c "import secrets; print(secrets.token_urlsafe(48))"',
                    id="ctf.I001",
                )
            ]
        return []
    errors = []
    if len(pepper) < MIN_PEPPER_LENGTH:
        errors.append(
            Error(
                f"CTF_ANSWER_PEPPER must be at least {MIN_PEPPER_LENGTH} characters.",
                hint='Generate one with: python -c "import secrets; print(secrets.token_urlsafe(48))"',
                id="ctf.E001",
            )
        )
    if pepper == str(getattr(settings, "SECRET_KEY", "") or "").strip():
        errors.append(Error("CTF_ANSWER_PEPPER must not equal DJANGO_SECRET_KEY.", id="ctf.E001"))
    return errors
