"""Weekly report tasks ("targets"), student submissions and marking.

* ``ReportTask``: one weekly target per course (optionally tied to a module /
  week) with its brief, deadline, late policy, marks and file rules.
* ``ReportSubmission``: one per student per task; every (re)submission is an
  immutable ``ReportSubmissionVersion`` with its own files, so the full
  history stays auditable. ``revision`` is the optimistic-concurrency token
  graders must echo back.
* ``ReportFile``: a stored file (private storage, random name). Uploaded files
  are *staged* (``submitted=False``) until the student submits them.
* ``ReportGrade`` + ``ReportGradeAudit``: the marks and every change to them.
* ``ReportQuarantineRecord``: metadata (never the bytes) of every file the
  virus scanner blocked at upload or found later on a re-scan.

Every stored file carries its virus-scan record (``scan_status``,
``scanned_at``, ``scanner``, ``scan_signature_version``); downloads refuse
anything that is not ``clean``. See SECURITY.md.
"""

from __future__ import annotations

import math
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

from .storage import (
    attachment_upload_to,
    feedback_file_upload_to,
    private_report_storage,
    submission_file_upload_to,
)

TWO_PLACES = Decimal("0.01")
MINUTES_PER_DAY = 24 * 60

GRADE_ACTION_DRAFT = "draft"
GRADE_ACTION_GRADE = "grade"
GRADE_ACTION_RETURN = "return"
GRADE_ACTION_CHOICES = [
    (GRADE_ACTION_DRAFT, "Save draft (under review)"),
    (GRADE_ACTION_GRADE, "Save marks (graded)"),
    (GRADE_ACTION_RETURN, "Return for revision"),
]


SCAN_UNSCANNED = "unscanned"
SCAN_CLEAN = "clean"
SCAN_INFECTED = "infected"
SCAN_STATUS_CHOICES = [
    (SCAN_UNSCANNED, "Not scanned yet"),
    (SCAN_CLEAN, "Clean"),
    (SCAN_INFECTED, "Infected (quarantined)"),
]


def quantize_marks(value):
    return Decimal(value).quantize(TWO_PLACES, rounding=ROUND_HALF_UP)


