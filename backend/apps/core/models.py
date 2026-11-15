import uuid

from django.db import models
from django.utils import timezone


class IdempotencyKey(models.Model):
    """One unsafe API request identified by (scope, owner, Idempotency-Key).

    The raw key and the owner identity are stored only as SHA-256 digests.
    ``lease_token`` fences a worker whose lease expired: only the current
    owner of the lease may publish the final response.
    """

    STATUS_IN_PROGRESS = "in_progress"
    STATUS_COMPLETED = "completed"
    STATUS_CHOICES = [
        (STATUS_IN_PROGRESS, "In progress"),
        (STATUS_COMPLETED, "Completed"),
    ]

    scope = models.CharField(max_length=80)
    owner_hash = models.CharField(max_length=64)
    key_hash = models.CharField(max_length=64)
    request_fingerprint = models.CharField(max_length=64)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_IN_PROGRESS)
    lease_token = models.UUIDField(default=uuid.uuid4)
    locked_until = models.DateTimeField()
    response_status = models.PositiveSmallIntegerField(null=True, blank=True)
    response_body = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        verbose_name = "Idempotency key"
        verbose_name_plural = "Idempotency keys"
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "owner_hash", "key_hash"],
                name="core_idempotency_scope_owner_key_uniq",
            )
        ]

    def __str__(self):
        return f"{self.scope}:{self.key_hash[:12]} ({self.status})"


class OutboxEvent(models.Model):
    """A side effect recorded in the same transaction as the business change.

    Written by ``apps.core.outbox.publish`` and delivered at least once by
    the async worker (``process_async_jobs``) through the handler registered
    for ``event_type``. Handlers must be idempotent (see README).
    """

    STATUS_PENDING = "pending"
    STATUS_PROCESSING = "processing"
    STATUS_DELIVERED = "delivered"
    STATUS_DEAD = "dead"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_DELIVERED, "Delivered"),
        (STATUS_DEAD, "Dead letter"),
    ]

    event_type = models.CharField(max_length=120, db_index=True)
    payload = models.JSONField(default=dict, blank=True)
    dedupe_key = models.CharField(max_length=200, null=True, blank=True, unique=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING)
    attempts = models.PositiveIntegerField(default=0)
    max_attempts = models.PositiveIntegerField(default=8)
    available_at = models.DateTimeField(default=timezone.now)
    locked_at = models.DateTimeField(null=True, blank=True)
    locked_by = models.CharField(max_length=120, blank=True, default="")
    last_error = models.TextField(blank=True, default="")
    request_id = models.CharField(max_length=128, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)
    delivered_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "Outbox event"
        verbose_name_plural = "Outbox events"
        indexes = [
            models.Index(fields=["status", "available_at"], name="core_outbox_status_avail_idx"),
            models.Index(fields=["status", "locked_at"], name="core_outbox_status_locked_idx"),
        ]

    def __str__(self):
        return f"{self.event_type}#{self.pk} ({self.status})"
