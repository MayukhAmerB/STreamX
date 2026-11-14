"""Free OSINT challenge directory and members' lab catalogue metadata.

Rules (owner decision, OSINT membership rules):

* Free tier = a curated directory of free challenges that need no server lab.
  We store metadata only (title, platform, URL, difficulty, skills, time,
  whether the source is free) and link out ("Start on <platform>"). We never
  copy or re-host another platform's challenge text, images or answers.
* A challenge may be hosted by us only when its licence allows it
  (``HOSTABLE_LICENCES``: MIT, Apache-2.0, CC BY, CC0, BSD); CC BY-NC / ND or
  no licence = link-out only. The licence and attribution are stored and shown.
* Members' labs list only expert and professional challenges: our own, or
  GitHub challenges whose licence allows commercial use (same list).
"""

from __future__ import annotations

import hashlib
import unicodedata

from config.model_validators import validate_no_active_content
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models

DIFFICULTY_EASY = "easy"
DIFFICULTY_MEDIUM = "medium"
DIFFICULTY_HARD = "hard"
DIFFICULTY_EXPERT = "expert"
DIFFICULTY_PROFESSIONAL = "professional"
DIFFICULTY_CHOICES = [
    (DIFFICULTY_EASY, "Easy"),
    (DIFFICULTY_MEDIUM, "Medium"),
    (DIFFICULTY_HARD, "Hard"),
    (DIFFICULTY_EXPERT, "Expert"),
    (DIFFICULTY_PROFESSIONAL, "Professional"),
]

# Licences that allow us to host (and use commercially) with attribution.
HOSTABLE_LICENCES = {
    "MIT": "MIT License",
    "Apache-2.0": "Apache License 2.0",
    "BSD-2-Clause": "BSD 2-Clause",
    "BSD-3-Clause": "BSD 3-Clause",
    "CC-BY-4.0": "Creative Commons Attribution 4.0",
    "CC-BY-3.0": "Creative Commons Attribution 3.0",
    "CC0-1.0": "CC0 1.0 (public domain)",
}
LINK_OUT_ONLY_LICENCES = {
    "": "No licence / all rights reserved (link out only)",
    "CC-BY-NC-4.0": "CC BY-NC 4.0 (link out only)",
    "CC-BY-NC-SA-4.0": "CC BY-NC-SA 4.0 (link out only)",
    "CC-BY-ND-4.0": "CC BY-ND 4.0 (link out only)",
    "CC-BY-SA-4.0": "CC BY-SA 4.0 (link out only)",
    "proprietary": "Platform terms (link out only)",
}
LICENCE_CHOICES = [*HOSTABLE_LICENCES.items(), *LINK_OUT_ONLY_LICENCES.items()]


def normalize_flag(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", str(value or "")).strip().lower().split())


def flag_hash(value: str) -> str:
    return hashlib.sha256(normalize_flag(value).encode("utf-8")).hexdigest()


class OsintPath(models.Model):
    """Our own learning path through the directory (ordering and a short summary)."""

    key = models.SlugField(max_length=40, unique=True)
    title = models.CharField(max_length=80)
    summary = models.CharField(max_length=200, blank=True, default="")
    order = models.PositiveSmallIntegerField(default=0)
    is_published = models.BooleanField(default=True)

    class Meta:
        ordering = ["order", "id"]
        verbose_name = "Learning path"
        verbose_name_plural = "Learning paths"

    def __str__(self):
        return self.title

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.summary, "summary")


