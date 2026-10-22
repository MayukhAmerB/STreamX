from config.model_validators import validate_no_active_content, validate_safe_public_url
from config.upload_validators import (
    validate_audio_upload,
    validate_profile_image_upload,
    validate_resource_upload,
    validate_video_upload,
)
from django.db import models


class SingletonModel(models.Model):
    """Base for admin-managed single-row configuration tables.

    The row is pinned to ``pk=1`` so the admin always edits one stable record,
    and ``delete`` is a no-op so the configuration can never be removed by
    accident. ``load`` returns the live row, creating it from field defaults the
    first time it is read.
    """

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        self.pk = 1
        # pk is forced, so the id-uniqueness check is meaningless here; field
        # validation still runs.
        self.full_clean(validate_unique=False)
        if not kwargs.get("force_insert") and type(self).objects.filter(pk=1).exists():
            # Any save of a second instance collapses onto the one canonical row.
            self._state.adding = False
            kwargs["force_update"] = True
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):  # pragma: no cover - defensive guard
        return (0, {})

    @classmethod
    def load(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class NationalDeskSettings(SingletonModel):
    """Global switches shared across the National Desk tab."""

    is_published = models.BooleanField(
        default=True,
        help_text="Master switch. When off, the public API reports the tab as unpublished.",
    )
    instagram_enabled = models.BooleanField(
        default=True,
        help_text="Show the 'Follow on Instagram' call to action.",
    )
    instagram_url = models.URLField(
        max_length=500,
        blank=True,
        default="",
        help_text="Destination for every 'Follow on Instagram' button.",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "National Desk settings"
        verbose_name_plural = "National Desk settings"

    def clean(self):
        super().clean()
        validate_safe_public_url(self.instagram_url, "instagram_url")

    def __str__(self):
        return "National Desk settings"


class FirFilingGuide(SingletonModel):
    """Page 1 — How to File an FIR."""

    badge_label = models.CharField(max_length=60, default="Practical Guide")
    section_label = models.CharField(max_length=60, default="Section 01")
    title = models.CharField(max_length=160, default="How to File an FIR")
    subtitle = models.TextField(
        max_length=600,
        default="Step-by-step guide to filing an FIR, from the complaint letter to the final process.",
    )
    hero_image = models.ImageField(
        upload_to="national_desk/fir/",
        blank=True,
        null=True,
        help_text="Optional override for the FIR form hero image (JPG/PNG).",
    )
    audio_kicker = models.CharField(max_length=60, default="Audio Guide")
    audio_title = models.CharField(max_length=200, default="FIR Filing Process – Step by Step")
    audio_duration = models.CharField(
        max_length=12,
        default="12:48",
        help_text="Display label only, e.g. 12:48.",
    )
    audio_file = models.FileField(
        upload_to="national_desk/audio/",
        blank=True,
        null=True,
        help_text="MP3, M4A, AAC, WAV, or OGG.",
    )
    is_active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Page 1 — How to File an FIR"
        verbose_name_plural = "Page 1 — How to File an FIR"

    def clean(self):
        super().clean()
        for field_name in ("badge_label", "section_label", "title", "subtitle", "audio_kicker", "audio_title", "audio_duration"):
            validate_no_active_content(getattr(self, field_name), field_name)
        validate_profile_image_upload(self.hero_image, "hero_image")
        validate_audio_upload(self.audio_file, "audio_file")

    def __str__(self):
        return self.title


class LawsSection(SingletonModel):
    """Page 2 — Laws to Know: header and the 'Stay Updated' call to action."""

    section_label = models.CharField(max_length=60, default="Section 05")
    title = models.CharField(
        max_length=200,
        default="Laws You Need to Know Before Going to a Police Station",
    )
    subtitle = models.TextField(
        max_length=600,
        default=(
            "Know your rights. Be prepared. These key laws will help you understand "
            "your legal position and ensure you're not taken advantage of."
        ),
    )
    hero_image = models.ImageField(
        upload_to="national_desk/laws/",
        blank=True,
        null=True,
        help_text="Optional override for the law books hero image (JPG/PNG).",
    )
    cta_kicker = models.CharField(max_length=60, default="Stay Updated")
    cta_title = models.CharField(max_length=160, default="Get the latest updates & new guides")
    cta_body = models.TextField(
        max_length=400,
        default=(
            "Follow us on Instagram for more legal awareness content, real-time "
            "updates and important announcements."
        ),
    )
    is_active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Page 2 — Laws section"
        verbose_name_plural = "Page 2 — Laws section"

    def clean(self):
        super().clean()
        for field_name in ("section_label", "title", "subtitle", "cta_kicker", "cta_title", "cta_body"):
            validate_no_active_content(getattr(self, field_name), field_name)
        validate_profile_image_upload(self.hero_image, "hero_image")

    def __str__(self):
        return self.title


class LawTopic(models.Model):
    """Page 2 — Laws to Know: a single row (audio, PDF download, or video collection)."""

    ICON_BOOK = "book"
    ICON_PERSON = "person"
    ICON_CLIPBOARD = "clipboard"
    ICON_SCALE = "scale"
    ICON_SHIELD = "shield"
    ICON_PDF = "pdf"
    ICON_VIDEO = "video"
    ICON_CHOICES = [
        (ICON_BOOK, "Book"),
        (ICON_PERSON, "Person"),
        (ICON_CLIPBOARD, "Clipboard / check"),
        (ICON_SCALE, "Scales of justice"),
        (ICON_SHIELD, "Shield"),
        (ICON_PDF, "PDF document"),
        (ICON_VIDEO, "Video camera"),
    ]

    ACTION_AUDIO = "audio"
    ACTION_PDF = "pdf"
    ACTION_VIDEO = "video"
    ACTION_CHOICES = [
        (ACTION_AUDIO, "Audio only (play button)"),
        (ACTION_PDF, "PDF download + listen guide"),
        (ACTION_VIDEO, "Video collection + listen guide"),
    ]

    action_type = models.CharField(
        max_length=10,
        choices=ACTION_CHOICES,
        default=ACTION_AUDIO,
        help_text="Controls which buttons the row shows on the Laws page.",
    )
    icon_key = models.CharField(max_length=20, choices=ICON_CHOICES, default=ICON_BOOK)
    title = models.CharField(max_length=160)
    body = models.TextField(max_length=600)
    audio_duration = models.CharField(
        max_length=12,
        blank=True,
        default="",
        help_text="Display label only, e.g. 04:32.",
    )
    audio_file = models.FileField(
        upload_to="national_desk/audio/",
        blank=True,
        null=True,
        help_text="Listen guide audio. MP3, M4A, AAC, WAV, or OGG.",
    )
    audio_note = models.CharField(
        max_length=300,
        blank=True,
        default="",
        help_text="Short line under the Listen Guide on the video detail panel.",
    )
    pdf_file = models.FileField(
        upload_to="national_desk/pdf/",
        blank=True,
        null=True,
        help_text="Downloadable document for 'PDF download' rows (PDF/DOC/DOCX).",
    )
    view_all_url = models.URLField(
        max_length=500,
        blank=True,
        default="",
        help_text="Optional 'View All' link on the video detail panel.",
    )
    sort_order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("sort_order", "pk")
        verbose_name = "Law topic (row)"
        verbose_name_plural = "Law topics (rows)"
        indexes = [
            models.Index(fields=("is_active", "sort_order"), name="nd_law_active_sort_idx"),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.body, "body")
        validate_no_active_content(self.audio_duration, "audio_duration")
        validate_no_active_content(self.audio_note, "audio_note")
        validate_audio_upload(self.audio_file, "audio_file")
        validate_resource_upload(self.pdf_file, "pdf_file")
        validate_safe_public_url(self.view_all_url, "view_all_url")

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self):
        return self.title


class LawTopicVideo(models.Model):
    """A single video example shown inside a 'Video collection' law topic."""

    topic = models.ForeignKey(
        LawTopic,
        on_delete=models.CASCADE,
        related_name="videos",
    )
    title = models.CharField(max_length=160)
    description = models.TextField(max_length=400, blank=True, default="")
    duration = models.CharField(
        max_length=12,
        blank=True,
        default="",
        help_text="Display label only, e.g. 2:14.",
    )
    video_url = models.URLField(
        max_length=500,
        blank=True,
        default="",
        help_text="Link to the video (YouTube, Drive, etc.). Used when no file is uploaded.",
    )
    video_file = models.FileField(
        upload_to="national_desk/video/",
        blank=True,
        null=True,
        help_text="Optional uploaded video (MP4, M4V, MOV, WEBM).",
    )
    thumbnail = models.ImageField(
        upload_to="national_desk/video_thumbs/",
        blank=True,
        null=True,
        help_text="Optional thumbnail image (JPG/PNG).",
    )
    sort_order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("sort_order", "pk")
        verbose_name = "Law topic video"
        verbose_name_plural = "Law topic videos"
        indexes = [
            models.Index(fields=("topic", "is_active", "sort_order"), name="nd_vid_topic_active_idx"),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.description, "description")
        validate_no_active_content(self.duration, "duration")
        validate_safe_public_url(self.video_url, "video_url")
        validate_video_upload(self.video_file, "video_file")
        validate_profile_image_upload(self.thumbnail, "thumbnail")

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self):
        return self.title