class ReportTask(models.Model):
    STATUS_DRAFT = "draft"
    STATUS_PUBLISHED = "published"
    STATUS_CLOSED = "closed"
    STATUS_CHOICES = [
        (STATUS_DRAFT, "Draft"),
        (STATUS_PUBLISHED, "Published"),
        (STATUS_CLOSED, "Closed"),
    ]
    LATE_NOT_ALLOWED = "no_late"
    LATE_ALLOWED = "allow_late"
    LATE_POLICY_CHOICES = [
        (LATE_NOT_ALLOWED, "No late submissions"),
        (LATE_ALLOWED, "Allow late submissions until a cut-off"),
    ]
    MARKS_ON_GRADE = "on_grade"
    MARKS_ON_RELEASE = "on_release"
    MARKS_VISIBILITY_CHOICES = [
        (MARKS_ON_GRADE, "Show each student's marks as soon as they are graded"),
        (MARKS_ON_RELEASE, "Release all marks together"),
    ]

    course = models.ForeignKey("courses.Course", on_delete=models.CASCADE, related_name="report_tasks")
    section = models.ForeignKey(
        "courses.Section",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="report_tasks",
        help_text="Optional module this weekly target belongs to.",
    )
    week_number = models.PositiveSmallIntegerField(null=True, blank=True)
    title = models.CharField(max_length=200, help_text="The weekly target, e.g. the person or company to investigate.")
    brief = models.TextField(blank=True, default="", help_text="Instructions in Markdown (rendered safely).")
    opens_at = models.DateTimeField(
        null=True, blank=True, help_text="Hidden from students until then. Empty: on publish."
    )
    due_at = models.DateTimeField()
    late_policy = models.CharField(max_length=20, choices=LATE_POLICY_CHOICES, default=LATE_NOT_ALLOWED)
    late_until = models.DateTimeField(null=True, blank=True, help_text="Late submissions accepted until this time.")
    late_penalty_percent_per_day = models.DecimalField(
        max_digits=5,
        decimal_places=2,
        default=Decimal("0.00"),
        validators=[MinValueValidator(Decimal("0")), MaxValueValidator(Decimal("100"))],
        help_text="Percent of the maximum marks deducted per started day late (0 = no penalty).",
    )
    max_marks = models.DecimalField(
        max_digits=6,
        decimal_places=2,
        default=Decimal("10.00"),
        validators=[MinValueValidator(Decimal("0.01"))],
    )
    allowed_file_types = models.JSONField(
        default=list, blank=True, help_text="Allowed file extensions; empty allows every supported type."
    )
    max_files = models.PositiveSmallIntegerField(default=5, validators=[MinValueValidator(1)])
    max_file_size_mb = models.PositiveIntegerField(default=50, validators=[MinValueValidator(1)])
    max_total_size_mb = models.PositiveIntegerField(default=200, validators=[MinValueValidator(1)])
    marks_visibility = models.CharField(max_length=20, choices=MARKS_VISIBILITY_CHOICES, default=MARKS_ON_GRADE)
    marks_released_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_DRAFT)
    published_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    reminder_sent_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_report_tasks",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-due_at", "-id"]
        indexes = [
            models.Index(fields=["course", "status", "due_at"]),
            models.Index(fields=["status", "due_at"]),
        ]
        verbose_name = "report task"

    def __str__(self):
        return f"{self.title} ({self.course_id})"

    # --- deadlines -------------------------------------------------------
    @property
    def allows_late(self):
        return self.late_policy == self.LATE_ALLOWED and bool(self.late_until) and self.late_until > self.due_at

    @property
    def accepting_until(self):
        """Last moment a (late) submission is accepted."""
        return self.late_until if self.allows_late else self.due_at

    def is_open_for_students(self, at=None):
        at = at or timezone.now()
        return self.status in (self.STATUS_PUBLISHED, self.STATUS_CLOSED) and (
            self.opens_at is None or self.opens_at <= at
        )

    def minutes_late(self, at):
        if not self.due_at or at <= self.due_at:
            return 0
        return int(math.ceil((at - self.due_at).total_seconds() / 60.0))

    def late_penalty_for(self, minutes_late, raw_marks):
        """Penalty in marks: percent of max marks per started day, never more than the marks."""
        if raw_marks is None or minutes_late <= 0 or not self.late_penalty_percent_per_day:
            return Decimal("0.00")
        days = int(math.ceil(minutes_late / float(MINUTES_PER_DAY)))
        penalty = Decimal(self.max_marks) * Decimal(self.late_penalty_percent_per_day) / Decimal(100) * days
        return quantize_marks(min(Decimal(raw_marks), penalty))

    @property
    def allowed_extensions(self):
        from config.upload_validators import REPORT_ALLOWED_EXTENSIONS

        chosen = {str(value).lower().lstrip(".") for value in (self.allowed_file_types or [])}
        if "jpg" in chosen or "jpeg" in chosen:
            chosen |= {"jpg", "jpeg"}
        allowed = [value for value in REPORT_ALLOWED_EXTENSIONS if not chosen or value in chosen]
        return allowed or list(REPORT_ALLOWED_EXTENSIONS)

    @property
    def max_file_bytes(self):
        cap = int(getattr(settings, "REPORTS_MAX_FILE_SIZE_MB_CAP", 200))
        return min(max(1, int(self.max_file_size_mb or 1)), cap) * 1024 * 1024

    @property
    def max_total_bytes(self):
        return max(int(self.max_total_size_mb or 1) * 1024 * 1024, self.max_file_bytes)

    @property
    def marks_released(self):
        return self.marks_visibility == self.MARKS_ON_GRADE or self.marks_released_at is not None

    def reminder_due_at(self):
        return self.due_at - timedelta(hours=24)


class ReportCriterion(models.Model):
    task = models.ForeignKey(ReportTask, on_delete=models.CASCADE, related_name="criteria")
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    max_marks = models.DecimalField(max_digits=6, decimal_places=2, validators=[MinValueValidator(Decimal("0.01"))])
    order = models.PositiveSmallIntegerField(default=1)

    class Meta:
        ordering = ["order", "id"]
        verbose_name = "rubric criterion"
        verbose_name_plural = "rubric criteria"

    def __str__(self):
        return f"{self.name} ({self.max_marks})"


class ReportAttachment(models.Model):
    """Reference material the instructor attaches to a task."""

    task = models.ForeignKey(ReportTask, on_delete=models.CASCADE, related_name="attachments")
    file = models.FileField(storage=private_report_storage, upload_to=attachment_upload_to, max_length=255)
    original_name = models.CharField(max_length=255)
    extension = models.CharField(max_length=16)
    content_type = models.CharField(max_length=120)
    size = models.PositiveBigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True, default="")
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    scan_status = models.CharField(
        max_length=16,
        choices=SCAN_STATUS_CHOICES,
        default=SCAN_UNSCANNED,
        help_text="Only clean files can be downloaded.",
    )
    scanned_at = models.DateTimeField(null=True, blank=True)
    scanner = models.CharField(max_length=64, blank=True, default="")
    scan_signature_version = models.CharField(max_length=128, blank=True, default="")
    scan_threat = models.CharField(max_length=255, blank=True, default="", help_text="Signature found on a re-scan.")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]
        verbose_name = "reference attachment"

    def __str__(self):
        return self.original_name


