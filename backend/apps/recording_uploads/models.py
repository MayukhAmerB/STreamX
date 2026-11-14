"""Resumable recording uploads and the personal upload tokens that may create them.

``RecordingUpload`` lifecycle (compare-and-set transitions in services.py)::

    uploading --complete--> queued --worker--> assembling --> completed
        |                     |                    |
        +--abort--> aborted   +--------------------+--> failed
        +--no chunk for RECORDING_UPLOAD_EXPIRY_HOURS--> expired

Chunks live in a private staging directory (config.staging_root()), one file
per chunk, until the worker has assembled and verified the whole file.
"""

import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class RecordingUploadToken(models.Model):
    """A personal token that can only upload class recordings (desktop uploader).

    Only the SHA-256 of the token is stored; the token itself is shown once,
    when it is created in the Console. Revoking it stops it at once.
    """

    SCOPE_RECORDING_UPLOAD = "recording_upload"
    SCOPE_CHOICES = [(SCOPE_RECORDING_UPLOAD, "Upload class recordings")]

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="recording_upload_tokens"
    )
    name = models.CharField(max_length=80)
    prefix = models.CharField(max_length=16, db_index=True, help_text="First characters, to recognise the token.")
    token_hash = models.CharField(max_length=64, unique=True)
    scope = models.CharField(max_length=32, choices=SCOPE_CHOICES, default=SCOPE_RECORDING_UPLOAD)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    last_used_ip = models.CharField(max_length=64, blank=True, default="")
    expires_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "Recording upload token"
        verbose_name_plural = "Recording upload tokens"
        indexes = [models.Index(fields=["owner", "revoked_at"], name="rec_upload_token_owner_idx")]

    def __str__(self):
        return f"{self.name} ({self.prefix}…)"


class RecordingUpload(models.Model):
    STATUS_UPLOADING = "uploading"
    STATUS_QUEUED = "queued"
    STATUS_ASSEMBLING = "assembling"
    STATUS_COMPLETED = "completed"
    STATUS_FAILED = "failed"
    STATUS_ABORTED = "aborted"
    STATUS_EXPIRED = "expired"
    STATUS_CHOICES = [
        (STATUS_UPLOADING, "Uploading"),
        (STATUS_QUEUED, "Queued for processing"),
        (STATUS_ASSEMBLING, "Processing"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_FAILED, "Failed"),
        (STATUS_ABORTED, "Cancelled"),
        (STATUS_EXPIRED, "Expired"),
    ]
    ACTIVE_STATUSES = (STATUS_UPLOADING, STATUS_QUEUED, STATUS_ASSEMBLING)
    FINAL_STATUSES = (STATUS_COMPLETED, STATUS_FAILED, STATUS_ABORTED, STATUS_EXPIRED)

    ACTION_REPLACED = "replaced"
    ACTION_CREATED = "created"
    ACTION_CHOICES = [(ACTION_REPLACED, "Replaced the auto-recording"), (ACTION_CREATED, "Created the lecture")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="recording_uploads")
    session = models.ForeignKey(
        "realtime.RealtimeSession",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="recording_uploads",
    )
    token = models.ForeignKey(
        RecordingUploadToken,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="uploads",
        help_text="The personal upload token that created this upload (desktop uploader), if any.",
    )
    filename = models.CharField(max_length=160, help_text="Sanitised original file name.")
    extension = models.CharField(max_length=8)
    content_type = models.CharField(max_length=100, blank=True, default="")
    total_bytes = models.BigIntegerField()
    chunk_bytes = models.PositiveIntegerField()
    chunk_count = models.PositiveIntegerField()
    # One bit per chunk (bit i of byte i//8, least significant first).
    received_bitmap = models.BinaryField(default=b"", editable=False)
    received_count = models.PositiveIntegerField(default=0)
    received_bytes = models.BigIntegerField(default=0)
    # {"<index>": "<sha256 hex>"} of every stored chunk: a repeated chunk must match.
    chunk_sha256 = models.JSONField(default=dict, blank=True)
    sha256 = models.CharField(max_length=64, blank=True, default="", help_text="Whole-file SHA-256 the client declared.")
    computed_sha256 = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_UPLOADING)
    error = models.TextField(blank=True, default="")
    attempts = models.PositiveIntegerField(default=0)
    lease_until = models.DateTimeField(null=True, blank=True)
    waiting_since = models.DateTimeField(
        null=True, blank=True, help_text="Waiting for the class's auto-recording to get its lecture."
    )
    expires_at = models.DateTimeField()
    # Outcome.
    recording = models.ForeignKey(
        "realtime.ClassRecording",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="uploads",
        help_text="The OBS-upload class recording this upload produced.",
    )
    replaced_recording = models.ForeignKey(
        "realtime.ClassRecording",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        help_text="The recording whose lecture video this upload replaced.",
    )
    lecture = models.ForeignKey(
        "courses.Lecture", on_delete=models.SET_NULL, null=True, blank=True, related_name="recording_uploads"
    )
    action = models.CharField(max_length=16, choices=ACTION_CHOICES, blank=True, default="")
    video_name = models.CharField(max_length=500, blank=True, default="", help_text="Storage name of the uploaded video.")
    previous_video_name = models.CharField(
        max_length=500, blank=True, default="", help_text="The replaced video, kept so an admin can switch back."
    )
    previous_video_deleted_at = models.DateTimeField(null=True, blank=True)
    reverted_at = models.DateTimeField(null=True, blank=True)
    reverted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    duration_seconds = models.PositiveIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Class recording upload"
        verbose_name_plural = "Class recording uploads"
        indexes = [
            models.Index(fields=["owner", "status"], name="rec_upload_owner_status_idx"),
            models.Index(fields=["status", "expires_at"], name="rec_upload_status_exp_idx"),
        ]
        constraints = [
            models.CheckConstraint(condition=Q(total_bytes__gt=0), name="rec_upload_total_bytes_positive"),
            models.CheckConstraint(condition=Q(chunk_count__gt=0), name="rec_upload_chunk_count_positive"),
        ]

    def __str__(self):
        return f"{self.filename} ({self.get_status_display()})"

    # ------------------------------------------------------------- chunks
    def expected_chunk_size(self, index):
        if index < self.chunk_count - 1:
            return self.chunk_bytes
        return self.total_bytes - self.chunk_bytes * (self.chunk_count - 1)

    def has_chunk(self, index):
        bitmap = bytes(self.received_bitmap or b"")
        byte = index // 8
        return byte < len(bitmap) and bool(bitmap[byte] & (1 << (index % 8)))

    def with_chunk(self, index):
        """The bitmap with ``index`` set (the caller saves it under a row lock)."""
        bitmap = bytearray(bytes(self.received_bitmap or b"").ljust((self.chunk_count + 7) // 8, b"\x00"))
        bitmap[index // 8] |= 1 << (index % 8)
        return bytes(bitmap)

    def received_indexes(self):
        return [index for index in range(self.chunk_count) if self.has_chunk(index)]

    def missing_indexes(self):
        return [index for index in range(self.chunk_count) if not self.has_chunk(index)]

    @property
    def is_active(self):
        return self.status in self.ACTIVE_STATUSES
