import os
from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.text import slugify

from config.model_validators import validate_no_active_content, validate_safe_public_url
from config.upload_validators import validate_profile_image_upload, validate_video_upload
from config.url_utils import get_media_public_url


class Course(models.Model):
    CATEGORY_OSINT = "osint"
    CATEGORY_WEB_PENTESTING = "web_pentesting"
    CATEGORY_CHOICES = [
        (CATEGORY_OSINT, "OSINT"),
        (CATEGORY_WEB_PENTESTING, "Web Application Pentesting"),
    ]

    LEVEL_BEGINNER = "beginner"
    LEVEL_INTERMEDIATE = "intermediate"
    LEVEL_ADVANCED = "advanced"
    LEVEL_CHOICES = [
        (LEVEL_BEGINNER, "Beginner"),
        (LEVEL_INTERMEDIATE, "Intermediate"),
        (LEVEL_ADVANCED, "Advanced"),
    ]

    STATUS_LIVE = "live"
    STATUS_COMING_SOON = "coming_soon"
    LAUNCH_STATUS_CHOICES = [
        (STATUS_LIVE, "Live"),
        (STATUS_COMING_SOON, "Coming Soon"),
    ]

    title = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255, unique=True, blank=True)
    description = models.TextField()
    thumbnail = models.URLField(blank=True, default="")
    thumbnail_file = models.ImageField(upload_to="course_thumbnails/", blank=True, null=True)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    category = models.CharField(max_length=32, choices=CATEGORY_CHOICES, default=CATEGORY_OSINT)
    level = models.CharField(max_length=20, choices=LEVEL_CHOICES, default=LEVEL_BEGINNER)
    launch_status = models.CharField(
        max_length=20, choices=LAUNCH_STATUS_CHOICES, default=STATUS_LIVE
    )
    instructor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="courses",
    )
    is_published = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["is_published", "category", "level", "launch_status"]),
            models.Index(fields=["instructor", "is_published"]),
            models.Index(fields=["created_at"]),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.description, "description")
        validate_safe_public_url(self.thumbnail, "thumbnail")
        validate_profile_image_upload(self.thumbnail_file, "thumbnail_file")

    def get_thumbnail_url(self, request=None):
        if self.thumbnail_file:
            return get_media_public_url(self.thumbnail_file.url, request=request)
        return self.thumbnail

    def save(self, *args, **kwargs):
        if not self.slug:
            base_slug = slugify(self.title)[:220] or "course"
            slug = base_slug
            index = 1
            while Course.objects.exclude(pk=self.pk).filter(slug=slug).exists():
                slug = f"{base_slug}-{index}"
                index += 1
            self.slug = slug
        super().save(*args, **kwargs)

    def __str__(self):
        return self.title


class Section(models.Model):
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="sections")
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True, default="")
    order = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["order", "id"]
        verbose_name = "Module"
        verbose_name_plural = "Modules"
        indexes = [
            models.Index(fields=["course", "order"]),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.description, "description")

    def __str__(self):
        return f"{self.course.title} - {self.title}"


def lecture_video_upload_path(instance, filename):
    course_slug = getattr(getattr(instance.section, "course", None), "slug", "course") or "course"
    section_id = instance.section_id or "module"
    safe_name = os.path.basename(filename or "video.mp4")
    return f"lecture_videos/{course_slug}/module_{section_id}/{safe_name}"


class Lecture(models.Model):
    STREAM_PENDING = "pending"
    STREAM_UPLOADED = "uploaded"
    STREAM_PROCESSING = "processing"
    STREAM_READY = "ready"
    STREAM_FAILED = "failed"
    STREAM_STATUS_CHOICES = [
        (STREAM_PENDING, "Pending"),
        (STREAM_UPLOADED, "Uploaded"),
        (STREAM_PROCESSING, "Processing"),
        (STREAM_READY, "Ready"),
        (STREAM_FAILED, "Failed"),
    ]

    section = models.ForeignKey(Section, on_delete=models.CASCADE, related_name="lectures")
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True, default="")
    video_key = models.CharField(max_length=1024, blank=True, default="")
    video_file = models.FileField(upload_to=lecture_video_upload_path, blank=True, null=True)
    stream_status = models.CharField(
        max_length=20, choices=STREAM_STATUS_CHOICES, default=STREAM_PENDING
    )
    stream_manifest_key = models.CharField(max_length=1024, blank=True, default="")
    stream_duration_seconds = models.PositiveIntegerField(blank=True, null=True)
    stream_error = models.TextField(blank=True, default="")
    order = models.PositiveIntegerField(default=1)
    is_preview = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "id"]
        indexes = [
            models.Index(fields=["section", "order"]),
            models.Index(fields=["stream_status"]),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.description, "description")
        if not self.video_key and not self.video_file:
            raise ValidationError({"video_file": "Upload a video file or provide a video key."})
        validate_video_upload(self.video_file, "video_file")
        if self.video_key and str(self.video_key).startswith(("http://", "https://")):
            validate_safe_public_url(self.video_key, "video_key")

    def save(self, *args, **kwargs):
        has_source = bool(self.video_file or self.video_key)
        has_manifest = bool(self.stream_manifest_key)

        if has_manifest:
            self.stream_status = self.STREAM_READY
            if self.stream_error:
                self.stream_error = ""
        elif self.stream_status == self.STREAM_READY and not has_manifest:
            self.stream_status = self.STREAM_UPLOADED if has_source else self.STREAM_PENDING
        elif self.stream_status == self.STREAM_PENDING and has_source:
            self.stream_status = self.STREAM_UPLOADED
        elif not has_source and self.stream_status in {self.STREAM_UPLOADED, self.STREAM_PROCESSING}:
            self.stream_status = self.STREAM_PENDING

        super().save(*args, **kwargs)

    def __str__(self):
        return self.title


