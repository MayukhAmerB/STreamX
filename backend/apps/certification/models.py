"""Certification storage.

* ``ExamCertificationPolicy``: marks a CTF exam as a CERTIFICATION exam and
  holds its admin-set pass mark (default 70 %) and optional per-section
  (question category) minimums.
* ``CertificationDecision``: one automatic pass/fail decision per student per
  exam (unique). Re-grading updates it in place (``revision`` + 1) and leaves
  a ``CertificationAudit`` row; a pass that turns into a fail is only flagged
  (``review_state``) until staff confirm the revocation.
* ``CertificationAudit``: append-only trail of decisions, re-grades,
  revocations and delivery resends.
* ``CertificateDelivery``: one row per certificate per channel (e-mail,
  WhatsApp) with an idempotency key, status, attempts and provider ids.
* ``CertificationPreferences``: the student's delivery channel, WhatsApp
  opt-out and Hall of Fame listing choice.
* ``HallOfFameEntry`` / ``HallOfFameAudit``: the public Hall of Fame. Public
  surfaces show the student's HANDLE only (owner rule): the linked user's
  live profile handle, else a staff-set ``display_handle``. ``legacy_name``
  keeps the manually curated name for staff and is never shown publicly.
"""

from __future__ import annotations

from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import Q
from django.utils import timezone

DEFAULT_PASS_MARK = Decimal("70.00")


class AppendOnlyError(RuntimeError):
    pass


class _AppendOnlyQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise AppendOnlyError("This audit trail is append-only.")

    def delete(self):
        raise AppendOnlyError("This audit trail is append-only.")


class _AppendOnlyModel(models.Model):
    objects = _AppendOnlyQuerySet.as_manager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if self.pk and not kwargs.get("force_insert"):
            raise AppendOnlyError("This audit trail is append-only.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AppendOnlyError("This audit trail is append-only.")


def _default_pass_mark():
    try:
        return Decimal(str(getattr(settings, "CERTIFICATION_DEFAULT_PASS_MARK", DEFAULT_PASS_MARK)))
    except Exception:  # noqa: BLE001
        return DEFAULT_PASS_MARK


class ExamCertificationPolicy(models.Model):
    exam = models.OneToOneField("ctf.CtfExam", on_delete=models.CASCADE, related_name="certification_policy")
    is_enabled = models.BooleanField(
        default=True, help_text="This is a certification exam: decide pass/fail automatically when a student finishes."
    )
    pass_mark_percent = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=_default_pass_mark,
        validators=[MinValueValidator(Decimal("0.01")), MaxValueValidator(Decimal("100"))],
        help_text="Minimum share of the exam's points needed to pass (percent).",
    )
    section_minimums = models.JSONField(
        default=dict,
        blank=True,
        help_text='Optional minimum percent per question category, e.g. {"geoint": 50, "socmint": 40}.',
    )
    certificate_type = models.CharField(
        max_length=8,
        default="OSINT",
        help_text="Reference number type: OSINT, PEN, COURSE or EXAM.",
    )
    certificate_title = models.CharField(
        max_length=200, blank=True, default="", help_text="Printed on the certificate. Empty: the exam title."
    )
    achievement_label = models.CharField(
        max_length=120, blank=True, default="", help_text="Shown in the Hall of Fame. Empty: 'Certified OSINT Investigator'."
    )
    auto_hall_of_fame = models.BooleanField(default=True, help_text="Add passing students to the Hall of Fame.")
    auto_deliver = models.BooleanField(default=True, help_text="E-mail / WhatsApp the certificate and letter on pass.")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        verbose_name = "certification exam policy"
        verbose_name_plural = "certification exam policies"
        constraints = [
            models.CheckConstraint(
                condition=Q(pass_mark_percent__gt=0) & Q(pass_mark_percent__lte=100), name="cert_policy_pass_mark_range"
            )
        ]

    def __str__(self):
        return f"{self.exam} · pass {self.pass_mark_percent}%"

    def clean(self):
        super().clean()
        from apps.ctf.models import CATEGORY_VALUES

        problems = []
        if not isinstance(self.section_minimums, dict):
            raise ValidationError({"section_minimums": "Use an object: category -> minimum percent."})
        for key, value in self.section_minimums.items():
            if key not in CATEGORY_VALUES:
                problems.append(f"Unknown category {key!r}.")
                continue
            try:
                number = Decimal(str(value))
            except Exception:  # noqa: BLE001
                problems.append(f"{key}: not a number.")
                continue
            if not Decimal("0") <= number <= Decimal("100"):
                problems.append(f"{key}: must be between 0 and 100.")
        if problems:
            raise ValidationError({"section_minimums": problems})
        if self.certificate_type not in {"OSINT", "PEN", "COURSE", "EXAM"}:
            raise ValidationError({"certificate_type": "Use OSINT, PEN, COURSE or EXAM."})


