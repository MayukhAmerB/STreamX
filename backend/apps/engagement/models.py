"""Engagement storage.

* ``XpEvent`` -- the append-only XP ledger (the source of truth). Rows are
  small; a correction is a new (negative) row, never an update.
* ``EngagementSummary`` -- one denormalised row per user (the read model):
  updated with ``F()`` in the same transaction that inserts ledger rows, so
  ``GET /api/engagement/me/`` is a single primary-key read.
* ``ActivityDay`` -- one row per user per IST day: XP that day, watched and
  live seconds (write-behind from Redis), watch XP already paid.
* ``LiveAttendance`` -- seconds present in one live class (write-behind).
* ``BadgeAward``, ``Achievement`` -- earned badges and shareable milestones.
* ``EngagementSettings`` -- leaderboard visibility per user.
* ``EngagementAuditLog`` -- staff award/revoke trail.
* ``FlushLog`` -- write-behind batches already applied (exactly-once flush).
"""

from __future__ import annotations

import secrets

from django.conf import settings
from django.db import models
from django.db.models import F, Q
from django.utils import timezone

from .rules import KIND_CHOICES


class AppendOnlyError(RuntimeError):
    pass


class XpEventQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise AppendOnlyError("The XP ledger is append-only; add a correcting event instead.")

    def delete(self):
        raise AppendOnlyError("The XP ledger is append-only; add a correcting event instead.")