class TrackerOverview(SingletonModel):
    """Page 3 — FIR Process Across India: header, stat counters, and CTA."""

    section_label = models.CharField(max_length=60, default="National Progress")
    title = models.CharField(max_length=120, default="FIR Process Across India")
    subtitle = models.TextField(
        max_length=600,
        default=(
            "We are tracking FIRs filed across the country. Here you can see where "
            "the process is active, which locations have already registered FIRs, "
            "and where it is still in progress."
        ),
    )
    tagline = models.CharField(
        max_length=120,
        default="More FIRs. Stronger Voices. Across India.",
    )
    hero_image = models.ImageField(
        upload_to="national_desk/tracker/",
        blank=True,
        null=True,
        help_text="Optional override for the Supreme Court hero image (JPG/PNG).",
    )
    total_filed = models.PositiveIntegerField(default=37, help_text="Total FIRs Filed (So Far).")
    in_progress = models.PositiveIntegerField(default=18, help_text="In Progress (Locations).")
    completed = models.PositiveIntegerField(default=12, help_text="Completed (Locations).")
    planned = models.PositiveIntegerField(default=7, help_text="Planned / Upcoming (Locations).")
    updates_cta_kicker = models.CharField(
        max_length=120,
        default="See the Full List & Real-Time Progress",
    )
    updates_cta_body = models.TextField(
        max_length=400,
        default="View complete state-wise updates, detailed status, and new FIRs as they are added.",
    )
    full_tracker_url = models.URLField(
        max_length=500,
        blank=True,
        default="",
        help_text="Destination for the 'View Full Tracker' button.",
    )
    is_active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Page 3 — Tracker overview"
        verbose_name_plural = "Page 3 — Tracker overview"

    def clean(self):
        super().clean()
        for field_name in (
            "section_label",
            "title",
            "subtitle",
            "tagline",
            "updates_cta_kicker",
            "updates_cta_body",
        ):
            validate_no_active_content(getattr(self, field_name), field_name)
        validate_profile_image_upload(self.hero_image, "hero_image")
        validate_safe_public_url(self.full_tracker_url, "full_tracker_url")

    def __str__(self):
        return self.title


