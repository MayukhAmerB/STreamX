"""OSINT CTF examinations.

* ``CtfExam``: one examination (window, time limit, eligible batches). Its
  content is loaded from a private JSON file by ``manage.py load_ctf_exam``;
  plaintext answers never reach the database or the repository.
* ``CtfQuestion``: one challenge. ``answer_hashes`` holds peppered HMACs of
  the accepted answers (see ``answers.py``); it is never serialised and never
  shown in the admin.
* ``CtfParticipation``: one per student per exam. Holds the running score and
  is the row that is locked while an answer is recorded. Indexed for the
  per-batch leaderboard.
* ``CtfAttempt``: one row per evaluated answer, right or wrong. Append-only:
  rows cannot be updated or deleted through the ORM, and a partial unique
  constraint guarantees a question scores at most once per participation.
"""

from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import F, Q
from django.utils import timezone

CATEGORY_CHOICES = [
    ("socmint", "SOCMINT (social media)"),
    ("geoint", "GEOINT (geolocation)"),
    ("chronolocation", "Chronolocation"),
    ("imint", "IMINT (imagery)"),
    ("dorking", "Search-engine dorking"),
    ("orgint", "Organisational intelligence"),
    ("techint", "Technical / infrastructure"),
    ("archives", "Web archives"),
    ("transport", "Transport (aviation, maritime, rail)"),
    ("finint", "Financial and corporate records"),
    ("people", "People search"),
    ("crypto", "Crypto / blockchain"),
]
CATEGORY_VALUES = [value for value, _label in CATEGORY_CHOICES]

DIFFICULTY_CHOICES = [
    ("medium", "Medium"),
    ("hard", "Hard"),
    ("expert", "Expert"),
    ("insane", "Insane"),
]
DIFFICULTY_VALUES = [value for value, _label in DIFFICULTY_CHOICES]

MAX_ANSWER_LENGTH = 512
DEFAULT_MAX_ATTEMPTS = 10
MAX_ATTEMPTS_CAP = 100


class AppendOnlyError(RuntimeError):
    """Raised when code tries to change or delete a recorded attempt."""