class CertificationDecision(models.Model):
    OUTCOME_PASSED = "passed"
    OUTCOME_FAILED = "failed"
    OUTCOME_CHOICES = [(OUTCOME_PASSED, "Passed"), (OUTCOME_FAILED, "Failed")]

    REVIEW_NONE = ""
    REVIEW_REVOCATION_PENDING = "revocation_pending"
    REVIEW_CHOICES = [(REVIEW_NONE, "None"), (REVIEW_REVOCATION_PENDING, "Re-grade fails: revocation awaits staff")]

    exam = models.ForeignKey("ctf.CtfExam", on_delete=models.CASCADE, related_name="certification_decisions")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="certification_decisions")
    participation = models.OneToOneField(
        "ctf.CtfParticipation", on_delete=models.SET_NULL, null=True, blank=True, related_name="certification_decision"
    )
    outcome = models.CharField(max_length=10, choices=OUTCOME_CHOICES)
    score = models.PositiveIntegerField(default=0)
    total_points = models.PositiveIntegerField(default=0)
    percent = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal("0"))
    band = models.CharField(max_length=20, blank=True, default="")
    sections = models.JSONField(default=dict, blank=True)
    reasons = models.JSONField(default=list, blank=True)
    pass_mark_percent = models.DecimalField(max_digits=5, decimal_places=2, help_text="Snapshot at decision time.")
    section_minimums = models.JSONField(default=dict, blank=True, help_text="Snapshot at decision time.")
    answer_key_id = models.CharField(max_length=16, blank=True, default="")
    revision = models.PositiveIntegerField(default=1)
    review_state = models.CharField(max_length=20, choices=REVIEW_CHOICES, blank=True, default=REVIEW_NONE)
    pending = models.JSONField(null=True, blank=True, help_text="Re-grade result awaiting staff confirmation.")
    certificate = models.OneToOneField(
        "engagement.Certificate",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="certification_decision",
    )
    decided_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-decided_at", "-id"]
        verbose_name = "certification decision"
        constraints = [
            models.UniqueConstraint(fields=["exam", "user"], name="cert_decision_exam_user_uniq"),
            models.CheckConstraint(condition=Q(outcome__in=["passed", "failed"]), name="cert_decision_outcome_valid"),
        ]
        indexes = [
            models.Index(fields=["exam", "outcome"], name="cert_decision_exam_idx"),
            models.Index(fields=["user", "decided_at"], name="cert_decision_user_idx"),
            models.Index(fields=["review_state"], name="cert_decision_review_idx", condition=~Q(review_state="")),
        ]

    def __str__(self):
        return f"{self.user_id} {self.exam_id}: {self.outcome} {self.percent}%"

    @property
    def passed(self) -> bool:
        return self.outcome == self.OUTCOME_PASSED


