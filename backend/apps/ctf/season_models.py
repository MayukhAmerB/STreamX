"""Monthly OSINT CTF ("seasons"): one free challenge per IST calendar month.

* ``CtfSeason``: the month's challenge (brief, question, peppered answer
  digests), its window and its lifecycle
  ``draft -> scheduled -> open -> closed -> finalised``. Only ``scheduled``
  seasons are opened by the scheduler; a draft never goes live by itself.
* ``CtfSeasonEntry``: one per student per season. Holds the attempt counters
  and, once solved, the ranking key ``score_seconds`` =
  ``solve_seconds`` (time since the season opened) + ``wrong_attempts`` x
  the season's penalty. Ties go to the earliest ``solved_at``, then the
  lowest id, so ranks are never shared.
* ``CtfSeasonAttempt``: one row per evaluated answer (append-only).
* ``CtfSeasonReward``: an entitlement with a start and an optional end.
  Cosmetics (Golden Aura, podium frame, First Blood title) end after the
  following calendar month; trophies, badges, Hall of Fame features and
  certificates have no end. Unique per (season, user, kind), so granting is
  idempotent.
* ``CtfSeasonAudit``: who scheduled, finalised, disqualified or revoked what.

Imported by ``apps.ctf.models`` so Django registers the models in the
``ctf`` app (migration ``0003_monthly_ctf_seasons``).
"""

from __future__ import annotations

import secrets
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import Q
from django.utils import timezone

IST = ZoneInfo("Asia/Kolkata")

SEASON_DIFFICULTY_CHOICES = [
    ("easy", "Easy"),
    ("medium", "Medium"),
    ("hard", "Hard"),
]
DEFAULT_PENALTY_SECONDS = 600
DEFAULT_SEASON_MAX_ATTEMPTS = 50
DEFAULT_SOLVE_XP = 100


def month_start(day: date) -> date:
    return date(day.year, day.month, 1)


def add_months(day: date, months: int) -> date:
    index = day.year * 12 + (day.month - 1) + int(months)
    return date(index // 12, index % 12 + 1, 1)


def ist_midnight(day: date) -> datetime:
    """00:00 IST on ``day`` as an aware datetime."""
    return datetime.combine(day, time(0, 0), tzinfo=IST)


def month_label(day: date) -> str:
    return f"{day.strftime('%B')} {day.year}"


def new_verify_slug() -> str:
    return secrets.token_urlsafe(16)


class SeasonAppendOnlyError(RuntimeError):
    """Raised when code tries to change or delete a recorded season attempt."""


class CtfSeason(models.Model):
    STATUS_DRAFT = "draft"
    STATUS_SCHEDULED = "scheduled"
    STATUS_OPEN = "open"
    STATUS_CLOSED = "closed"
    STATUS_FINALISED = "finalised"
    STATUS_CHOICES = [
        (STATUS_DRAFT, "Draft"),
        (STATUS_SCHEDULED, "Scheduled"),
        (STATUS_OPEN, "Open"),
        (STATUS_CLOSED, "Closed (results pending)"),
        (STATUS_FINALISED, "Finalised"),
    ]
    LIVE_STATUSES = (STATUS_OPEN, STATUS_CLOSED, STATUS_FINALISED)

    slug = models.SlugField(max_length=64, unique=True, help_text="Public id, e.g. 2026-12.")
    month = models.DateField(unique=True, help_text="Any day of the IST calendar month this season belongs to.")
    title = models.CharField(max_length=160)
    tagline = models.CharField(max_length=200, blank=True)
    brief = models.TextField(help_text="The case file students read. Plain text; blank lines start paragraphs.")
    question = models.CharField(max_length=500, help_text="What the flag is, in one sentence.")
    flag_format = models.CharField(max_length=160, blank=True, help_text="e.g. 'A city name' or 'ASI{...}'.")
    difficulty = models.CharField(max_length=12, choices=SEASON_DIFFICULTY_CHOICES, default="medium")
    skills = models.JSONField(default=list, blank=True, help_text='List of short skill labels, e.g. ["GEOINT"].')
    materials_url = models.URLField(blank=True, help_text="Optional public starting point (our own material).")
    answer_rules = models.JSONField(default=list, blank=True, help_text="Normalisation rules (apps.core.textnorm).")
    answer_hashes = models.JSONField(default=list, blank=True, editable=False)
    answer_key_id = models.CharField(max_length=16, blank=True, editable=False)
    opens_at = models.DateTimeField()
    closes_at = models.DateTimeField()
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=STATUS_DRAFT)
    auto_finalise = models.BooleanField(
        default=True, help_text="Grant the rewards automatically when the season closes."
    )
    wrong_attempt_penalty_seconds = models.PositiveIntegerField(
        default=DEFAULT_PENALTY_SECONDS,
        validators=[MaxValueValidator(24 * 3600)],
        help_text="Added to the solve time for every wrong answer before the solve.",
    )
    max_attempts = models.PositiveIntegerField(
        default=DEFAULT_SEASON_MAX_ATTEMPTS, validators=[MinValueValidator(1), MaxValueValidator(500)]
    )
    solve_xp = models.PositiveIntegerField(default=DEFAULT_SOLVE_XP, validators=[MaxValueValidator(5000)])
    opened_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    finalised_at = models.DateTimeField(null=True, blank=True)
    finalised_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-month",)
        verbose_name = "Monthly CTF season"
        verbose_name_plural = "Monthly CTF seasons"
        constraints = [
            models.CheckConstraint(condition=Q(closes_at__gt=models.F("opens_at")), name="ctf_season_window_valid"),
        ]
        indexes = [
            models.Index(fields=["status", "opens_at"], name="ctf_season_status_open_idx"),
            models.Index(fields=["status", "closes_at"], name="ctf_season_status_close_idx"),
        ]

    def __str__(self):
        return f"{self.month_label} · {self.title}"

    def save(self, *args, **kwargs):
        if self.month:
            self.month = month_start(self.month)
        super().save(*args, **kwargs)

    @property
    def month_label(self) -> str:
        return month_label(month_start(self.month)) if self.month else ""

    @property
    def is_open(self) -> bool:
        now = timezone.now()
        return self.status == self.STATUS_OPEN and self.opens_at <= now < self.closes_at

    def cosmetic_window(self, start: datetime) -> tuple[datetime, datetime]:
        """Cosmetics run from ``start`` to the end of the month after the season's month (IST)."""
        end = ist_midnight(add_months(month_start(self.month), 2))
        return start, end

    def clean(self):
        errors = {}
        if self.opens_at and self.closes_at and self.closes_at <= self.opens_at:
            errors["closes_at"] = "The season must close after it opens."
        if not isinstance(self.skills, list) or not all(isinstance(item, str) for item in self.skills or []):
            errors["skills"] = "Use a list of short text labels."
        if errors:
            raise ValidationError(errors)


