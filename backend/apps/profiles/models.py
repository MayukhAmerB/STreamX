"""Student profiles: one public page per student at ``/u/<handle>``.

* ``StudentProfile``: the handle, the editable draft document, the last
  published snapshot (what everyone else sees), privacy toggles and the
  moderation state.
* ``ProfileImage``: avatar, banner and gallery images, re-encoded server-side
  (EXIF/GPS stripped, polyglots destroyed) and virus-scanned, in private
  storage.
* ``ProfileReport``: "Report profile" submissions (the admin moderation queue).
* ``ProfileAuditLog``: who did what to a profile (publish, blocked publish,
  hide/restore, reports, image changes). It never stores the PII that was
  found, only detector codes and field paths.
* ``ProfileSiteSettings``: a single row the admin edits (real names allowed).
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone

from .storage import private_profile_storage, profile_image_upload_to


class StudentProfile(models.Model):
    VISIBILITY_PUBLIC = "public"
    VISIBILITY_MEMBERS = "members"
    VISIBILITY_CHOICES = [
        (VISIBILITY_PUBLIC, "Anyone with the link"),
        (VISIBILITY_MEMBERS, "Signed-in members only"),
    ]
    STATUS_ACTIVE = "active"
    STATUS_HIDDEN = "hidden"
    STATUS_CHOICES = [(STATUS_ACTIVE, "Active"), (STATUS_HIDDEN, "Hidden by a moderator")]

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="student_profile")
    handle = models.CharField(max_length=30, unique=True, help_text="Public handle, lower case (the /u/<handle> address).")
    handle_changed_at = models.DateTimeField(null=True, blank=True)
    # Privacy (handle only): True while the handle is the automatic one the
    # platform assigned (the student is prompted once to customise it).
    handle_auto = models.BooleanField(default=False, help_text="The handle was assigned automatically.")
    handle_prompt_dismissed_at = models.DateTimeField(
        null=True, blank=True, help_text="When the student dismissed the 'customise your handle' prompt."
    )
    draft = models.JSONField(default=dict, blank=True)
    draft_version = models.PositiveIntegerField(default=0)
    draft_updated_at = models.DateTimeField(null=True, blank=True)
    published = models.JSONField(null=True, blank=True, help_text="The snapshot everyone else sees.")
    published_version = models.PositiveIntegerField(default=0, help_text="Draft version that was published.")
    published_at = models.DateTimeField(null=True, blank=True)
    visibility = models.CharField(max_length=10, choices=VISIBILITY_CHOICES, default=VISIBILITY_MEMBERS)
    show_real_name = models.BooleanField(
        default=False, help_text="The owner wants their account name shown (only when the admin allows real names)."
    )
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    hidden_reason = models.CharField(max_length=300, blank=True, default="")
    hidden_at = models.DateTimeField(null=True, blank=True)
    hidden_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["handle"]
        verbose_name = "student profile"
        indexes = [
            models.Index(fields=["status", "published_at"], name="prof_status_pub_idx"),
            models.Index(fields=["status"], name="prof_hidden_idx", condition=Q(status="hidden")),
        ]

    def __str__(self):
        return f"@{self.handle}"

    @property
    def is_published(self) -> bool:
        return self.published is not None and self.published_at is not None

    @property
    def has_unpublished_changes(self) -> bool:
        return self.draft_version != self.published_version or not self.is_published


class ProfileImage(models.Model):
    KIND_AVATAR = "avatar"
    KIND_BANNER = "banner"
    KIND_GALLERY = "gallery"
    KIND_CHOICES = [(KIND_AVATAR, "Avatar"), (KIND_BANNER, "Banner"), (KIND_GALLERY, "Gallery")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    profile = models.ForeignKey(StudentProfile, on_delete=models.CASCADE, related_name="images")
    kind = models.CharField(max_length=10, choices=KIND_CHOICES)
    file = models.FileField(storage=private_profile_storage, upload_to=profile_image_upload_to, max_length=255)
    content_type = models.CharField(max_length=40, default="image/webp")
    width = models.PositiveIntegerField(default=0)
    height = models.PositiveIntegerField(default=0)
    size_bytes = models.PositiveIntegerField(default=0)
    sha256 = models.CharField(max_length=64)
    scanner = models.CharField(max_length=64, blank=True, default="")
    scanner_version = models.CharField(max_length=128, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["created_at"]
        verbose_name = "profile image"
        indexes = [models.Index(fields=["profile", "kind"], name="prof_image_kind_idx")]

    def __str__(self):
        return f"{self.kind} {self.id} (@{self.profile.handle})"


class ProfileReport(models.Model):
    REASON_PERSONAL_INFO = "personal_info"
    REASON_HARASSMENT = "harassment"
    REASON_IMPERSONATION = "impersonation"
    REASON_INAPPROPRIATE = "inappropriate"
    REASON_SPAM = "spam"
    REASON_OTHER = "other"
    REASON_CHOICES = [
        (REASON_PERSONAL_INFO, "Shares personal information"),
        (REASON_HARASSMENT, "Harassment or hate"),
        (REASON_IMPERSONATION, "Pretends to be someone else"),
        (REASON_INAPPROPRIATE, "Inappropriate images or text"),
        (REASON_SPAM, "Spam or scam links"),
        (REASON_OTHER, "Something else"),
    ]
    STATUS_OPEN = "open"
    STATUS_ACTIONED = "actioned"
    STATUS_DISMISSED = "dismissed"
    STATUS_CHOICES = [
        (STATUS_OPEN, "Open"),
        (STATUS_ACTIONED, "Actioned (profile hidden)"),
        (STATUS_DISMISSED, "Dismissed"),
    ]

    profile = models.ForeignKey(StudentProfile, on_delete=models.CASCADE, related_name="reports")
    reporter = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    reason = models.CharField(max_length=20, choices=REASON_CHOICES)
    details = models.CharField(max_length=500, blank=True, default="")
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default=STATUS_OPEN)
    created_at = models.DateTimeField(default=timezone.now)
    resolved_at = models.DateTimeField(null=True, blank=True)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    resolution_note = models.CharField(max_length=300, blank=True, default="")

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "profile report"
        constraints = [
            models.UniqueConstraint(
                fields=["profile", "reporter"], condition=Q(status="open"), name="prof_report_one_open_per_reporter"
            )
        ]
        indexes = [models.Index(fields=["status", "created_at"], name="prof_report_status_idx")]

    def __str__(self):
        return f"Report on @{self.profile.handle}: {self.get_reason_display()}"


class ProfileAuditLog(models.Model):
    ACTION_CREATED = "created"
    ACTION_AUTO_CREATED = "auto_created"
    ACTION_HANDLE_CHANGED = "handle_changed"
    ACTION_SETTINGS_CHANGED = "settings_changed"
    ACTION_PUBLISHED = "published"
    ACTION_PUBLISH_BLOCKED = "publish_blocked"
    ACTION_UNPUBLISHED = "unpublished"
    ACTION_IMAGE_ADDED = "image_added"
    ACTION_IMAGE_REJECTED = "image_rejected"
    ACTION_IMAGE_DELETED = "image_deleted"
    ACTION_REPORTED = "reported"
    ACTION_HIDDEN = "hidden"
    ACTION_RESTORED = "restored"
    ACTION_REPORT_DISMISSED = "report_dismissed"
    ACTION_CHOICES = [
        (ACTION_CREATED, "Profile created"),
        (ACTION_AUTO_CREATED, "Handle assigned automatically"),
        (ACTION_HANDLE_CHANGED, "Handle changed"),
        (ACTION_SETTINGS_CHANGED, "Privacy settings changed"),
        (ACTION_PUBLISHED, "Published"),
        (ACTION_PUBLISH_BLOCKED, "Publish blocked by the PII guard"),
        (ACTION_UNPUBLISHED, "Unpublished"),
        (ACTION_IMAGE_ADDED, "Image added"),
        (ACTION_IMAGE_REJECTED, "Image rejected"),
        (ACTION_IMAGE_DELETED, "Image deleted"),
        (ACTION_REPORTED, "Reported"),
        (ACTION_HIDDEN, "Hidden by a moderator"),
        (ACTION_RESTORED, "Restored by a moderator"),
        (ACTION_REPORT_DISMISSED, "Report dismissed"),
    ]

    profile = models.ForeignKey(StudentProfile, null=True, on_delete=models.SET_NULL, related_name="audit_entries")
    handle = models.CharField(max_length=30, blank=True, default="")
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name="+")
    action = models.CharField(max_length=20, choices=ACTION_CHOICES)
    details = models.JSONField(default=dict, blank=True)
    ip = models.GenericIPAddressField(null=True, blank=True)
    request_id = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "profile audit entry"
        verbose_name_plural = "profile audit log"
        indexes = [models.Index(fields=["profile", "created_at"], name="prof_audit_profile_idx")]

    def __str__(self):
        return f"{self.get_action_display()} @{self.handle}"


class ProfileSiteSettings(models.Model):
    """One row (pk=1) of admin-controlled profile rules."""

    allow_real_names = models.BooleanField(
        default=False,
        help_text=(
            "Retired by the owner's privacy rule (handle only): profiles always show the public handle, and the "
            "PII guard always blocks the owner's real name. Real names appear only on certificates."
        ),
    )
    max_gallery_images = models.PositiveSmallIntegerField(default=12)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        verbose_name = "profile settings"
        verbose_name_plural = "profile settings"

    def __str__(self):
        return "Profile settings"

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def load(cls) -> ProfileSiteSettings:
        row = cls.objects.filter(pk=1).first()
        return row if row is not None else cls(pk=1)