class OsintChallenge(models.Model):
    HOSTING_LINK_OUT = "link_out"
    HOSTING_HOSTED = "hosted"
    HOSTING_CHOICES = [(HOSTING_LINK_OUT, "Link out (other platform)"), (HOSTING_HOSTED, "Hosted by us (licence allows)")]

    TIER_FREE = "free"
    TIER_MEMBERS = "members"
    TIER_CHOICES = [(TIER_FREE, "Free directory"), (TIER_MEMBERS, "Members' labs (expert / professional)")]

    slug = models.SlugField(max_length=80, unique=True)
    title = models.CharField(max_length=140)
    summary = models.CharField(
        max_length=200, blank=True, default="", help_text="Our own one-line description. Never paste the source's text."
    )
    platform = models.CharField(max_length=60)
    url = models.URLField(max_length=500, help_text="Where the challenge lives (https).")
    difficulty = models.CharField(max_length=16, choices=DIFFICULTY_CHOICES, default=DIFFICULTY_EASY)
    skills = models.JSONField(blank=True, default=list, help_text='e.g. ["geolocation", "social media"]')
    estimated_minutes = models.PositiveSmallIntegerField(default=30)
    source_is_free = models.BooleanField(default=True, help_text="Free to play on the source platform.")
    hosting = models.CharField(max_length=12, choices=HOSTING_CHOICES, default=HOSTING_LINK_OUT)
    access_tier = models.CharField(max_length=12, choices=TIER_CHOICES, default=TIER_FREE)
    licence = models.CharField(max_length=24, choices=LICENCE_CHOICES, blank=True, default="")
    licence_url = models.URLField(max_length=500, blank=True, default="")
    attribution = models.CharField(max_length=300, blank=True, default="")
    source_repository = models.URLField(max_length=500, blank=True, default="")
    xp = models.PositiveSmallIntegerField(default=10)
    path = models.ForeignKey(OsintPath, on_delete=models.SET_NULL, blank=True, null=True, related_name="challenges")
    path_order = models.PositiveSmallIntegerField(default=0)
    flag_sha256 = models.CharField(
        max_length=64, blank=True, default="", help_text="Hosted challenges only: SHA-256 of the normalised flag."
    )
    is_published = models.BooleanField(default=True)
    link_checked_at = models.DateTimeField(blank=True, null=True)
    link_status = models.PositiveSmallIntegerField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["path__order", "path_order", "difficulty", "title"]
        indexes = [models.Index(fields=["access_tier", "is_published"], name="osint_chal_tier_pub_idx")]
        verbose_name = "OSINT challenge"
        verbose_name_plural = "OSINT challenges"

    def __str__(self):
        return f"{self.title} ({self.platform})"

    @property
    def cta_label(self):
        if self.hosting == self.HOSTING_HOSTED:
            return "Start here"
        return f"Start on {self.platform}"

    def clean(self):
        super().clean()
        for field in ("title", "summary", "platform", "attribution"):
            validate_no_active_content(getattr(self, field), field)
        errors = {}
        for field in ("url", "licence_url", "source_repository"):
            value = str(getattr(self, field) or "")
            if value and not value.startswith("https://"):
                errors[field] = "Use an https:// link."
        if not isinstance(self.skills, list) or any(not isinstance(item, str) for item in self.skills):
            errors["skills"] = "Enter a list of short skill names."
        else:
            self.skills = [" ".join(item.split())[:40] for item in self.skills if item.strip()][:8]
            for item in self.skills:
                validate_no_active_content(item, "skills")
        if self.hosting == self.HOSTING_HOSTED:
            if self.licence not in HOSTABLE_LICENCES:
                errors["licence"] = "Only MIT, Apache, BSD, CC BY or CC0 challenges may be hosted; link out instead."
            if not self.attribution:
                errors["attribution"] = "Hosted challenges need an attribution line."
        elif self.flag_sha256:
            errors["flag_sha256"] = "Only challenges we host can be checked with a flag."
        if self.access_tier == self.TIER_MEMBERS:
            if self.difficulty not in (DIFFICULTY_EXPERT, DIFFICULTY_PROFESSIONAL):
                errors["difficulty"] = "Members' labs are expert or professional only."
            if self.hosting == self.HOSTING_HOSTED and self.licence not in HOSTABLE_LICENCES:
                errors["licence"] = "Members' labs may only use challenges whose licence allows commercial use."
            if self.hosting == self.HOSTING_LINK_OUT and self.source_is_free is False:
                errors["source_is_free"] = "Never list another platform's paid content in members' labs."
        elif not self.source_is_free and self.hosting == self.HOSTING_LINK_OUT:
            errors["source_is_free"] = "The free directory lists only challenges that are free on the source."
        if errors:
            raise ValidationError(errors)


class OsintChallengeProgress(models.Model):
    METHOD_SELF = "self_reported"
    METHOD_FLAG = "flag"
    METHOD_CHOICES = [(METHOD_SELF, "Self-reported"), (METHOD_FLAG, "Flag checked")]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="osint_progress")
    challenge = models.ForeignKey(OsintChallenge, on_delete=models.CASCADE, related_name="progress")
    method = models.CharField(max_length=16, choices=METHOD_CHOICES, default=METHOD_SELF)
    completed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "challenge"], name="osint_progress_user_challenge_uniq")
        ]
        indexes = [models.Index(fields=["user", "completed_at"], name="osint_progress_user_done_idx")]
        verbose_name = "Challenge progress"
        verbose_name_plural = "Challenge progress"

    def __str__(self):
        return f"{self.user_id} done {self.challenge_id}"
