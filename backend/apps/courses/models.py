import os
from decimal import Decimal
from io import BytesIO

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.db import models
from django.db.models import Q
from django.urls import reverse
from django.utils import timezone
from django.utils.text import slugify
from PIL import Image, ImageOps, UnidentifiedImageError

from config.model_validators import validate_no_active_content, validate_safe_public_url
from config.upload_validators import validate_profile_image_upload, validate_video_upload
from config.url_utils import get_media_public_url
from .cache_utils import bump_course_list_cache_version, bump_live_class_list_cache_version

MAX_GUIDE_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024


def _sanitize_string_list(value):
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValidationError("Enter a valid list of text items.")

    cleaned = []
    for item in value:
        text = str(item or "").strip()
        if not text:
            continue
        cleaned.append(text)
    return cleaned


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
    about_the_course = models.TextField(blank=True, default="")
    course_overview = models.TextField(blank=True, default="")
    what_you_will_learn = models.JSONField(blank=True, default=list)
    expected_outcomes = models.JSONField(blank=True, default=list)
    enrollment_message = models.TextField(blank=True, default="")
    snapshot_category = models.CharField(max_length=255, blank=True, default="")
    snapshot_level = models.CharField(max_length=255, blank=True, default="")
    snapshot_instructor = models.CharField(max_length=255, blank=True, default="")
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
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
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
        validate_no_active_content(self.about_the_course, "about_the_course")
        validate_no_active_content(self.course_overview, "course_overview")
        validate_no_active_content(self.enrollment_message, "enrollment_message")
        validate_no_active_content(self.snapshot_category, "snapshot_category")
        validate_no_active_content(self.snapshot_level, "snapshot_level")
        validate_no_active_content(self.snapshot_instructor, "snapshot_instructor")

        self.what_you_will_learn = _sanitize_string_list(self.what_you_will_learn)
        self.expected_outcomes = _sanitize_string_list(self.expected_outcomes)
        for index, item in enumerate(self.what_you_will_learn):
            validate_no_active_content(item, f"what_you_will_learn[{index}]")
        for index, item in enumerate(self.expected_outcomes):
            validate_no_active_content(item, f"expected_outcomes[{index}]")

        validate_safe_public_url(self.thumbnail, "thumbnail")
        validate_profile_image_upload(self.thumbnail_file, "thumbnail_file")

    def get_thumbnail_url(self, request=None):
        if self._has_accessible_thumbnail_file():
            if request:
                thumbnail_path = reverse("course-thumbnail", args=[self.pk])
                version = int(self.updated_at.timestamp() * 1_000_000) if self.updated_at else 0
                return request.build_absolute_uri(f"{thumbnail_path}?v={version}")
            return get_media_public_url(self.thumbnail_file.url, request=request)
        return self.thumbnail

    def _has_accessible_thumbnail_file(self):
        thumbnail_file = getattr(self, "thumbnail_file", None)
        if not thumbnail_file:
            return False
        if not getattr(thumbnail_file, "name", ""):
            return False
        storage = getattr(thumbnail_file, "storage", None)
        if storage is None:
            return False
        try:
            return bool(storage.exists(thumbnail_file.name))
        except Exception:
            return False

    def _normalize_thumbnail_file(self):
        """
        Normalize uploaded course thumbnails to 16:10 so cards render consistently.
        Process new uploads and legacy stored files that are not yet normalized.
        """
        if not self.thumbnail_file:
            return
        current_name = str(self.thumbnail_file.name or "")
        if not current_name:
            return
        filename_no_ext, _ = os.path.splitext(os.path.basename(current_name))
        if filename_no_ext.endswith("_16x10"):
            return

        original_name = os.path.basename(current_name or "thumbnail")
        base_name, ext = os.path.splitext(original_name)
        ext = ext.lower()
        output_format = "WEBP" if ext == ".webp" else "JPEG"
        output_ext = ".webp" if output_format == "WEBP" else ".jpg"
        safe_base_name = slugify(base_name)[:120] or "thumbnail"

        opened_here = False
        raw_file = getattr(self.thumbnail_file, "file", None)
        try:
            if raw_file is None:
                self.thumbnail_file.open("rb")
                raw_file = self.thumbnail_file.file
                opened_here = True
            raw_file.seek(0)
            with Image.open(raw_file) as image:
                image = ImageOps.exif_transpose(image)
                if image.mode not in {"RGB", "RGBA"}:
                    image = image.convert("RGB")

                width, height = image.size
                if width <= 0 or height <= 0:
                    return

                target_ratio = 16 / 10
                current_ratio = width / height
                if current_ratio > target_ratio:
                    crop_width = int(height * target_ratio)
                    left = (width - crop_width) // 2
                    crop_box = (left, 0, left + crop_width, height)
                else:
                    crop_height = int(width / target_ratio)
                    top = (height - crop_height) // 2
                    crop_box = (0, top, width, top + crop_height)

                cropped = image.crop(crop_box).convert("RGB")
                resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
                normalized = cropped.resize((1600, 1000), resampling)

                output = BytesIO()
                if output_format == "WEBP":
                    normalized.save(output, format=output_format, quality=90, method=6)
                else:
                    normalized.save(output, format=output_format, quality=88, optimize=True)
                output.seek(0)
                processed_name = f"{safe_base_name}_16x10{output_ext}"
                self.thumbnail_file.save(processed_name, ContentFile(output.read()), save=False)
        except (UnidentifiedImageError, OSError, ValueError):
            # Validation already handles bad files; keep original payload if processing fails.
            return
        finally:
            if opened_here:
                self.thumbnail_file.close()

    def save(self, *args, **kwargs):
        self._normalize_thumbnail_file()
        if not self.slug:
            base_slug = slugify(self.title)[:220] or "course"
            slug = base_slug
            index = 1
            while Course.objects.exclude(pk=self.pk).filter(slug=slug).exists():
                slug = f"{base_slug}-{index}"
                index += 1
            self.slug = slug
        super().save(*args, **kwargs)
        bump_course_list_cache_version()

    def delete(self, *args, **kwargs):
        super().delete(*args, **kwargs)
        bump_course_list_cache_version()

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