class XpEvent(models.Model):
    SOURCE_LECTURE = "lecture"
    SOURCE_DAY = "day"
    SOURCE_LIVE = "live_session"
    SOURCE_REPORT_TASK = "report_task"
    SOURCE_REPORT_SUBMISSION = "report_submission"
    SOURCE_EXAM = "ctf_exam"
    SOURCE_STAFF = "staff"
    SOURCE_XP_EVENT = "xp_event"

    id = models.BigAutoField(primary_key=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+", db_index=False)
    kind = models.CharField(max_length=24, choices=KIND_CHOICES)
    source_type = models.CharField(max_length=24)
    source_id = models.CharField(max_length=40, blank=True, default="")
    points = models.IntegerField()
    occurred_at = models.DateTimeField(help_text="When the activity happened (decides the IST day and week).")
    created_at = models.DateTimeField(default=timezone.now)
    idempotency_key = models.CharField(max_length=120, unique=True)

    objects = XpEventQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "XP event"
        verbose_name_plural = "XP ledger"
        indexes = [
            models.Index(fields=["user", "created_at"], name="eng_xp_user_created_idx"),
            models.Index(fields=["user", "kind"], name="eng_xp_user_kind_idx"),
            # Range scans (backfill audits, retention/rollup jobs). On PostgreSQL a
            # BRIN index would be smaller; a plain index keeps SQLite dev working.
            models.Index(fields=["created_at"], name="eng_xp_created_idx"),
        ]

    def save(self, *args, **kwargs):
        if self.pk and not kwargs.get("force_insert"):
            raise AppendOnlyError("The XP ledger is append-only; add a correcting event instead.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AppendOnlyError("The XP ledger is append-only; add a correcting event instead.")

    def __str__(self):
        return f"{self.points:+d} XP {self.kind} for user {self.user_id}"


class EngagementSummary(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="engagement_summary"
    )
    total_xp = models.IntegerField(default=0)
    level = models.PositiveSmallIntegerField(default=1)
    xp_reached_at = models.DateTimeField(null=True, blank=True, help_text="When total_xp last rose (rank tie-break).")
    week_start = models.DateField(null=True, blank=True, help_text="IST Monday that weekly_xp/time_week belong to.")
    weekly_xp = models.IntegerField(default=0)
    weekly_reached_at = models.DateTimeField(null=True, blank=True)
    current_streak = models.PositiveIntegerField(default=0)
    best_streak = models.PositiveIntegerField(default=0)
    last_study_day = models.DateField(null=True, blank=True)
    freeze_week = models.DateField(null=True, blank=True, help_text="IST Monday of the last week whose freeze was used.")
    freeze_used_on = models.DateField(null=True, blank=True)
    badges_count = models.PositiveIntegerField(default=0)
    last_activity_at = models.DateTimeField(null=True, blank=True)
    time_week_seconds = models.PositiveIntegerField(default=0)
    time_total_seconds = models.PositiveBigIntegerField(default=0)
    # XP economy v2: the purchase share of total_xp / weekly_xp (subscription
    # charges and course purchases, net of refunds), so leaderboards can rank
    # with or without it (ENGAGEMENT_LEADERBOARD_COUNT_PURCHASE_XP) without a migration.
    purchase_xp = models.IntegerField(default=0)
    weekly_purchase_xp = models.IntegerField(default=0)
    # Highest level the student has seen celebrated (level > level_seen => the UI
    # shows the level-up moment once, then acknowledges it).
    level_seen = models.PositiveSmallIntegerField(default=1)
    version = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "engagement summary"
        verbose_name_plural = "engagement summaries"
        indexes = [
            models.Index(fields=["level"], name="eng_sum_level_idx"),
            models.Index(F("total_xp").desc(), "xp_reached_at", name="eng_sum_alltime_idx"),
            models.Index("week_start", F("weekly_xp").desc(), "weekly_reached_at", name="eng_sum_weekly_idx"),
        ]

    def __str__(self):
        return f"{self.total_xp} XP (user {self.user_id})"


class ActivityDay(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+", db_index=False)
    day = models.DateField()
    xp = models.IntegerField(default=0)
    is_study_day = models.BooleanField(default=False)
    first_activity_at = models.DateTimeField(null=True, blank=True)
    watch_seconds = models.PositiveIntegerField(default=0, help_text="Measured watch time (write-behind).")
    backfill_watch_seconds = models.PositiveIntegerField(
        default=0, help_text="Estimated watch time from lecture progress (set, never added, by the backfill)."
    )
    live_seconds = models.PositiveIntegerField(default=0)
    watch_xp_awarded = models.PositiveSmallIntegerField(default=0)

    class Meta:
        verbose_name = "activity day"
        constraints = [models.UniqueConstraint(fields=["user", "day"], name="eng_activity_user_day_uniq")]
        indexes = [models.Index(fields=["user", "is_study_day", "day"], name="eng_activity_study_idx")]

    @property
    def counted_watch_seconds(self):
        return max(int(self.watch_seconds or 0), int(self.backfill_watch_seconds or 0))

    def __str__(self):
        return f"user {self.user_id} on {self.day}"


class LiveAttendance(models.Model):
    session_id = models.PositiveBigIntegerField(help_text="realtime.RealtimeSession id (kept after the session is deleted).")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    seconds = models.PositiveIntegerField(default=0)
    first_seen_at = models.DateTimeField(default=timezone.now)
    last_seen_at = models.DateTimeField(default=timezone.now)
    on_air_seconds = models.PositiveIntegerField(null=True, blank=True)
    finalized_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "live class attendance"
        verbose_name_plural = "live class attendance"
        constraints = [models.UniqueConstraint(fields=["session_id", "user"], name="eng_live_session_user_uniq")]

    def __str__(self):
        return f"user {self.user_id} in session {self.session_id}: {self.seconds}s"


class BadgeAward(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="engagement_badges")
    badge_key = models.CharField(max_length=40)
    awarded_at = models.DateTimeField(default=timezone.now)
    revoked_at = models.DateTimeField(null=True, blank=True)
    note = models.CharField(max_length=200, blank=True, default="")

    class Meta:
        ordering = ["-awarded_at", "-id"]
        verbose_name = "badge award"
        constraints = [models.UniqueConstraint(fields=["user", "badge_key"], name="eng_badge_user_key_uniq")]
        indexes = [models.Index(fields=["badge_key", "awarded_at"], name="eng_badge_key_idx")]

    def __str__(self):
        return f"{self.badge_key} for user {self.user_id}"


def new_achievement_slug() -> str:
    return secrets.token_urlsafe(16)  # 128 bits: unguessable


class Achievement(models.Model):
    KIND_LEVEL = "level"
    KIND_BADGE = "badge"
    KIND_COURSE = "course"
    KIND_CHOICES = [
        (KIND_LEVEL, "Level reached"),
        (KIND_BADGE, "Badge earned"),
        (KIND_COURSE, "Course completed"),
    ]

    slug = models.CharField(max_length=32, unique=True, default=new_achievement_slug, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="engagement_achievements")
    kind = models.CharField(max_length=12, choices=KIND_CHOICES)
    key = models.CharField(max_length=64, help_text="level key, badge key or course id.")
    title = models.CharField(max_length=160)
    subtitle = models.CharField(max_length=200, blank=True, default="")
    recipient_name = models.CharField(max_length=255, blank=True, default="", help_text="Name printed on the card.")
    earned_at = models.DateTimeField(default=timezone.now)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-earned_at", "-id"]
        verbose_name = "achievement"
        constraints = [models.UniqueConstraint(fields=["user", "kind", "key"], name="eng_achievement_user_kind_key_uniq")]
        indexes = [models.Index(fields=["user", "earned_at"], name="eng_achievement_user_idx")]

    @property
    def is_valid(self):
        return self.revoked_at is None

    def __str__(self):
        return f"{self.title} ({self.user_id})"


class EngagementSettings(models.Model):
    # Privacy (owner rule C): students appear on leaderboards by their profile
    # handle only, or not at all. "initials"/"name" are retired values (migrated
    # to "handle" in 0004); the constants stay so old payloads can be mapped.
    DISPLAY_HANDLE = "handle"
    DISPLAY_HIDDEN = "hidden"
    DISPLAY_INITIALS = "initials"  # retired
    DISPLAY_NAME = "name"  # retired
    RETIRED_DISPLAYS = (DISPLAY_INITIALS, DISPLAY_NAME)
    DISPLAY_CHOICES = [
        (DISPLAY_HANDLE, "Profile handle"),
        (DISPLAY_HIDDEN, "Hidden (not shown on leaderboards)"),
    ]

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="engagement_settings"
    )
    leaderboard_display = models.CharField(max_length=10, choices=DISPLAY_CHOICES, default=DISPLAY_HANDLE)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "engagement settings"
        verbose_name_plural = "engagement settings"
        indexes = [
            models.Index(
                fields=["leaderboard_display"], name="eng_settings_hidden_idx", condition=Q(leaderboard_display="hidden")
            )
        ]

    def __str__(self):
        return f"{self.leaderboard_display} (user {self.user_id})"


class EngagementAuditLog(models.Model):
    ACTION_AWARD_XP = "award_xp"
    ACTION_REVOKE_XP = "revoke_xp"
    ACTION_AWARD_BADGE = "award_badge"
    ACTION_REVOKE_BADGE = "revoke_badge"
    ACTION_REVOKE_ACHIEVEMENT = "revoke_achievement"
    ACTION_CHOICES = [
        (ACTION_AWARD_XP, "XP awarded"),
        (ACTION_REVOKE_XP, "XP revoked"),
        (ACTION_AWARD_BADGE, "Badge awarded"),
        (ACTION_REVOKE_BADGE, "Badge revoked"),
        (ACTION_REVOKE_ACHIEVEMENT, "Achievement revoked"),
    ]

    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    actor_email = models.EmailField(blank=True, default="")
    target_user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    action = models.CharField(max_length=24, choices=ACTION_CHOICES)
    points = models.IntegerField(null=True, blank=True)
    badge_key = models.CharField(max_length=40, blank=True, default="")
    xp_event = models.ForeignKey(XpEvent, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    reason = models.CharField(max_length=300)
    request_id = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "engagement audit entry"
        verbose_name_plural = "engagement audit log"

    def __str__(self):
        return f"{self.get_action_display()} for user {self.target_user_id}"


class FlushLog(models.Model):
    token = models.CharField(max_length=64, unique=True)
    kind = models.CharField(max_length=12)
    rows = models.PositiveIntegerField(default=0)
    applied_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        verbose_name = "write-behind flush"

    def __str__(self):
        return f"{self.kind} flush {self.token}"


class LegacyGrant(models.Model):
    """One row per student who studied here before release day (owner's legacy plan).

    Written only by ``apps.engagement.legacy`` (``manage.py engagement_legacy_rewards``):
    the row is the idempotency marker of the grant (re-runs skip granted students),
    the record of what was decided (active or not, batches, graduate) and the
    state of the one-time "Your journey so far" welcome screen.
    """

    COHORT_ACTIVE = "active"
    COHORT_INACTIVE = "inactive"
    COHORT_CHOICES = [(COHORT_ACTIVE, "Active legacy student"), (COHORT_INACTIVE, "Inactive legacy student")]

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="engagement_legacy")
    cohort = models.CharField(max_length=10, choices=COHORT_CHOICES)
    release_at = models.DateTimeField(help_text="The release moment the grant was computed against.")
    first_enrolled_at = models.DateTimeField(null=True, blank=True)
    last_activity_at = models.DateTimeField(null=True, blank=True, help_text="Latest learning activity before release.")
    batches = models.JSONField(default=list, blank=True, help_text="Batch numbers the student was enrolled in before release.")
    graduate = models.BooleanField(default=False, help_text="Already certified before release (Founding Graduate).")
    badges = models.JSONField(default=list, blank=True, help_text="Badge keys granted by the legacy run.")
    glow_starts_at = models.DateTimeField(null=True, blank=True)
    glow_ends_at = models.DateTimeField(null=True, blank=True, help_text="Founding Glow profile frame (active students).")
    granted_at = models.DateTimeField(default=timezone.now)
    welcome_seen_at = models.DateTimeField(null=True, blank=True, help_text="When the student dismissed 'Your journey so far'.")

    class Meta:
        verbose_name = "legacy grant"
        indexes = [models.Index(fields=["cohort"], name="eng_legacy_cohort_idx")]

    def __str__(self):
        return f"{self.cohort} legacy student {self.user_id}"

    def glow_active(self, at=None) -> bool:
        at = at or timezone.now()
        return bool(self.glow_starts_at and self.glow_ends_at and self.glow_starts_at <= at < self.glow_ends_at)


# --- certificates -------------------------------------------------------------------------------------
class CertificateQuerySet(models.QuerySet):
    def delete(self):
        raise AppendOnlyError("Certificates are permanent; revoke one instead of deleting it.")


class Certificate(models.Model):
    """A verifiable certificate with a permanent, human-readable reference number.

    The reference ``ASI-<YYYY>-<TYPE>-<sequence>-<check>`` is derived from the
    primary key, which the database hands out from a sequence (PostgreSQL
    sequence / SQLite AUTOINCREMENT): unique under any concurrency, and a
    committed number is never handed out again (not even after a deletion;
    on PostgreSQL not even a rolled-back one). Everything printed on the
    certificate is a snapshot taken at issue time; staff corrections bump
    ``revision`` and leave a ``CertificateRevision`` row (the reference never
    changes). See ``apps.engagement.certificates``.
    """

    TYPE_OSINT = "OSINT"
    TYPE_PEN = "PEN"
    TYPE_COURSE = "COURSE"
    TYPE_EXAM = "EXAM"
    TYPE_CTF = "CTF"
    TYPE_BADGE = "BADGE"
    TYPE_LEVEL = "LEVEL"
    TYPE_CHOICES = [
        (TYPE_OSINT, "Open Source Intelligence"),
        (TYPE_PEN, "Penetration Testing"),
        (TYPE_COURSE, "Professional Training"),
        (TYPE_EXAM, "Examination"),
        (TYPE_CTF, "Capture the Flag"),
        (TYPE_BADGE, "Achievement"),
        (TYPE_LEVEL, "Learner Progression"),
    ]

    id = models.BigAutoField(primary_key=True)
    reference = models.CharField(
        max_length=40, unique=True, null=True, blank=True, editable=False,
        help_text="Permanent reference number (set in the issuing transaction).",
    )
    cert_type = models.CharField("type", max_length=8, choices=TYPE_CHOICES)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="engagement_certificates")
    achievement = models.OneToOneField(
        Achievement, on_delete=models.CASCADE, null=True, blank=True, related_name="certificate"
    )
    ctf_reward = models.OneToOneField(
        "ctf.CtfSeasonReward", on_delete=models.CASCADE, null=True, blank=True, related_name="engagement_certificate",
        help_text="Monthly CTF finalist certificate this certifies (kind 'certificate').",
    )
    recipient_name = models.CharField(max_length=160, help_text="The holder's real name, as printed (snapshot).")
    heading = models.CharField(max_length=80)
    statement = models.CharField(max_length=120)
    title = models.CharField(max_length=200)
    programme = models.CharField(max_length=220, blank=True, default="")
    issued_at = models.DateTimeField()
    revision = models.PositiveIntegerField(default=1)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_reason = models.CharField(max_length=300, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    objects = CertificateQuerySet.as_manager()

    class Meta:
        ordering = ["-issued_at", "-id"]
        verbose_name = "certificate"
        indexes = [models.Index(fields=["user", "issued_at"], name="eng_cert_user_idx")]

    @property
    def is_valid(self) -> bool:
        """Valid unless the certificate, or the achievement / CTF reward it certifies, was revoked."""
        return self.source_revoked_at is None

    @property
    def source_revoked_at(self):
        """When this certificate stopped being valid (its own revocation first), else None."""
        if self.revoked_at is not None:
            return self.revoked_at
        if self.achievement_id and self.achievement.revoked_at is not None:
            return self.achievement.revoked_at
        if self.ctf_reward_id and self.ctf_reward.revoked_at is not None:
            return self.ctf_reward.revoked_at
        return None

    def delete(self, *args, **kwargs):
        raise AppendOnlyError("Certificates are permanent; revoke one instead of deleting it.")

    def __str__(self):
        return f"{self.reference or 'unnumbered'} · {self.recipient_name}"


class CertificateRevisionQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise AppendOnlyError("The certificate audit trail is append-only.")

    def delete(self):
        raise AppendOnlyError("The certificate audit trail is append-only.")


class CertificateRevision(models.Model):
    """Append-only audit trail: issue, name corrections, revocation, reinstatement."""

    ACTION_ISSUE = "issue"
    ACTION_CORRECT_NAME = "correct_name"
    ACTION_REVOKE = "revoke"
    ACTION_REINSTATE = "reinstate"
    ACTION_CHOICES = [
        (ACTION_ISSUE, "Issued"),
        (ACTION_CORRECT_NAME, "Name corrected"),
        (ACTION_REVOKE, "Revoked"),
        (ACTION_REINSTATE, "Reinstated"),
    ]

    certificate = models.ForeignKey(Certificate, on_delete=models.CASCADE, related_name="revisions")
    revision = models.PositiveIntegerField(help_text="The certificate revision after this action.")
    action = models.CharField(max_length=16, choices=ACTION_CHOICES)
    name_before = models.CharField(max_length=160, blank=True, default="")
    name_after = models.CharField(max_length=160, blank=True, default="")
    reason = models.CharField(max_length=300, blank=True, default="")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    actor_email = models.EmailField(blank=True, default="")
    request_id = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    objects = CertificateRevisionQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "certificate audit entry"
        verbose_name_plural = "certificate audit trail"
        indexes = [models.Index(fields=["certificate", "created_at"], name="eng_certrev_cert_idx")]

    def save(self, *args, **kwargs):
        if self.pk and not kwargs.get("force_insert"):
            raise AppendOnlyError("The certificate audit trail is append-only.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AppendOnlyError("The certificate audit trail is append-only.")

    def __str__(self):
        return f"{self.get_action_display()} r{self.revision} ({self.certificate_id})"
