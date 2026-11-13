import urllib.parse

from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator, RegexValidator
from django.db import models

from .youtube import CHANNEL_ID_RE, HANDLE_RE, YOUTUBE_HOSTS, parse_video_id

DEFAULT_CHANNEL_ID = "UCcv6HKwcrR8oDSUcPjeFBfg"
DEFAULT_HANDLE = "@thesy3d"
DEFAULT_CHANNEL_URL = "https://www.youtube.com/@thesy3d"


def validate_channel_url(value):
    """Only a plain https link to a youtube.com page (no credentials or ports)."""
    if not value:
        return
    try:
        parts = urllib.parse.urlsplit(str(value).strip())
        port = parts.port
    except ValueError:
        raise ValidationError("Enter a valid YouTube channel link.") from None
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or host not in YOUTUBE_HOSTS or port is not None or "@" in parts.netloc:
        raise ValidationError("Use an https://www.youtube.com/... channel link.")
    if not parts.path.strip("/"):
        raise ValidationError("The link must point to the channel, e.g. https://www.youtube.com/@thesy3d.")


def validate_featured_video_url(value):
    if value and not parse_video_id(value):
        raise ValidationError(
            "Paste a YouTube video link (watch, youtu.be, live, shorts or embed link) or an 11-character video ID."
        )


class YouTubeChannel(models.Model):
    """Singleton (pk=1): the YouTube channel shown on the public website."""

    channel_id = models.CharField(
        max_length=24,
        default=DEFAULT_CHANNEL_ID,
        validators=[RegexValidator(CHANNEL_ID_RE, "A channel ID starts with UC and has 24 characters.")],
        help_text="The UC... ID: on YouTube open the channel, About, Share channel, Copy channel ID.",
    )
    channel_title = models.CharField(max_length=120, default="Al Syed", help_text="Shown on the website.")
    handle = models.CharField(
        max_length=101,
        blank=True,
        default=DEFAULT_HANDLE,
        validators=[RegexValidator(HANDLE_RE, "A handle looks like @thesy3d.")],
    )
    channel_url = models.URLField(
        max_length=300,
        blank=True,
        default=DEFAULT_CHANNEL_URL,
        validators=[validate_channel_url],
        help_text="Link for the View channel and Subscribe buttons.",
    )
    section_enabled = models.BooleanField(
        default=True,
        help_text="Show the Watch section on the landing page, the Watch page and the navbar link.",
    )
    section_title = models.CharField(max_length=120, default="Watch Al Syed")
    section_subtitle = models.CharField(
        max_length=240,
        blank=True,
        default="Free live classes, investigations and talks from our YouTube channel.",
    )
    featured_video_url = models.CharField(
        "Featured video URL",
        max_length=300,
        blank=True,
        validators=[validate_featured_video_url],
        help_text=(
            "Optional. Pin a video to the main player (any YouTube link or video ID). "
            "Leave empty to feature the latest upload."
        ),
    )
    latest_count = models.PositiveSmallIntegerField(
        "Latest videos to show",
        default=6,
        validators=[MinValueValidator(1), MaxValueValidator(15)],
        help_text="1 to 15 (YouTube's public feed lists at most 15).",
    )
    prefer_live = models.BooleanField(
        "Prefer live when live",
        default=True,
        help_text="While the channel is live, show the live stream in the main player.",
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "YouTube channel"
        verbose_name_plural = "YouTube channel"

    def __str__(self):
        return f"YouTube channel ({self.handle or self.channel_id})"

    def save(self, *args, **kwargs):
        self.pk = 1
        self.channel_id = (self.channel_id or "").strip()
        self.handle = (self.handle or "").strip()
        self.channel_url = (self.channel_url or "").strip()
        self.featured_video_url = (self.featured_video_url or "").strip()
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("The YouTube channel settings cannot be deleted; turn the section off instead.")

    @classmethod
    def load(cls):
        obj = cls.objects.filter(pk=1).first()
        return obj if obj is not None else cls(pk=1)

    @property
    def featured_video_id(self):
        return parse_video_id(self.featured_video_url)