class CertificationAudit(_AppendOnlyModel):
    ACTION_DECIDED = "decided"
    ACTION_REGRADED = "regraded"
    ACTION_REGRADE_FLAGGED = "regrade_flagged"
    ACTION_REVOCATION_CONFIRMED = "revocation_confirmed"
    ACTION_REVOCATION_DISMISSED = "revocation_dismissed"
    ACTION_CERTIFICATE_ISSUED = "certificate_issued"
    ACTION_CERTIFICATE_REINSTATED = "certificate_reinstated"
    ACTION_DELIVERY_RESENT = "delivery_resent"
    ACTION_CHOICES = [
        (ACTION_DECIDED, "Decided automatically"),
        (ACTION_REGRADED, "Re-graded"),
        (ACTION_REGRADE_FLAGGED, "Re-grade fails: revocation flagged"),
        (ACTION_REVOCATION_CONFIRMED, "Revocation confirmed by staff"),
        (ACTION_REVOCATION_DISMISSED, "Revocation dismissed by staff"),
        (ACTION_CERTIFICATE_ISSUED, "Certificate issued"),
        (ACTION_CERTIFICATE_REINSTATED, "Certificate reinstated"),
        (ACTION_DELIVERY_RESENT, "Delivery resent"),
    ]

    decision = models.ForeignKey(CertificationDecision, on_delete=models.CASCADE, related_name="audit")
    action = models.CharField(max_length=24, choices=ACTION_CHOICES)
    outcome_before = models.CharField(max_length=10, blank=True, default="")
    outcome_after = models.CharField(max_length=10, blank=True, default="")
    percent_before = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    percent_after = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    detail = models.JSONField(default=dict, blank=True)
    reason = models.CharField(max_length=300, blank=True, default="")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    actor_email = models.EmailField(blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "certification audit entry"
        verbose_name_plural = "certification audit trail"
        indexes = [models.Index(fields=["decision", "created_at"], name="cert_audit_decision_idx")]

    def __str__(self):
        return f"{self.get_action_display()} ({self.decision_id})"


class CertificateDelivery(models.Model):
    CHANNEL_EMAIL = "email"
    CHANNEL_WHATSAPP = "whatsapp"
    CHANNEL_CHOICES = [(CHANNEL_EMAIL, "E-mail"), (CHANNEL_WHATSAPP, "WhatsApp")]

    STATUS_QUEUED = "queued"
    STATUS_SENT = "sent"
    STATUS_RETRYING = "retrying"
    STATUS_FAILED = "failed"
    STATUS_SKIPPED = "skipped"
    STATUS_CHOICES = [
        (STATUS_QUEUED, "Queued"),
        (STATUS_SENT, "Sent"),
        (STATUS_RETRYING, "Retrying"),
        (STATUS_FAILED, "Failed"),
        (STATUS_SKIPPED, "Not sent (see reason)"),
    ]

    decision = models.ForeignKey(CertificationDecision, on_delete=models.CASCADE, related_name="deliveries")
    certificate = models.ForeignKey("engagement.Certificate", on_delete=models.PROTECT, related_name="deliveries")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    channel = models.CharField(max_length=10, choices=CHANNEL_CHOICES)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_QUEUED)
    skip_reason = models.CharField(max_length=40, blank=True, default="")
    idempotency_key = models.CharField(max_length=80, unique=True, editable=False)
    round = models.PositiveIntegerField(default=1, help_text="1 = automatic send; each staff resend adds 1.")
    attempts = models.PositiveIntegerField(default=0)
    destination_hint = models.CharField(max_length=80, blank=True, default="", help_text="Masked address / number.")
    provider_message_id = models.CharField(max_length=200, blank=True, default="")
    provider_parts = models.JSONField(default=dict, blank=True, help_text="WhatsApp message id per document sent.")
    last_error = models.TextField(blank=True, default="")
    queued_at = models.DateTimeField(default=timezone.now)
    sent_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-queued_at", "-id"]
        verbose_name = "certificate delivery"
        verbose_name_plural = "certificate deliveries"
        constraints = [
            models.UniqueConstraint(fields=["certificate", "channel"], name="cert_delivery_cert_channel_uniq"),
            models.CheckConstraint(condition=Q(channel__in=["email", "whatsapp"]), name="cert_delivery_channel_valid"),
        ]
        indexes = [models.Index(fields=["status", "queued_at"], name="cert_delivery_status_idx")]

    def __str__(self):
        return f"{self.idempotency_key} [{self.status}]"


