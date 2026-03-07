import os

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone
from django.utils.text import slugify

from config.model_validators import (
    validate_no_active_content,
    validate_safe_public_stream_url,
    validate_safe_public_url,
)


class RealtimeSessionQuerySet(models.QuerySet):
    def with_related(self):
        return self.select_related(
            "host",
            "linked_course",
            "linked_live_class",
            "linked_live_class__linked_course",
        )


class RealtimeSession(models.Model):
    TYPE_MEETING = "meeting"
    TYPE_BROADCASTING = "broadcasting"
    SESSION_TYPE_CHOICES = [
        (TYPE_MEETING, "Meeting"),
        (TYPE_BROADCASTING, "Broadcasting"),
    ]

    STATUS_SCHEDULED = "scheduled"
    STATUS_LIVE = "live"
    STATUS_ENDED = "ended"
    STATUS_CHOICES = [
        (STATUS_SCHEDULED, "Scheduled"),
        (STATUS_LIVE, "Live"),
        (STATUS_ENDED, "Ended"),
    ]

    title = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255, unique=True, blank=True)
    description = models.TextField(blank=True, default="")
    session_type = models.CharField(
        max_length=20,
        choices=SESSION_TYPE_CHOICES,
        default=TYPE_MEETING,
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default=STATUS_SCHEDULED,
    )

    STREAM_IDLE = "idle"
    STREAM_STARTING = "starting"
    STREAM_LIVE = "live"
    STREAM_STOPPED = "stopped"
    STREAM_FAILED = "failed"
    STREAM_STATUS_CHOICES = [
        (STREAM_IDLE, "Idle"),
        (STREAM_STARTING, "Starting"),
        (STREAM_LIVE, "Live"),
        (STREAM_STOPPED, "Stopped"),
        (STREAM_FAILED, "Failed"),
    ]

    host = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="realtime_sessions",
    )
    linked_course = models.ForeignKey(
        "courses.Course",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="realtime_sessions",
    )
    linked_live_class = models.ForeignKey(
        "courses.LiveClass",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="realtime_sessions",
    )
    room_name = models.CharField(max_length=255, unique=True, blank=True)
    livekit_room_name = models.CharField(max_length=255, blank=True, default="")

    meeting_capacity = models.PositiveIntegerField(default=300)
    max_audience = models.PositiveIntegerField(default=50000)
    allow_overflow_broadcast = models.BooleanField(default=True)
    presenter_user_ids = models.JSONField(default=list, blank=True)

    stream_embed_url = models.URLField(blank=True, default="")
    chat_embed_url = models.URLField(blank=True, default="")
    rtmp_target_url = models.CharField(max_length=1024, blank=True, default="")
    stream_status = models.CharField(
        max_length=20,
        choices=STREAM_STATUS_CHOICES,
        default=STREAM_IDLE,
    )
    livekit_egress_id = models.CharField(max_length=255, blank=True, default="")
    livekit_egress_error = models.TextField(blank=True, default="")

    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["session_type", "status", "created_at"]),
            models.Index(fields=["host", "status"]),
            models.Index(fields=["room_name"]),
            models.Index(fields=["linked_course", "status"]),
            models.Index(fields=["linked_live_class", "status"]),
        ]
    objects = RealtimeSessionQuerySet.as_manager()

    def clean(self):
        super().clean()
        validate_no_active_content(self.title, "title")
        validate_no_active_content(self.description, "description")
        validate_no_active_content(self.room_name, "room_name")
        validate_no_active_content(self.livekit_room_name, "livekit_room_name")
        validate_no_active_content(self.rtmp_target_url, "rtmp_target_url")
        validate_safe_public_stream_url(self.rtmp_target_url, "rtmp_target_url")
        validate_safe_public_url(self.stream_embed_url, "stream_embed_url")
        validate_safe_public_url(self.chat_embed_url, "chat_embed_url")

        if self.meeting_capacity < 2:
            raise ValidationError({"meeting_capacity": "Meeting capacity must be at least 2."})
        if self.meeting_capacity > 300:
            raise ValidationError({"meeting_capacity": "Meeting capacity cannot exceed 300."})
        if self.max_audience < self.meeting_capacity:
            raise ValidationError(
                {"max_audience": "Max audience must be greater than or equal to meeting capacity."}
            )
        if self.max_audience > 50000:
            raise ValidationError({"max_audience": "Max audience cannot exceed 50000."})
        if not self.linked_live_class_id:
            if self.session_type == self.TYPE_MEETING:
                detail = "Select a linked live class for meeting sessions."
            else:
                detail = "Select a linked live class for broadcast sessions."
            raise ValidationError({"linked_live_class": detail})
        if not isinstance(self.presenter_user_ids, list):
            raise ValidationError({"presenter_user_ids": "Presenter user IDs must be a list."})
        normalized_presenters = self.get_presenter_user_ids()
        if len(normalized_presenters) > 1000:
            raise ValidationError({"presenter_user_ids": "Too many presenter overrides for one session."})

    def save(self, *args, **kwargs):
        if not self.slug:
            base_slug = slugify(self.title)[:220] or "session"
            slug = base_slug
            index = 1
            while RealtimeSession.objects.exclude(pk=self.pk).filter(slug=slug).exists():
                slug = f"{base_slug}-{index}"
                index += 1
            self.slug = slug

        if not self.room_name:
            base_room_name = slugify(self.title)[:220] or "session-room"
            room_name = base_room_name
            index = 1
            while RealtimeSession.objects.exclude(pk=self.pk).filter(room_name=room_name).exists():
                room_name = f"{base_room_name}-{index}"
                index += 1
            self.room_name = room_name

        if not self.livekit_room_name:
            self.livekit_room_name = self.room_name

        if self.linked_live_class_id and not self.linked_course_id:
            self.linked_course_id = self.linked_live_class.linked_course_id

        if self.status == self.STATUS_LIVE and self.started_at is None:
            self.started_at = timezone.now()
        if self.status == self.STATUS_ENDED and self.ended_at is None:
            self.ended_at = timezone.now()

        super().save(*args, **kwargs)

    def mark_live(self):
        self.status = self.STATUS_LIVE
        self.started_at = self.started_at or timezone.now()
        self.ended_at = None
        self.save(update_fields=["status", "started_at", "ended_at", "updated_at"])

    def mark_ended(self):
        self.status = self.STATUS_ENDED
        self.ended_at = timezone.now()
        self.save(update_fields=["status", "ended_at", "updated_at"])

    def mark_stream_starting(self):
        self.stream_status = self.STREAM_STARTING
        self.livekit_egress_error = ""
        self.save(update_fields=["stream_status", "livekit_egress_error", "updated_at"])

    def mark_stream_live(self, egress_id):
        self.stream_status = self.STREAM_LIVE
        self.livekit_egress_id = egress_id or self.livekit_egress_id
        self.livekit_egress_error = ""
        self.save(
            update_fields=[
                "stream_status",
                "livekit_egress_id",
                "livekit_egress_error",
                "updated_at",
            ]
        )

    def mark_stream_stopped(self):
        self.stream_status = self.STREAM_STOPPED
        self.livekit_egress_id = ""
        self.livekit_egress_error = ""
        self.save(
            update_fields=[
                "stream_status",
                "livekit_egress_id",
                "livekit_egress_error",
                "updated_at",
            ]
        )

    def mark_stream_failed(self, message):
        self.stream_status = self.STREAM_FAILED
        self.livekit_egress_error = str(message or "")[:1000]
        self.save(update_fields=["stream_status", "livekit_egress_error", "updated_at"])

    def get_presenter_user_ids(self):
        normalized = []
        seen = set()
        for value in self.presenter_user_ids or []:
            try:
                user_id = int(value)
            except (TypeError, ValueError):
                continue
            if user_id <= 0 or user_id in seen:
                continue
            normalized.append(user_id)
            seen.add(user_id)
        return sorted(normalized)

    def is_presenter_allowed(self, user):
        if not user or not getattr(user, "is_authenticated", False):
            return False
        is_admin = bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
        is_instructor = getattr(user, "role", "") == "instructor"
        if is_admin or is_instructor or user.id == self.host_id:
            return True
        return user.id in self.get_presenter_user_ids()

    def grant_presenter(self, user_id):
        presenter_ids = self.get_presenter_user_ids()
        if user_id not in presenter_ids:
            presenter_ids.append(int(user_id))
        self.presenter_user_ids = sorted(set(presenter_ids))
        self.save(update_fields=["presenter_user_ids", "updated_at"])
        return self.presenter_user_ids

    def revoke_presenter(self, user_id):
        presenter_ids = [row for row in self.get_presenter_user_ids() if row != int(user_id)]
        self.presenter_user_ids = presenter_ids
        self.save(update_fields=["presenter_user_ids", "updated_at"])
        return self.presenter_user_ids

    def __str__(self):
        return self.title