class TrackerUpdate(models.Model):
    """Page 3 — a single 'Latest Updates' entry (the live, admin-managed feed)."""

    STATUS_COMPLETED = "completed"
    STATUS_IN_PROGRESS = "in_progress"
    STATUS_PLANNED = "planned"
    STATUS_CHOICES = [
        (STATUS_COMPLETED, "Completed"),
        (STATUS_IN_PROGRESS, "In Progress"),
        (STATUS_PLANNED, "Planned"),
    ]

    city = models.CharField(max_length=120)
    region = models.CharField(max_length=120, help_text="State or union territory, e.g. Uttar Pradesh.")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_IN_PROGRESS)
    status_note = models.CharField(
        max_length=120,
        blank=True,
        default="",
        help_text="Sub-line under the location, e.g. 'FIR Registered' or 'Under Process'.",
    )
    event_date = models.DateField(help_text="Date shown against this update.")
    sort_order = models.PositiveIntegerField(
        default=0,
        help_text="Lower numbers appear first. Ties fall back to most recent date.",
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("sort_order", "-event_date", "-pk")
        verbose_name = "Tracker update (Latest Updates)"
        verbose_name_plural = "Tracker updates (Latest Updates)"
        indexes = [
            models.Index(fields=("is_active", "sort_order"), name="nd_upd_active_sort_idx"),
            models.Index(fields=("is_active", "event_date"), name="nd_upd_active_date_idx"),
        ]

    def clean(self):
        super().clean()
        validate_no_active_content(self.city, "city")
        validate_no_active_content(self.region, "region")
        validate_no_active_content(self.status_note, "status_note")

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.city}, {self.region}"