class ReportFile(models.Model):
    """A student's uploaded file. Staged until submitted; never deleted once submitted."""

    task = models.ForeignKey(ReportTask, on_delete=models.CASCADE, related_name="files")
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="report_files")
    file = models.FileField(storage=private_report_storage, upload_to=submission_file_upload_to, max_length=255)
    original_name = models.CharField(max_length=255)
    extension = models.CharField(max_length=16)
    content_type = models.CharField(max_length=120)
    size = models.PositiveBigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True, default="")
    submitted = models.BooleanField(default=False)
    scan_status = models.CharField(
        max_length=16,
        choices=SCAN_STATUS_CHOICES,
        default=SCAN_UNSCANNED,
        help_text="Only clean files can be downloaded.",
    )
    scanned_at = models.DateTimeField(null=True, blank=True)
    scanner = models.CharField(max_length=64, blank=True, default="")
    scan_signature_version = models.CharField(max_length=128, blank=True, default="")
    scan_threat = models.CharField(max_length=255, blank=True, default="", help_text="Signature found on a re-scan.")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(fields=["task", "owner", "submitted"]),
            models.Index(fields=["submitted", "created_at"]),
        ]
        verbose_name = "report file"

    def __str__(self):
        return self.original_name


class ReportSubmission(models.Model):
    STATUS_NOT_SUBMITTED = "not_submitted"
    STATUS_SUBMITTED = "submitted"
    STATUS_UNDER_REVIEW = "under_review"
    STATUS_GRADED = "graded"
    STATUS_RETURNED = "returned_for_revision"
    STATUS_RESUBMITTED = "resubmitted"
    STATUS_CHOICES = [
        (STATUS_NOT_SUBMITTED, "Not submitted"),
        (STATUS_SUBMITTED, "Submitted"),
        (STATUS_UNDER_REVIEW, "Under review"),
        (STATUS_GRADED, "Graded"),
        (STATUS_RETURNED, "Returned for revision"),
        (STATUS_RESUBMITTED, "Resubmitted"),
    ]
    AWAITING_GRADING = (STATUS_SUBMITTED, STATUS_RESUBMITTED, STATUS_UNDER_REVIEW)

    task = models.ForeignKey(ReportTask, on_delete=models.CASCADE, related_name="submissions")
    student = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="report_submissions")
    status = models.CharField(max_length=24, choices=STATUS_CHOICES, default=STATUS_NOT_SUBMITTED)
    current_version = models.ForeignKey(
        "ReportSubmissionVersion", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    version_count = models.PositiveIntegerField(default=0)
    first_submitted_at = models.DateTimeField(null=True, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True, help_text="When the current version was submitted.")
    is_late = models.BooleanField(default=False)
    minutes_late = models.PositiveIntegerField(default=0)
    revision = models.PositiveIntegerField(
        default=1, help_text="Optimistic-concurrency token; bumped by every submission and grading change."
    )
    late_digest_sent_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-submitted_at", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["task", "student"], name="reports_submission_task_student_unique"),
        ]
        indexes = [
            models.Index(fields=["task", "status"]),
            models.Index(fields=["student", "status"]),
        ]
        verbose_name = "report submission"

    def __str__(self):
        return f"{self.student_id} -> {self.task_id} ({self.status})"


class ReportSubmissionVersion(models.Model):
    submission = models.ForeignKey(ReportSubmission, on_delete=models.CASCADE, related_name="versions")
    number = models.PositiveIntegerField()
    note = models.TextField(blank=True, default="")
    files = models.ManyToManyField(ReportFile, related_name="versions", blank=True)
    submitted_at = models.DateTimeField(default=timezone.now)
    is_late = models.BooleanField(default=False)
    minutes_late = models.PositiveIntegerField(default=0)
    is_revision = models.BooleanField(default=False, help_text="Sent after the report was returned for revision.")
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-number"]
        constraints = [
            models.UniqueConstraint(fields=["submission", "number"], name="reports_version_submission_number_unique"),
        ]
        verbose_name = "submission version"

    def __str__(self):
        return f"v{self.number} of {self.submission_id}"