def realtime_recording_upload_path(instance, filename):
    original_name = str(filename or "").strip() or "recording.webm"
    base_name, ext = os.path.splitext(original_name)
    safe_ext = ext.lower() if ext else ".webm"
    session_slug = slugify(getattr(instance.session, "slug", "") or getattr(instance.session, "title", "session"))
    if not session_slug:
        session_slug = "session"
    timestamp = timezone.now().strftime("%Y%m%d-%H%M%S")
    return f"realtime_recordings/{session_slug}/{timestamp}-{slugify(base_name)[:80] or 'recording'}{safe_ext}"


class RealtimeSessionRecording(models.Model):
    STATUS_STARTING = "starting"
    STATUS_RECORDING = "recording"
    STATUS_STOPPING = "stopping"
    STATUS_COMPLETED = "completed"
    STATUS_FAILED = "failed"
    STATUS_CHOICES = [
        (STATUS_STARTING, "Starting"),
        (STATUS_RECORDING, "Recording"),
        (STATUS_STOPPING, "Stopping"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_FAILED, "Failed"),
    ]
    ACTIVE_STATUSES = {STATUS_STARTING, STATUS_RECORDING, STATUS_STOPPING}

    session = models.ForeignKey(
        RealtimeSession,
        on_delete=models.CASCADE,
        related_name="recordings",
    )
    recording_type = models.CharField(
        max_length=20,
        choices=RealtimeSession.SESSION_TYPE_CHOICES,
        default=RealtimeSession.TYPE_MEETING,
    )
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="realtime_recordings_started",
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default=STATUS_STARTING,
    )
    livekit_egress_id = models.CharField(max_length=255, blank=True, default="")
    output_file_path = models.CharField(max_length=1024, blank=True, default="")
    output_download_url = models.URLField(blank=True, default="")
    video_file = models.FileField(upload_to=realtime_recording_upload_path, blank=True, null=True)
    livekit_payload = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Recording"
        verbose_name_plural = "Recordings"
        indexes = [
            models.Index(fields=["session", "status", "created_at"]),
            models.Index(fields=["livekit_egress_id"]),
        ]

    def _merge_payload(self, payload):
        merged = {}
        if isinstance(self.livekit_payload, dict):
            merged.update(self.livekit_payload)
        if isinstance(payload, dict):
            merged.update(payload)
        self.livekit_payload = merged

    def mark_recording(self, *, egress_id="", payload=None):
        self.status = self.STATUS_RECORDING
        if egress_id:
            self.livekit_egress_id = str(egress_id)
        self.error = ""
        self.started_at = self.started_at or timezone.now()
        self._merge_payload(payload)
        self.save(
            update_fields=[
                "status",
                "livekit_egress_id",
                "error",
                "started_at",
                "livekit_payload",
                "updated_at",
            ]
        )

    def mark_stopping(self):
        self.status = self.STATUS_STOPPING
        self.save(update_fields=["status", "updated_at"])

    def mark_completed(self, *, file_path="", file_url="", payload=None):
        self.status = self.STATUS_COMPLETED
        if file_path:
            self.output_file_path = str(file_path)[:1024]
        if file_url:
            self.output_download_url = str(file_url)
        self.error = ""
        self.ended_at = timezone.now()
        self._merge_payload(payload)
        self.save(
            update_fields=[
                "status",
                "output_file_path",
                "output_download_url",
                "error",
                "ended_at",
                "livekit_payload",
                "updated_at",
            ]
        )

    def mark_failed(self, message, *, payload=None):
        self.status = self.STATUS_FAILED
        self.error = str(message or "")[:2000]
        self.ended_at = self.ended_at or timezone.now()
        self._merge_payload(payload)
        self.save(
            update_fields=[
                "status",
                "error",
                "ended_at",
                "livekit_payload",
                "updated_at",
            ]
        )

    def __str__(self):
        return f"{self.session.title} recording #{self.pk}"


