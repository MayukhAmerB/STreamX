"""Report on, or create and schedule, the FIRST Monthly OSINT CTF season.

Seasons are normally written in the admin (Admin > Monthly CTF seasons > Add,
then the "Schedule selected seasons" action). This command covers release day:

    python manage.py ctf_first_season                       # status only: what exists, what to do next
    python manage.py ctf_first_season --file season.json    # dry run: validate the owner's case file
    python manage.py ctf_first_season --file season.json --apply [--actor-email owner@example.com]
    python manage.py ctf_first_season --file - --apply < season.json   # production: the file never enters an image

It never invents content: the case file (title, brief, question, accepted
answers, window) must be written by the owner, and anything that looks like a
placeholder ("TODO", "TBD", "lorem ipsum", "placeholder", ...) is refused. It
only acts while NO season exists at all; later seasons are added in the admin.
Accepted answers are stored only as peppered digests (CTF_ANSWER_PEPPER) and
are never printed.

File format (JSON object)::

    {
      "month": "2026-12",                       # or any date of that IST month
      "slug": "2026-12",                        # optional, defaults to the month
      "title": "...", "tagline": "...",         # tagline optional
      "brief": "...",                           # the case file; blank lines start paragraphs
      "question": "...", "flag_format": "...",  # flag_format optional
      "difficulty": "medium",                   # optional (easy, medium, hard, expert)
      "skills": ["GEOINT"],                     # optional
      "materials_url": "https://...",           # optional, our own material
      "accepted_answers": ["..."],
      "opens_at": "2026-12-01T13:30:00+05:30",  # ISO 8601 with an offset
      "closes_at": "2026-12-07T23:59:00+05:30",
      "solve_xp": 100, "max_attempts": 50, "wrong_attempt_penalty_seconds": 600   # optional
    }
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core import features
from apps.core.errors import DomainError
from apps.ctf import season_services as services
from apps.ctf.features import FEATURE_KEY
from apps.ctf.season_models import SEASON_DIFFICULTY_CHOICES, CtfSeason, month_start

MAX_FILE_BYTES = 256 * 1024
PLACEHOLDER = re.compile(
    r"\b(todo|tbd|tba|fixme|changeme|lorem|ipsum|placeholder|dummy|sample answer|your answer)\b|x{3,}|\{\{|\}\}",
    re.IGNORECASE,
)
MIN_LENGTHS = {"title": 4, "brief": 80, "question": 10}
TEXT_FIELDS = ("title", "tagline", "brief", "question", "flag_format")
OPTIONAL_INTS = ("solve_xp", "max_attempts", "wrong_attempt_penalty_seconds")


class Command(BaseCommand):
    help = "Report on the Monthly CTF, or create and schedule its first season from an owner-written case file."
    stealth_options = ("stdin",)

    def add_arguments(self, parser):
        parser.add_argument("--file", default="", help="Path to the season JSON file, or - for standard input.")
        parser.add_argument("--apply", action="store_true", help="Create and schedule the season (default: validate only).")
        parser.add_argument("--actor-email", default="", help="Staff account recorded in the season audit log.")

    # ------------------------------------------------------------------ status
    def _status(self) -> None:
        enabled = features.is_enabled(FEATURE_KEY)
        now = timezone.now()
        total = CtfSeason.objects.count()
        current = services.current_season(now)
        self.stdout.write(f"Monthly CTF switch ({FEATURE_KEY}): {'ON' if enabled else 'OFF'}")
        self.stdout.write(f"Seasons stored: {total}")
        if current is not None:
            self.stdout.write(
                f"Current/next season: {current.slug} '{current.title}' [{current.status}] "
                f"opens {current.opens_at.isoformat()} closes {current.closes_at.isoformat()}"
            )
            problem = services.answers_problem(current)
            if problem and current.status != CtfSeason.STATUS_FINALISED:
                self.stdout.write(self.style.WARNING(f"Answers: {problem}"))
        drafts = CtfSeason.objects.filter(status=CtfSeason.STATUS_DRAFT).count()
        if drafts:
            self.stdout.write(f"Drafts waiting to be scheduled: {drafts} (Admin > Monthly CTF seasons > Schedule).")
        upcoming = CtfSeason.objects.filter(
            status__in=(CtfSeason.STATUS_SCHEDULED, CtfSeason.STATUS_OPEN), closes_at__gt=now
        ).exists()
        if not upcoming:
            self.stdout.write(
                self.style.WARNING(
                    "No season is scheduled or open: the Monthly CTF page says the next case is being prepared. "
                    "Create one in Admin > Monthly CTF seasons > Add and run 'Schedule selected seasons', "
                    "or run this command with --file <case file> --apply for the first season."
                )
            )
        if not enabled:
            self.stdout.write(self.style.WARNING("The switch is OFF: seasons do not open, close or finalise."))

    # ------------------------------------------------------------- validation
    def _read(self, source: str, stdin) -> dict:
        try:
            if source == "-":
                raw = stdin.read(MAX_FILE_BYTES + 1)
            else:
                with open(source, encoding="utf-8") as handle:
                    raw = handle.read(MAX_FILE_BYTES + 1)
        except OSError as exc:
            raise CommandError(f"Cannot read {source}: {exc.strerror or exc}") from None
        if len(raw) > MAX_FILE_BYTES:
            raise CommandError("The season file is too large.")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise CommandError(f"The season file is not valid JSON: {exc}") from None
        if not isinstance(data, dict):
            raise CommandError("The season file must be a JSON object.")
        return data

    @staticmethod
    def _month(value) -> date:
        text = str(value or "").strip()
        for fmt in ("%Y-%m-%d", "%Y-%m"):
            try:
                return month_start(datetime.strptime(text, fmt).date())
            except ValueError:
                continue
        raise CommandError("'month' must look like 2026-12 or 2026-12-01.")

    @staticmethod
    def _moment(data: dict, key: str) -> datetime:
        value = parse_datetime(str(data.get(key) or "").strip())
        if value is None or timezone.is_naive(value):
            raise CommandError(f"'{key}' must be an ISO 8601 date-time with an offset, e.g. 2026-12-01T13:30:00+05:30.")
        return value

    def _validate(self, data: dict) -> tuple[dict, list[str]]:
        errors: list[str] = []
        fields: dict = {}
        for key in TEXT_FIELDS:
            value = data.get(key, "")
            if not isinstance(value, str):
                errors.append(f"'{key}' must be text.")
                value = ""
            fields[key] = value.strip()
        for key, minimum in MIN_LENGTHS.items():
            if len(fields[key]) < minimum:
                errors.append(f"'{key}' is missing or shorter than {minimum} characters.")
        answers = data.get("accepted_answers")
        if not isinstance(answers, list) or not [a for a in answers if isinstance(a, str) and a.strip()]:
            errors.append("'accepted_answers' must be a list with at least one answer.")
            answers = []
        answers = [a.strip() for a in answers if isinstance(a, str) and a.strip()]
        for label, text in [*((key, fields[key]) for key in TEXT_FIELDS), *(("accepted_answers", a) for a in answers)]:
            if text and PLACEHOLDER.search(text):
                errors.append(f"'{label}' looks like placeholder text; write the real case content.")
        fields["month"] = self._month(data.get("month"))
        fields["slug"] = str(data.get("slug") or fields["month"].strftime("%Y-%m")).strip()
        fields["opens_at"] = self._moment(data, "opens_at")
        fields["closes_at"] = self._moment(data, "closes_at")
        difficulty = str(data.get("difficulty") or "medium").strip()
        if difficulty not in dict(SEASON_DIFFICULTY_CHOICES):
            errors.append(f"'difficulty' must be one of {', '.join(dict(SEASON_DIFFICULTY_CHOICES))}.")
        fields["difficulty"] = difficulty
        skills = data.get("skills", [])
        if not isinstance(skills, list) or not all(isinstance(item, str) for item in skills):
            errors.append("'skills' must be a list of short text labels.")
            skills = []
        fields["skills"] = [item.strip()[:40] for item in skills if item.strip()][:8]
        fields["materials_url"] = str(data.get("materials_url") or "").strip()
        for key in OPTIONAL_INTS:
            if key in data:
                if not isinstance(data[key], int) or isinstance(data[key], bool) or data[key] < 0:
                    errors.append(f"'{key}' must be a whole number.")
                else:
                    fields[key] = data[key]
        fields["accepted_answers"] = answers
        return fields, errors

    # ------------------------------------------------------------------ apply
    def _actor(self, email: str):
        if not email:
            return None
        user = get_user_model().objects.filter(email__iexact=email.strip(), is_staff=True).first()
        if user is None:
            raise CommandError(f"No staff account with the email {email!r}.")
        return user

    def handle(self, *args, **options):
        source = str(options.get("file") or "").strip()
        if not source:
            self._status()
            return
        if CtfSeason.objects.exists():
            raise CommandError(
                "A season already exists; this command only creates the first one. "
                "Add the next seasons in Admin > Monthly CTF seasons."
            )
        data = self._read(source, options.get("stdin") or sys.stdin)
        fields, errors = self._validate(data)
        answers = fields.pop("accepted_answers")
        season = CtfSeason(**{key: value for key, value in fields.items()})
        try:
            season.full_clean(exclude=["answer_rules", "answer_hashes", "answer_key_id"])
        except ValidationError as exc:
            errors.extend(f"{key}: {' '.join(messages)}" for key, messages in exc.message_dict.items())
        if fields["closes_at"] <= timezone.now():
            errors.append("The closing time is already in the past.")
        if errors:
            raise CommandError("The season file was refused:\n- " + "\n- ".join(errors))
        summary = (
            f"Season {season.slug} '{season.title}' ({season.month_label}): opens {season.opens_at.isoformat()}, "
            f"closes {season.closes_at.isoformat()}, {len(answers)} accepted answer(s)."
        )
        if not options.get("apply"):
            self.stdout.write(f"Valid. {summary}\nRun again with --apply to create and schedule it.")
            return
        actor = self._actor(options.get("actor_email") or "")
        try:
            with transaction.atomic():
                if CtfSeason.objects.select_for_update().exists():
                    raise CommandError("A season was created meanwhile; nothing changed.")
                season.created_by = actor
                season.save()
                services.audit(season, actor, "create", fields=sorted(fields), source="ctf_first_season")
                services.set_answers(season, answers, actor=actor)
                services.schedule(season, actor=actor)
        except DomainError as exc:
            raise CommandError(str(getattr(exc, "message", "") or exc)) from None
        except Exception as exc:  # noqa: BLE001 - e.g. CtfNotConfigured (no answer pepper)
            message = getattr(exc, "message", "") or str(exc)
            raise CommandError(f"Nothing was created: {message}") from None
        self.stdout.write(self.style.SUCCESS(f"Created and scheduled. {summary}"))
        if not features.is_enabled(FEATURE_KEY):
            self.stdout.write(self.style.WARNING(f"The '{FEATURE_KEY}' switch is OFF: the season will not open until it is on."))