class CtfExam(models.Model):
    STATUS_DRAFT = "draft"
    STATUS_PUBLISHED = "published"
    STATUS_CLOSED = "closed"
    STATUS_CHOICES = [
        (STATUS_DRAFT, "Draft"),
        (STATUS_PUBLISHED, "Published"),
        (STATUS_CLOSED, "Closed"),
    ]

    WINDOW_NOT_OPEN = "not_open"
    WINDOW_OPEN = "open"
    WINDOW_CLOSED = "closed"
    WINDOW_CHOICES = [
        (WINDOW_NOT_OPEN, "Not open yet"),
        (WINDOW_OPEN, "Open"),
        (WINDOW_CLOSED, "Closed"),
    ]

    slug = models.SlugField(max_length=80, unique=True)
    title = models.CharField(max_length=200)
    title_ur = models.CharField(max_length=200, blank=True, default="")
    briefing = models.JSONField(default=dict, blank=True, help_text='{"en": [paragraphs], "ur": [paragraphs]}')
    rules = models.JSONField(default=dict, blank=True, help_text='{"en": [rules], "ur": [rules]}')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_DRAFT)
    opens_at = models.DateTimeField(null=True, blank=True, help_text="Students can start from this time.")
    closes_at = models.DateTimeField(
        null=True, blank=True, help_text="No answers are accepted after this time, whatever the time limit."
    )
    time_limit_minutes = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(1), MaxValueValidator(24 * 60)],
        help_text="Minutes each student has after pressing Start. Empty: until the exam closes.",
    )
    default_max_attempts = models.PositiveSmallIntegerField(
        default=DEFAULT_MAX_ATTEMPTS,
        validators=[MinValueValidator(1), MaxValueValidator(MAX_ATTEMPTS_CAP)],
        help_text="Answers allowed per question unless the question sets its own limit.",
    )
    eligible_courses = models.ManyToManyField(
        "courses.Course",
        blank=True,
        related_name="ctf_exams",
        help_text="Batches (courses) whose students may sit this exam. Empty: no student can.",
    )
    content_sha256 = models.CharField(max_length=64, blank=True, default="", editable=False)
    answer_key_id = models.CharField(
        max_length=16,
        blank=True,
        default="",
        editable=False,
        help_text="Fingerprint of the answer pepper the answers were hashed with.",
    )
    content_loaded_at = models.DateTimeField(null=True, blank=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-opens_at", "-id")
        verbose_name = "CTF exam"
        verbose_name_plural = "CTF exams"
        indexes = [models.Index(fields=["status", "opens_at"], name="ctf_exam_status_opens_idx")]
        constraints = [
            models.CheckConstraint(
                condition=Q(opens_at__isnull=True) | Q(closes_at__isnull=True) | Q(closes_at__gt=F("opens_at")),
                name="ctf_exam_closes_after_opens",
            ),
            models.CheckConstraint(
                condition=Q(time_limit_minutes__isnull=True) | Q(time_limit_minutes__gt=0),
                name="ctf_exam_time_limit_positive",
            ),
            models.CheckConstraint(condition=Q(default_max_attempts__gt=0), name="ctf_exam_max_attempts_positive"),
            models.CheckConstraint(
                condition=Q(status__in=["draft", "published", "closed"]), name="ctf_exam_status_valid"
            ),
        ]

    def __str__(self):
        return f"{self.title} ({self.slug})"

    def clean(self):
        super().clean()
        if self.opens_at and self.closes_at and self.closes_at <= self.opens_at:
            raise ValidationError({"closes_at": "The exam must close after it opens."})

    def window(self, at=None):
        at = at or timezone.now()
        if self.status == self.STATUS_CLOSED or (self.closes_at and at >= self.closes_at):
            return self.WINDOW_CLOSED
        if self.status != self.STATUS_PUBLISHED or (self.opens_at and at < self.opens_at):
            return self.WINDOW_NOT_OPEN
        return self.WINDOW_OPEN

    def deadline_for(self, started_at, *, ignore_closes_at=False):
        """When a participation started at ``started_at`` must stop answering."""
        candidates = []
        if self.time_limit_minutes:
            candidates.append(started_at + timedelta(minutes=self.time_limit_minutes))
        if self.closes_at and not ignore_closes_at:
            candidates.append(self.closes_at)
        return min(candidates) if candidates else None


class CtfQuestion(models.Model):
    exam = models.ForeignKey(CtfExam, on_delete=models.CASCADE, related_name="questions")
    key = models.SlugField(max_length=64, help_text="Stable id from the exam file.")
    order = models.PositiveSmallIntegerField()
    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES)
    difficulty = models.CharField(max_length=10, choices=DIFFICULTY_CHOICES)
    points = models.PositiveIntegerField(validators=[MinValueValidator(1)])
    title = models.JSONField(default=dict, blank=True)
    prompt = models.JSONField(default=dict, blank=True)
    materials = models.JSONField(default=list, blank=True)
    # Never serialised, never shown in the admin.
    normalization = models.JSONField(default=list, blank=True)
    answer_hashes = models.JSONField(default=list, blank=True)
    max_attempts = models.PositiveSmallIntegerField(
        null=True,
        blank=True,
        validators=[MinValueValidator(1), MaxValueValidator(MAX_ATTEMPTS_CAP)],
        help_text="Overrides the exam default when set.",
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("exam", "order", "id")
        verbose_name = "CTF question"
        verbose_name_plural = "CTF questions"
        constraints = [
            models.UniqueConstraint(fields=["exam", "key"], name="ctf_question_exam_key_unique"),
            # Retired (inactive) questions keep their old order; only the live
            # questions of an exam need distinct positions.
            models.UniqueConstraint(
                fields=["exam", "order"], condition=Q(is_active=True), name="ctf_question_active_order_unique"
            ),
            models.CheckConstraint(condition=Q(points__gt=0), name="ctf_question_points_positive"),
            models.CheckConstraint(
                condition=Q(max_attempts__isnull=True) | Q(max_attempts__gt=0),
                name="ctf_question_max_attempts_positive",
            ),
            models.CheckConstraint(condition=Q(difficulty__in=DIFFICULTY_VALUES), name="ctf_question_difficulty_valid"),
            models.CheckConstraint(condition=Q(category__in=CATEGORY_VALUES), name="ctf_question_category_valid"),
        ]

    def __str__(self):
        return f"Q{self.order} {self.title_en or self.key}"

    @property
    def title_en(self):
        return str((self.title or {}).get("en") or "")

    def effective_max_attempts(self, exam=None):
        exam = exam or self.exam
        return int(self.max_attempts or exam.default_max_attempts or DEFAULT_MAX_ATTEMPTS)


class CtfParticipation(models.Model):
    STATUS_ACTIVE = "active"
    STATUS_SUBMITTED = "submitted"
    STATUS_EXPIRED = "expired"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "In progress"),
        (STATUS_SUBMITTED, "Submitted"),
        (STATUS_EXPIRED, "Time over"),
    ]

    exam = models.ForeignKey(CtfExam, on_delete=models.CASCADE, related_name="participations")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="ctf_participations")
    batch_course = models.ForeignKey(
        "courses.Course",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ctf_participations",
        help_text="The student's batch when they started (for per-batch leaderboards).",
    )
    is_staff_preview = models.BooleanField(default=False, help_text="Staff test run; left out of rankings.")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    started_at = models.DateTimeField(default=timezone.now)
    deadline_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    score = models.PositiveIntegerField(default=0)
    solved_count = models.PositiveIntegerField(default=0)
    wrong_count = models.PositiveIntegerField(default=0)
    attempt_count = models.PositiveIntegerField(default=0)
    last_correct_at = models.DateTimeField(null=True, blank=True, help_text="Leaderboard tie-break.")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "CTF participation"
        verbose_name_plural = "CTF participations (scores)"
        constraints = [
            models.UniqueConstraint(fields=["exam", "user"], name="ctf_participation_exam_user_unique"),
            models.CheckConstraint(
                condition=Q(status__in=["active", "submitted", "expired"]), name="ctf_participation_status_valid"
            ),
        ]
        indexes = [
            models.Index(
                "exam", "batch_course", F("score").desc(), "last_correct_at", name="ctf_part_batch_board_idx"
            ),
            models.Index("exam", F("score").desc(), "last_correct_at", name="ctf_part_board_idx"),
            models.Index(fields=["user", "exam"], name="ctf_part_user_exam_idx"),
        ]

    def __str__(self):
        return f"{self.user} - {self.exam.slug}"

    def deadline_passed(self, at=None):
        return bool(self.deadline_at and (at or timezone.now()) >= self.deadline_at)


class CtfAttemptQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise AppendOnlyError("CTF attempts are append-only and cannot be updated.")

    def delete(self):
        raise AppendOnlyError("CTF attempts are append-only and cannot be deleted.")


class CtfAttempt(models.Model):
    participation = models.ForeignKey(CtfParticipation, on_delete=models.CASCADE, related_name="attempts")
    exam = models.ForeignKey(CtfExam, on_delete=models.CASCADE, related_name="attempts")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="ctf_attempts")
    question = models.ForeignKey(CtfQuestion, on_delete=models.PROTECT, related_name="attempts")
    attempt_number = models.PositiveSmallIntegerField()
    submitted_answer = models.CharField(max_length=MAX_ANSWER_LENGTH, help_text="Exactly as the student typed it.")
    normalized_answer = models.CharField(max_length=MAX_ANSWER_LENGTH, blank=True, default="")
    is_correct = models.BooleanField(default=False)
    points_awarded = models.PositiveIntegerField(default=0)
    client_ip_hash = models.CharField(max_length=64, blank=True, default="")
    user_agent = models.CharField(max_length=256, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    objects = CtfAttemptQuerySet.as_manager()

    class Meta:
        ordering = ("-created_at", "-id")
        verbose_name = "CTF attempt"
        verbose_name_plural = "CTF attempts (every answer)"
        constraints = [
            models.UniqueConstraint(
                fields=["participation", "question", "attempt_number"], name="ctf_attempt_number_unique"
            ),
            models.UniqueConstraint(
                fields=["participation", "question"], condition=Q(is_correct=True), name="ctf_attempt_one_correct"
            ),
            models.CheckConstraint(
                condition=Q(points_awarded=0) | Q(is_correct=True), name="ctf_attempt_points_only_when_correct"
            ),
            models.CheckConstraint(condition=Q(attempt_number__gt=0), name="ctf_attempt_number_positive"),
        ]
        indexes = [
            models.Index(fields=["exam", "question", "is_correct"], name="ctf_attempt_question_idx"),
            models.Index(fields=["exam", "user", "created_at"], name="ctf_attempt_user_time_idx"),
            models.Index(fields=["exam", "created_at"], name="ctf_attempt_exam_time_idx"),
        ]

    def __str__(self):
        return f"{self.user} Q{self.question_id} #{self.attempt_number}"

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise AppendOnlyError("CTF attempts are append-only and cannot be changed.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AppendOnlyError("CTF attempts are append-only and cannot be deleted.")