class RealtimeConfiguration(models.Model):
    broadcast_capture_width = models.PositiveIntegerField(default=640)
    broadcast_capture_height = models.PositiveIntegerField(default=360)
    broadcast_capture_fps = models.PositiveIntegerField(default=20)
    broadcast_max_video_bitrate_kbps = models.PositiveIntegerField(default=650)
    meeting_camera_capture_width = models.PositiveIntegerField(default=1280)
    meeting_camera_capture_height = models.PositiveIntegerField(default=720)
    meeting_camera_capture_fps = models.PositiveIntegerField(default=24)
    meeting_camera_max_video_bitrate_kbps = models.PositiveIntegerField(default=1200)
    meeting_screen_capture_width = models.PositiveIntegerField(default=1920)
    meeting_screen_capture_height = models.PositiveIntegerField(default=1080)
    meeting_screen_capture_fps = models.PositiveIntegerField(default=15)
    meeting_screen_max_video_bitrate_kbps = models.PositiveIntegerField(default=2500)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Realtime Configuration"
        verbose_name_plural = "Realtime Configuration"

    def clean(self):
        super().clean()
        if self.broadcast_capture_width < 320 or self.broadcast_capture_width > 1920:
            raise ValidationError({"broadcast_capture_width": "Width must be between 320 and 1920."})
        if self.broadcast_capture_height < 180 or self.broadcast_capture_height > 1080:
            raise ValidationError({"broadcast_capture_height": "Height must be between 180 and 1080."})
        if self.broadcast_capture_fps < 10 or self.broadcast_capture_fps > 30:
            raise ValidationError({"broadcast_capture_fps": "FPS must be between 10 and 30."})
        if self.broadcast_max_video_bitrate_kbps < 200 or self.broadcast_max_video_bitrate_kbps > 4000:
            raise ValidationError(
                {"broadcast_max_video_bitrate_kbps": "Bitrate must be between 200 and 4000 kbps."}
            )
        if self.meeting_camera_capture_width < 320 or self.meeting_camera_capture_width > 1920:
            raise ValidationError(
                {"meeting_camera_capture_width": "Meeting camera width must be between 320 and 1920."}
            )
        if self.meeting_camera_capture_height < 180 or self.meeting_camera_capture_height > 1080:
            raise ValidationError(
                {"meeting_camera_capture_height": "Meeting camera height must be between 180 and 1080."}
            )
        if self.meeting_camera_capture_fps < 10 or self.meeting_camera_capture_fps > 30:
            raise ValidationError(
                {"meeting_camera_capture_fps": "Meeting camera FPS must be between 10 and 30."}
            )
        if (
            self.meeting_camera_max_video_bitrate_kbps < 200
            or self.meeting_camera_max_video_bitrate_kbps > 6000
        ):
            raise ValidationError(
                {
                    "meeting_camera_max_video_bitrate_kbps": (
                        "Meeting camera bitrate must be between 200 and 6000 kbps."
                    )
                }
            )
        if self.meeting_screen_capture_width < 640 or self.meeting_screen_capture_width > 3840:
            raise ValidationError(
                {"meeting_screen_capture_width": "Meeting screen width must be between 640 and 3840."}
            )
        if self.meeting_screen_capture_height < 360 or self.meeting_screen_capture_height > 2160:
            raise ValidationError(
                {"meeting_screen_capture_height": "Meeting screen height must be between 360 and 2160."}
            )
        if self.meeting_screen_capture_fps < 5 or self.meeting_screen_capture_fps > 30:
            raise ValidationError(
                {"meeting_screen_capture_fps": "Meeting screen FPS must be between 5 and 30."}
            )
        if (
            self.meeting_screen_max_video_bitrate_kbps < 500
            or self.meeting_screen_max_video_bitrate_kbps > 12000
        ):
            raise ValidationError(
                {
                    "meeting_screen_max_video_bitrate_kbps": (
                        "Meeting screen bitrate must be between 500 and 12000 kbps."
                    )
                }
            )

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def get_solo(cls):
        obj, _ = cls.objects.get_or_create(
            pk=1,
            defaults={
                "broadcast_capture_width": 640,
                "broadcast_capture_height": 360,
                "broadcast_capture_fps": 20,
                "broadcast_max_video_bitrate_kbps": 650,
                "meeting_camera_capture_width": 1280,
                "meeting_camera_capture_height": 720,
                "meeting_camera_capture_fps": 24,
                "meeting_camera_max_video_bitrate_kbps": 1200,
                "meeting_screen_capture_width": 1920,
                "meeting_screen_capture_height": 1080,
                "meeting_screen_capture_fps": 15,
                "meeting_screen_max_video_bitrate_kbps": 2500,
            },
        )
        return obj

    def to_broadcast_dict(self):
        return {
            "capture_width": self.broadcast_capture_width,
            "capture_height": self.broadcast_capture_height,
            "fps": self.broadcast_capture_fps,
            "max_video_bitrate_kbps": self.broadcast_max_video_bitrate_kbps,
        }

    def to_meeting_dict(self):
        return {
            "camera_capture_width": self.meeting_camera_capture_width,
            "camera_capture_height": self.meeting_camera_capture_height,
            "camera_fps": self.meeting_camera_capture_fps,
            "camera_max_video_bitrate_kbps": self.meeting_camera_max_video_bitrate_kbps,
            "screen_capture_width": self.meeting_screen_capture_width,
            "screen_capture_height": self.meeting_screen_capture_height,
            "screen_fps": self.meeting_screen_capture_fps,
            "screen_max_video_bitrate_kbps": self.meeting_screen_max_video_bitrate_kbps,
        }

    def to_dict(self):
        # Backwards-compatible alias used by broadcast host-token payloads.
        return self.to_broadcast_dict()

    def __str__(self):
        return "Realtime Configuration"