def guide_video_upload_path(instance, filename):
    safe_name = os.path.basename(filename or "guide-video.mp4")
    return f"guide_videos/{safe_name}"


class GuideVideo(models.Model):
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True, default="")
    video_file = models.FileField(
        upload_to=guide_video_upload_path,
        help_text="Upload MP4, M4V, MOV, or WEBM. Maximum size: 500 MB.",
    )
    order = models.PositiveIntegerField(default=1)
    is_published = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "id"]
        verbose_name = "Guide Video"
        verbose_name_plural = "Guide Panel"
        indexes = [
            models.Index(fields=["is_published", "order"]),
            models.Index(fields=["created_at"]),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.description, "description")
        validate_video_upload(
            self.video_file,
            "video_file",
            max_bytes=MAX_GUIDE_VIDEO_UPLOAD_BYTES,
        )

    def __str__(self):
        return self.title


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
        source_changed = False
        if self.pk:
            previous = (
                Lecture.objects.filter(pk=self.pk)
                .values("video_key", "video_file", "stream_manifest_key")
                .first()
            )
            if previous:
                previous_video_key = str(previous.get("video_key") or "")
                previous_video_file = str(previous.get("video_file") or "")
                current_video_key = str(self.video_key or "")
                current_video_file = str(getattr(self.video_file, "name", "") or "")
                source_changed = (
                    previous_video_key != current_video_key
                    or previous_video_file != current_video_file
                )

        if source_changed:
            self.stream_manifest_key = ""
            self.stream_duration_seconds = None
            self.stream_error = ""

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