class Enrollment(models.Model):
    STATUS_PENDING = "pending"
    STATUS_PAID = "paid"
    STATUS_FAILED = "failed"
    PAYMENT_STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_PAID, "Paid"),
        (STATUS_FAILED, "Failed"),
    ]

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="enrollments")
    course = models.ForeignKey(Course, on_delete=models.CASCADE, related_name="enrollments")
    payment_status = models.CharField(max_length=20, choices=PAYMENT_STATUS_CHOICES, default=STATUS_PENDING)
    enrolled_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("user", "course")
        ordering = ["-enrolled_at"]
        indexes = [
            models.Index(fields=["user", "payment_status"]),
            models.Index(fields=["course", "payment_status"]),
            models.Index(fields=["user", "course", "payment_status"]),
        ]

    def __str__(self):
        return f"{self.user.email} -> {self.course.title}"


class LiveClass(models.Model):
    LEVEL_BEGINNER = "beginner"
    LEVEL_INTERMEDIATE = "intermediate"
    LEVEL_ADVANCED = "advanced"
    LEVEL_CHOICES = [
        (LEVEL_BEGINNER, "Beginner"),
        (LEVEL_INTERMEDIATE, "Intermediate"),
        (LEVEL_ADVANCED, "Advanced"),
    ]

    title = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255, unique=True, blank=True)
    description = models.TextField()
    price = models.DecimalField(max_digits=10, decimal_places=2, default=Decimal("0.00"))
    linked_course = models.ForeignKey(
        Course,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="live_classes",
    )
    level = models.CharField(max_length=20, choices=LEVEL_CHOICES, default=LEVEL_BEGINNER)
    month_number = models.PositiveIntegerField(default=1)
    schedule_days = models.CharField(max_length=255, default="Friday, Saturday, Sunday")
    class_duration_minutes = models.PositiveIntegerField(default=60)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["month_number", "id"]
        verbose_name = "Live Class"
        verbose_name_plural = "Live Classes"
        indexes = [
            models.Index(fields=["is_active", "month_number", "level"]),
            models.Index(fields=["linked_course"]),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.description, "description")
        validate_no_active_content(self.schedule_days, "schedule_days")

    def save(self, *args, **kwargs):
        if not self.slug:
            base_slug = slugify(self.title)[:220] or "live-class"
            slug = base_slug
            index = 1
            while LiveClass.objects.exclude(pk=self.pk).filter(slug=slug).exists():
                slug = f"{base_slug}-{index}"
                index += 1
            self.slug = slug
        super().save(*args, **kwargs)

    def __str__(self):
        return self.title


class LiveClassEnrollment(models.Model):
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    ]

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="live_class_enrollments",
    )
    live_class = models.ForeignKey(
        LiveClass,
        on_delete=models.CASCADE,
        related_name="enrollments",
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        unique_together = ("user", "live_class")
        verbose_name = "Live Class Enrollment"
        verbose_name_plural = "Live Class Enrollments"
        indexes = [
            models.Index(fields=["user", "created_at"]),
            models.Index(fields=["live_class", "created_at"]),
        ]

    def __str__(self):
        return f"{self.user.email} -> {self.live_class.title}"

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        self._sync_linked_course_enrollment_status()

    def _sync_linked_course_enrollment_status(self):
        linked_course_id = getattr(self.live_class, "linked_course_id", None)
        if not linked_course_id:
            return

        enrollment = (
            Enrollment.objects.filter(user=self.user, course_id=linked_course_id)
            .order_by("-enrolled_at")
            .first()
        )
        if not enrollment:
            return

        target_status = None
        if self.status == self.STATUS_APPROVED:
            target_status = Enrollment.STATUS_PAID
        elif self.status == self.STATUS_PENDING:
            target_status = Enrollment.STATUS_PENDING
        elif self.status == self.STATUS_REJECTED:
            # Do not downgrade already-approved course access.
            if enrollment.payment_status != Enrollment.STATUS_PAID:
                target_status = Enrollment.STATUS_FAILED

        if target_status and enrollment.payment_status != target_status:
            enrollment.payment_status = target_status
            enrollment.save(update_fields=["payment_status"])
