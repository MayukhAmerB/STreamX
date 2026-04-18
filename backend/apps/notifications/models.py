from django.conf import settings
from django.db import models
from django.utils import timezone


class Notification(models.Model):
    KIND_COURSE_VIDEO_UPLOADED = "course_video_uploaded"
    KIND_LIVE_CLASS_STARTED = "live_class_started"
    KIND_ANNOUNCEMENT = "announcement"
    KIND_CHOICES = [
        (KIND_COURSE_VIDEO_UPLOADED, "Course video uploaded"),
        (KIND_LIVE_CLASS_STARTED, "Live class started"),
        (KIND_ANNOUNCEMENT, "Announcement"),
    ]

    kind = models.CharField(max_length=40, choices=KIND_CHOICES)
    title = models.CharField(max_length=180)
    body = models.TextField()
    action_url = models.CharField(max_length=512, blank=True, default="")
    event_key = models.CharField(max_length=220, unique=True)
    course = models.ForeignKey(
        "courses.Course",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="notifications",
    )
    lecture = models.ForeignKey(
        "courses.Lecture",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="notifications",
    )
    live_class = models.ForeignKey(
        "courses.LiveClass",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="notifications",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_notifications",
    )
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["kind", "created_at"]),
            models.Index(fields=["course", "created_at"]),
            models.Index(fields=["live_class", "created_at"]),
        ]

    def __str__(self):
        return f"{self.get_kind_display()}: {self.title}"


class NotificationRecipient(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notification_recipients",
    )
    notification = models.ForeignKey(
        Notification,
        on_delete=models.CASCADE,
        related_name="recipients",
    )
    read_at = models.DateTimeField(null=True, blank=True)
    pushed_at = models.DateTimeField(null=True, blank=True)
    push_error = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "notification"],
                name="notifications_recipient_user_notification_unique",
            )
        ]
        indexes = [
            models.Index(fields=["user", "read_at", "created_at"]),
            models.Index(fields=["user", "created_at"]),
        ]

    def __str__(self):
        return f"{self.user_id}:{self.notification_id}"


class WebPushSubscription(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="web_push_subscriptions",
    )
    endpoint = models.CharField(max_length=2048, unique=True)
    p256dh = models.CharField(max_length=255)
    auth = models.CharField(max_length=255)
    user_agent = models.CharField(max_length=255, blank=True, default="")
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    last_seen_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-last_seen_at", "-id"]
        indexes = [
            models.Index(fields=["user", "is_active"]),
            models.Index(fields=["is_active", "last_seen_at"]),
        ]

    def __str__(self):
        return f"{self.user_id}:{self.endpoint[:60]}"