class LectureProgress(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="lecture_progress_entries",
    )
    lecture = models.ForeignKey(
        Lecture,
        on_delete=models.CASCADE,
        related_name="progress_entries",
    )
    last_position_seconds = models.PositiveIntegerField(default=0)
    max_position_seconds = models.PositiveIntegerField(default=0)
    duration_seconds = models.PositiveIntegerField(blank=True, null=True)
    completed = models.BooleanField(default=False)
    completed_at = models.DateTimeField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
        constraints = [
            models.UniqueConstraint(fields=["user", "lecture"], name="courses_lectureprogress_unique_user_lecture"),
        ]
        indexes = [
            models.Index(fields=["user", "updated_at"]),
            models.Index(fields=["lecture", "updated_at"]),
            models.Index(fields=["user", "completed"]),
        ]

    def mark_progress(self, *, position_seconds, duration_seconds=None, completed=None):
        normalized_position = max(0, int(position_seconds or 0))
        normalized_duration = None
        if duration_seconds is not None:
            try:
                normalized_duration = max(0, int(duration_seconds))
            except (TypeError, ValueError):
                normalized_duration = None
        if normalized_duration:
            normalized_position = min(normalized_position, normalized_duration)

        self.last_position_seconds = normalized_position
        self.max_position_seconds = max(self.max_position_seconds or 0, normalized_position)
        if normalized_duration:
            self.duration_seconds = normalized_duration

        should_complete = bool(completed)
        if not should_complete and self.duration_seconds:
            completion_threshold_seconds = max(15, int(self.duration_seconds * 0.9))
            should_complete = (self.max_position_seconds or 0) >= completion_threshold_seconds

        if should_complete:
            self.completed = True
            self.completed_at = self.completed_at or timezone.now()
        elif completed is False:
            self.completed = False
            self.completed_at = None

    def completion_percent(self):
        duration = int(self.duration_seconds or 0)
        if duration <= 0:
            return 0
        watched = min(duration, max(self.max_position_seconds or 0, self.last_position_seconds or 0))
        return int(round((watched / duration) * 100))

    def resume_position_seconds(self):
        if self.completed:
            return 0
        return int(self.last_position_seconds or 0)

    def save(self, *args, **kwargs):
        if self.completed and not self.completed_at:
            self.completed_at = timezone.now()
        if not self.completed and self.completed_at:
            self.completed_at = None
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.user.email} -> {self.lecture.title}"


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
        bump_live_class_list_cache_version()

    def delete(self, *args, **kwargs):
        super().delete(*args, **kwargs)
        bump_live_class_list_cache_version()

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
            models.Index(fields=["user", "status"]),
            models.Index(fields=["live_class", "status"]),
        ]

    def __str__(self):
        return f"{self.user.email} -> {self.live_class.title}"

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)


class PublicEnrollmentLead(models.Model):
    STATUS_NEW = "new"
    STATUS_REVIEWED = "reviewed"
    STATUS_CONTACTED = "contacted"
    STATUS_CONVERTED = "converted"
    STATUS_CHOICES = [
        (STATUS_NEW, "New"),
        (STATUS_REVIEWED, "Reviewed"),
        (STATUS_CONTACTED, "Contacted"),
        (STATUS_CONVERTED, "Converted"),
    ]

    course = models.ForeignKey(
        Course,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="public_enrollment_leads",
    )
    live_class = models.ForeignKey(
        LiveClass,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="public_enrollment_leads",
    )
    email = models.EmailField(max_length=254)
    phone_number = models.CharField(max_length=24)
    whatsapp_number = models.CharField(max_length=24)
    message = models.TextField()
    source_path = models.CharField(max_length=255, blank=True, default="")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_NEW)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Public Enrollment Lead"
        verbose_name_plural = "Public Enrollment Leads"
        constraints = [
            models.CheckConstraint(
                check=(
                    (Q(course__isnull=False) & Q(live_class__isnull=True))
                    | (Q(course__isnull=True) & Q(live_class__isnull=False))
                    | (Q(course__isnull=True) & Q(live_class__isnull=True))
                ),
                name="courses_publicenrollmentlead_zero_or_one_target",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "created_at"]),
            models.Index(fields=["email", "created_at"]),
            models.Index(fields=["course", "created_at"]),
            models.Index(fields=["live_class", "created_at"]),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.message, "message")
        validate_no_active_content(self.source_path, "source_path")
        has_course = bool(self.course_id)
        has_live_class = bool(self.live_class_id)
        if has_course and has_live_class:
            raise ValidationError(
                {"detail": "Select only one target: either a course or a live class."}
            )

    def __str__(self):
        if self.course_id:
            target = self.course.title
        elif self.live_class_id:
            target = self.live_class.title
        else:
            target = "Unknown target"
        return f"{self.email} -> {target}"