class ReportGrade(models.Model):
    submission = models.OneToOneField(ReportSubmission, on_delete=models.CASCADE, related_name="grade")
    raw_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    late_penalty = models.DecimalField(max_digits=6, decimal_places=2, default=Decimal("0.00"))
    final_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    criteria_marks = models.JSONField(default=dict, blank=True, help_text='{"<criterion id>": "4.50"}')
    feedback = models.TextField(blank=True, default="", help_text="Shown with the marks.")
    revision_feedback = models.TextField(blank=True, default="", help_text="What to fix; shown when returned.")
    annotated_file = models.FileField(
        storage=private_report_storage, upload_to=feedback_file_upload_to, max_length=255, null=True, blank=True
    )
    annotated_file_name = models.CharField(max_length=255, blank=True, default="")
    annotated_extension = models.CharField(max_length=16, blank=True, default="")
    annotated_content_type = models.CharField(max_length=120, blank=True, default="")
    annotated_file_size = models.PositiveBigIntegerField(default=0)
    annotated_scan_status = models.CharField(max_length=16, choices=SCAN_STATUS_CHOICES, default=SCAN_UNSCANNED)
    annotated_scanned_at = models.DateTimeField(null=True, blank=True)
    annotated_scanner = models.CharField(max_length=64, blank=True, default="")
    annotated_scan_signature_version = models.CharField(max_length=128, blank=True, default="")
    annotated_scan_threat = models.CharField(max_length=255, blank=True, default="")
    graded_version = models.ForeignKey(
        ReportSubmissionVersion, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    graded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    graded_at = models.DateTimeField(null=True, blank=True)
    returned_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "report grade"

    def __str__(self):
        return f"{self.final_marks} for {self.submission_id}"


class ReportGradeAudit(models.Model):
    ACTION_DRAFT_SAVED = "draft_saved"
    ACTION_GRADED = "graded"
    ACTION_REGRADED = "regraded"
    ACTION_RETURNED = "returned"
    ACTION_MARKS_RELEASED = "marks_released"
    ACTION_CHOICES = [
        (ACTION_DRAFT_SAVED, "Draft saved"),
        (ACTION_GRADED, "Graded"),
        (ACTION_REGRADED, "Marks changed"),
        (ACTION_RETURNED, "Returned for revision"),
        (ACTION_MARKS_RELEASED, "Marks released"),
    ]

    submission = models.ForeignKey(ReportSubmission, on_delete=models.CASCADE, related_name="audit_entries")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    action = models.CharField(max_length=32, choices=ACTION_CHOICES)
    from_status = models.CharField(max_length=24, blank=True, default="")
    to_status = models.CharField(max_length=24, blank=True, default="")
    old_final_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    new_final_marks = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    details = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "grade audit entry"
        verbose_name_plural = "grade audit log"

    def __str__(self):
        return f"{self.get_action_display()} on {self.submission_id}"


class ReportQuarantineRecord(models.Model):
    """A file the virus scanner blocked. Metadata only: the bytes are never kept
    for an upload, and a stored file found infected later sits in the
    quarantine directory (mode 000) named by ``quarantine_name``."""

    SOURCE_UPLOAD = "upload"
    SOURCE_RESCAN = "rescan"
    SOURCE_CHOICES = [(SOURCE_UPLOAD, "Blocked at upload"), (SOURCE_RESCAN, "Found by a re-scan")]
    KIND_SUBMISSION = "submission"
    KIND_ATTACHMENT = "attachment"
    KIND_FEEDBACK = "feedback"
    KIND_CHOICES = [
        (KIND_SUBMISSION, "Student report file"),
        (KIND_ATTACHMENT, "Task reference file"),
        (KIND_FEEDBACK, "Annotated feedback file"),
    ]
    ACTION_REJECTED = "rejected"
    ACTION_QUARANTINED = "quarantined"
    ACTION_MISSING = "missing"
    ACTION_BLOCKED = "blocked"
    ACTION_CHOICES = [
        (ACTION_REJECTED, "Rejected, never stored"),
        (ACTION_QUARANTINED, "Moved to quarantine, downloads blocked"),
        (ACTION_MISSING, "Downloads blocked (file already gone from storage)"),
        (ACTION_BLOCKED, "Downloads blocked; moving it failed, move it to quarantine by hand"),
    ]

    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    source = models.CharField(max_length=16, choices=SOURCE_CHOICES)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    action = models.CharField(max_length=16, choices=ACTION_CHOICES)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        help_text="Who uploaded the file.",
    )
    task = models.ForeignKey(ReportTask, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")
    object_id = models.PositiveBigIntegerField(null=True, blank=True, help_text="File / attachment / grade id.")
    original_name = models.CharField(max_length=255, blank=True, default="")
    size = models.PositiveBigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True, default="", db_index=True)
    signature = models.CharField(max_length=255, blank=True, default="")
    scanner = models.CharField(max_length=64, blank=True, default="")
    signature_version = models.CharField(max_length=128, blank=True, default="")
    quarantine_name = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "quarantined / blocked file"
        verbose_name_plural = "quarantined / blocked files"

    def __str__(self):
        return f"{self.signature or 'blocked'}: {self.original_name}"