class CtfSeasonEntry(models.Model):
    season = models.ForeignKey(CtfSeason, on_delete=models.CASCADE, related_name="entries")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="ctf_season_entries")
    started_at = models.DateTimeField(default=timezone.now)
    attempts = models.PositiveIntegerField(default=0)
    wrong_attempts = models.PositiveIntegerField(default=0)
    solved_at = models.DateTimeField(null=True, blank=True)
    solve_seconds = models.PositiveIntegerField(null=True, blank=True)
    score_seconds = models.PositiveBigIntegerField(
        null=True, blank=True, help_text="Ranking key: solve time + wrong answers x penalty (lower is better)."
    )
    final_rank = models.PositiveIntegerField(null=True, blank=True)
    disqualified = models.BooleanField(default=False)
    disqualified_reason = models.CharField(max_length=300, blank=True)
    # Student identity at submission time (apps.users.identity; additive, backfilled by
    # ``manage.py backfill_identity_snapshots``). Shown before the record's own fields.
    student_roll_number = models.CharField(max_length=16, null=True, blank=True, editable=False)
    student_name_snapshot = models.CharField(max_length=255, null=True, blank=True, editable=False)
    student_handle_snapshot = models.CharField(max_length=30, null=True, blank=True, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("season", "score_seconds", "solved_at", "id")
        verbose_name = "Monthly CTF entry"
        verbose_name_plural = "Monthly CTF entries"
        constraints = [
            models.UniqueConstraint(fields=["season", "user"], name="ctf_season_entry_unique"),
        ]
        indexes = [
            models.Index(
                fields=["season", "disqualified", "score_seconds", "solved_at", "id"],
                name="ctf_season_rank_idx",
            ),
            models.Index(fields=["user", "solved_at"], name="ctf_season_user_solved_idx"),
        ]

    def __str__(self):
        return f"{self.user} · {self.season.slug}"

    @property
    def solved(self) -> bool:
        return self.solved_at is not None


class CtfSeasonAttempt(models.Model):
    season = models.ForeignKey(CtfSeason, on_delete=models.CASCADE, related_name="attempts")
    entry = models.ForeignKey(CtfSeasonEntry, on_delete=models.CASCADE, related_name="attempt_rows")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    normalized_answer = models.CharField(max_length=200, blank=True)
    is_correct = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ("-created_at", "-id")
        verbose_name = "Monthly CTF attempt"
        verbose_name_plural = "Monthly CTF attempts"
        indexes = [models.Index(fields=["season", "user", "created_at"], name="ctf_season_attempt_idx")]

    def save(self, *args, **kwargs):
        if self.pk is not None and not kwargs.pop("_allow_update", False):
            raise SeasonAppendOnlyError("Season attempts are append-only.")
        super().save(*args, **kwargs)


class CtfSeasonReward(models.Model):
    KIND_GOLDEN_AURA = "golden_aura"
    KIND_CHAMPION = "season_champion"
    KIND_PODIUM_FRAME = "podium_frame"
    KIND_PODIUM_TROPHY = "podium_trophy"
    KIND_FINALIST = "finalist"
    KIND_HALL_OF_FAME = "hall_of_fame"
    KIND_CERTIFICATE = "certificate"
    KIND_OPERATIVE = "monthly_operative"
    KIND_FIRST_BLOOD = "first_blood"
    KIND_XP = "xp"
    KIND_CHOICES = [
        (KIND_GOLDEN_AURA, "Golden Aura (cosmetic, next month)"),
        (KIND_CHAMPION, "Season Champion trophy"),
        (KIND_PODIUM_FRAME, "Podium frame (cosmetic, next month)"),
        (KIND_PODIUM_TROPHY, "Podium trophy (gold / silver / bronze)"),
        (KIND_FINALIST, "Finalist badge"),
        (KIND_HALL_OF_FAME, "Hall of Fame feature"),
        (KIND_CERTIFICATE, "Finalist certificate"),
        (KIND_OPERATIVE, "Monthly Operative badge"),
        (KIND_FIRST_BLOOD, "First Blood title (next month)"),
        (KIND_XP, "Solve XP"),
    ]
    COSMETIC_KINDS = (KIND_GOLDEN_AURA, KIND_PODIUM_FRAME, KIND_FIRST_BLOOD)
    TIER_GOLD = "gold"
    TIER_SILVER = "silver"
    TIER_BRONZE = "bronze"
    TIER_CHOICES = [(TIER_GOLD, "Gold"), (TIER_SILVER, "Silver"), (TIER_BRONZE, "Bronze")]

    season = models.ForeignKey(CtfSeason, on_delete=models.CASCADE, related_name="rewards")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="ctf_season_rewards")
    kind = models.CharField(max_length=24, choices=KIND_CHOICES)
    rank = models.PositiveIntegerField(null=True, blank=True)
    tier = models.CharField(max_length=8, choices=TIER_CHOICES, blank=True)
    title = models.CharField(max_length=160)
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField(null=True, blank=True, help_text="Empty = permanent.")
    points = models.PositiveIntegerField(default=0)
    metadata = models.JSONField(default=dict, blank=True)
    verify_slug = models.CharField(max_length=32, unique=True, null=True, blank=True)
    delivered_at = models.DateTimeField(
        null=True, blank=True, help_text="XP rewards: when the engagement ledger accepted the points."
    )
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_reason = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ("-starts_at", "rank", "id")
        verbose_name = "Monthly CTF reward"
        verbose_name_plural = "Monthly CTF rewards"
        constraints = [
            models.UniqueConstraint(fields=["season", "user", "kind"], name="ctf_season_reward_unique"),
        ]
        indexes = [
            models.Index(fields=["user", "kind", "ends_at"], name="ctf_season_reward_user_idx"),
            models.Index(fields=["kind", "delivered_at"], name="ctf_season_reward_xp_idx"),
        ]

    def __str__(self):
        return f"{self.title} · {self.user}"

    def is_active(self, at: datetime | None = None) -> bool:
        at = at or timezone.now()
        if self.revoked_at is not None or self.starts_at > at:
            return False
        return self.ends_at is None or at < self.ends_at


class CtfSeasonAudit(models.Model):
    ACTION_CHOICES = [
        ("create", "Created"),
        ("update", "Edited"),
        ("answers", "Answers replaced"),
        ("schedule", "Scheduled"),
        ("unschedule", "Moved back to draft"),
        ("open", "Opened"),
        ("close", "Closed"),
        ("finalise", "Results finalised"),
        ("disqualify", "Entry disqualified"),
        ("reinstate", "Entry reinstated"),
        ("revoke", "Reward revoked"),
        ("xp", "XP delivered"),
    ]

    season = models.ForeignKey(CtfSeason, null=True, blank=True, on_delete=models.SET_NULL, related_name="audit")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    action = models.CharField(max_length=16, choices=ACTION_CHOICES)
    detail = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ("-created_at", "-id")
        verbose_name = "Monthly CTF audit entry"
        verbose_name_plural = "Monthly CTF audit log"
        indexes = [models.Index(fields=["season", "created_at"], name="ctf_season_audit_idx")]

    def __str__(self):
        return f"{self.get_action_display()} · {self.created_at:%Y-%m-%d %H:%M}"