class CertificationPreferences(models.Model):
    CHANNEL_BOTH = "both"
    CHANNEL_EMAIL = "email"
    CHANNEL_WHATSAPP = "whatsapp"
    CHANNEL_CHOICES = [(CHANNEL_BOTH, "E-mail and WhatsApp"), (CHANNEL_EMAIL, "E-mail only"), (CHANNEL_WHATSAPP, "WhatsApp only")]

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="certification_preferences"
    )
    delivery_channel = models.CharField(max_length=10, choices=CHANNEL_CHOICES, default=CHANNEL_BOTH)
    whatsapp_opt_out = models.BooleanField(default=False, help_text="Never send WhatsApp messages to this student.")
    hall_of_fame_listed = models.BooleanField(default=True, help_text="Show this student's handle in the Hall of Fame.")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "certification preferences"
        verbose_name_plural = "certification preferences"

    def __str__(self):
        return f"{self.user_id}: {self.delivery_channel}"


class HallOfFameEntry(models.Model):
    SOURCE_MANUAL = "manual"
    SOURCE_AUTO = "auto"
    SOURCE_CHOICES = [(SOURCE_MANUAL, "Curated by staff"), (SOURCE_AUTO, "Added on certification")]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="hall_of_fame_entries",
        help_text="The student. Their live profile handle is shown publicly.",
    )
    display_handle = models.CharField(
        max_length=40, blank=True, default="",
        help_text="Public handle to show when the entry has no linked user with a profile. Never a real name.",
    )
    legacy_name = models.CharField(
        max_length=160, blank=True, default="", help_text="Name from the curated list (staff only, never public)."
    )
    batch_label = models.CharField(max_length=80, blank=True, default="")
    batch_order = models.IntegerField(default=0, help_text="Higher = newer batch (wall order).")
    position = models.PositiveIntegerField(default=0)
    achievement = models.CharField(max_length=160, default="Certified OSINT Investigator")
    achieved_on = models.DateField(null=True, blank=True)
    band = models.CharField(max_length=20, blank=True, default="")
    percent = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True, editable=False)
    certificate = models.OneToOneField(
        "engagement.Certificate", on_delete=models.PROTECT, null=True, blank=True, related_name="hall_of_fame_entry"
    )
    decision = models.OneToOneField(
        CertificationDecision, on_delete=models.SET_NULL, null=True, blank=True, related_name="hall_of_fame_entry"
    )
    source = models.CharField(max_length=10, choices=SOURCE_CHOICES, default=SOURCE_MANUAL)
    seed_key = models.CharField(max_length=64, blank=True, default="", editable=False)
    is_hidden = models.BooleanField(default=False)
    hidden_reason = models.CharField(max_length=300, blank=True, default="")
    hidden_at = models.DateTimeField(null=True, blank=True)
    hidden_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-batch_order", "position", "id"]
        verbose_name = "Hall of Fame entry"
        verbose_name_plural = "Hall of Fame entries"
        constraints = [
            models.UniqueConstraint(fields=["seed_key"], condition=~Q(seed_key=""), name="hof_seed_key_uniq"),
        ]
        indexes = [
            models.Index(fields=["is_hidden", "batch_order", "position"], name="hof_wall_idx"),
            models.Index(fields=["is_hidden", "achieved_on"], name="hof_recent_idx"),
        ]

    def __str__(self):
        return self.display_handle or self.legacy_name or f"entry {self.pk}"


class HallOfFameAudit(_AppendOnlyModel):
    ACTION_ADDED = "added"
    ACTION_MERGED = "merged"
    ACTION_HIDDEN = "hidden"
    ACTION_RESTORED = "restored"
    ACTION_HANDLE_SET = "handle_set"
    ACTION_CHOICES = [
        (ACTION_ADDED, "Added"),
        (ACTION_MERGED, "Merged with a curated entry"),
        (ACTION_HIDDEN, "Hidden by staff"),
        (ACTION_RESTORED, "Restored by staff"),
        (ACTION_HANDLE_SET, "Display handle set"),
    ]

    entry = models.ForeignKey(HallOfFameEntry, on_delete=models.CASCADE, related_name="audit")
    action = models.CharField(max_length=16, choices=ACTION_CHOICES)
    reason = models.CharField(max_length=300, blank=True, default="")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    actor_email = models.EmailField(blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "Hall of Fame audit entry"
        verbose_name_plural = "Hall of Fame audit trail"

    def __str__(self):
        return f"{self.get_action_display()} ({self.entry_id})"
