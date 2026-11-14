"""Startup checks for CTF exams (same severity policy as apps/core/checks.py:
ERROR blocks a production start, INFO never does, WARNING is not used).

Every check here is INFO on purpose. ``entrypoint.sh`` runs ``check --deploy
--fail-level WARNING`` before every backend, worker and recorder start, so an
ERROR would let one exam secret take the whole LMS down (live classes
included) at the next restart or autoheal. A missing or weak pepper instead
disables exams only: ``answers.answer_pepper()`` raises 503
``ctf_not_configured``, the Console readiness checklist keeps Publish disabled
with the reason, and labs shows "Answer checking is not available" in place
of Start. The INFO line is still printed by every ``check --deploy`` run (the
container start and ``infra/hostinger/deploy-safe.sh``), so the deploy log
shows it.

ctf.I001  production without CTF_ANSWER_PEPPER: exams are disabled until it
          is set
ctf.I002  production with an unusable pepper while an exam is published:
          students see that exam but cannot start or answer it
ctf.I003  CTF_ANSWER_PEPPER is set but weak (shorter than 32 characters, or
          equal to DJANGO_SECRET_KEY so one leaked secret exposes both); in
          production exams are disabled until it is replaced
"""

from __future__ import annotations

import logging

from django.conf import settings
from django.core.checks import Info, Tags, register
from django.db import DatabaseError

from . import answers

CTF_TAG = "ctf"
MIN_PEPPER_LENGTH = answers.MIN_PEPPER_LENGTH
PEPPER_HINT = 'Generate one with: python -c "import secrets; print(secrets.token_urlsafe(48))"'
ENV_FILE_HINT = " and set CTF_ANSWER_PEPPER in backend/.env.hostinger.production, then restart the backend."
WEAK_PEPPER = {
    answers.PEPPER_TOO_SHORT: f"CTF_ANSWER_PEPPER is shorter than {MIN_PEPPER_LENGTH} characters",
    answers.PEPPER_EQUALS_SECRET_KEY: "CTF_ANSWER_PEPPER equals DJANGO_SECRET_KEY",
}

logger = logging.getLogger("apps.ctf.checks")


def _is_production() -> bool:
    return str(getattr(settings, "APP_ENV", "") or "").strip().lower() in {"production", "prod"}


def _live_exam_exists():
    """True/False, or None when the database cannot be asked (before the first
    migrate, or while it is unreachable)."""
    try:
        from .models import CtfExam

        # Only the status column: this also runs before new migrations apply.
        return CtfExam.objects.filter(status=CtfExam.STATUS_PUBLISHED).exists()
    except DatabaseError:
        return None
    except Exception:  # noqa: BLE001 - a check must never crash startup on its own
        logger.warning("ctf check: could not look for published exams", exc_info=False)
        return None


@register(CTF_TAG, Tags.security)
def check_answer_pepper(app_configs=None, **kwargs):
    problem = answers.pepper_problem()
    if not problem:
        return []
    production = _is_production()
    if problem == answers.PEPPER_MISSING:
        if not production:
            return []  # development and tests use the stand-in pepper
        messages = [
            Info(
                "CTF_ANSWER_PEPPER is not set: OSINT CTF exams are disabled until it is "
                "(the rest of the LMS runs normally).",
                hint=PEPPER_HINT + ENV_FILE_HINT,
                id="ctf.I001",
            )
        ]
    else:
        effect = (
            "OSINT CTF exams are disabled until it is replaced (the rest of the LMS runs normally)."
            if production
            else "Production would disable OSINT CTF exams with it."
        )
        messages = [
            Info(
                f"{WEAK_PEPPER[problem]}: {effect}",
                hint=PEPPER_HINT + ENV_FILE_HINT,
                id="ctf.I003",
            )
        ]
    if production and _live_exam_exists():
        messages.append(
            Info(
                "An OSINT CTF exam is published but answers cannot be checked: students see it but cannot "
                "start or answer it until a valid CTF_ANSWER_PEPPER is set.",
                hint=PEPPER_HINT + ENV_FILE_HINT,
                id="ctf.I002",
            )
        )
    return messages
