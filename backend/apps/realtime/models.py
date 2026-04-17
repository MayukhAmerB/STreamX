import os
import re
import hashlib
import secrets
from urllib.parse import urlparse

from django.conf import settings
from django.core import signing
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
    STREAM_SERVICE_ALSYED = "alsyed_stream"
    STREAM_SERVICE_OBS = "obs_stream"
    MAX_MEETING_CAPACITY = 200
    MAX_AUDIENCE_LIMIT = 500
    MAX_STAGE_PARTICIPANTS = 5
    SESSION_TYPE_CHOICES = [
        (TYPE_MEETING, "Meeting"),
        (TYPE_BROADCASTING, "Broadcasting"),
    ]
    STREAM_SERVICE_CHOICES = [
        (STREAM_SERVICE_ALSYED, "Alsyed Stream (Browser Host Studio)"),
        (STREAM_SERVICE_OBS, "Alsyed OBS Stream"),
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

    meeting_capacity = models.PositiveIntegerField(default=MAX_MEETING_CAPACITY)
    max_audience = models.PositiveIntegerField(default=MAX_AUDIENCE_LIMIT)
    allow_overflow_broadcast = models.BooleanField(default=True)
    presenter_user_ids = models.JSONField(default=list, blank=True)
    speaker_user_ids = models.JSONField(default=list, blank=True)
    stream_service = models.CharField(
        max_length=20,
        choices=STREAM_SERVICE_CHOICES,
        default=STREAM_SERVICE_ALSYED,
    )
    obs_stream_key = models.CharField(max_length=120, blank=True, default="")

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
        validate_no_active_content(self.obs_stream_key, "obs_stream_key")
        validate_safe_public_stream_url(self.rtmp_target_url, "rtmp_target_url")
        validate_safe_public_url(self.stream_embed_url, "stream_embed_url")
        validate_safe_public_url(self.chat_embed_url, "chat_embed_url")

        if self.meeting_capacity < 2:
            raise ValidationError({"meeting_capacity": "Meeting capacity must be at least 2."})
        if self.meeting_capacity > self.MAX_MEETING_CAPACITY:
            raise ValidationError(
                {"meeting_capacity": f"Meeting capacity cannot exceed {self.MAX_MEETING_CAPACITY}."}
            )
        if self.max_audience < self.meeting_capacity:
            raise ValidationError(
                {"max_audience": "Max audience must be greater than or equal to meeting capacity."}
            )
        if self.max_audience > self.MAX_AUDIENCE_LIMIT:
            raise ValidationError(
                {"max_audience": f"Max audience cannot exceed {self.MAX_AUDIENCE_LIMIT}."}
            )
        if not self.linked_live_class_id:
            if self.session_type == self.TYPE_MEETING:
                detail = "Select a linked live class for meeting sessions."
            else:
                detail = "Select a linked live class for broadcast sessions."
            raise ValidationError({"linked_live_class": detail})
        if self.session_type == self.TYPE_MEETING and self.stream_service != self.STREAM_SERVICE_ALSYED:
            raise ValidationError({"stream_service": "Meeting sessions support only Alsyed Stream mode."})
        obs_key = str(self.obs_stream_key or "").strip()
        if obs_key and not re.match(r"^[A-Za-z0-9._~-]{8,120}$", obs_key):
            raise ValidationError(
                {
                    "obs_stream_key": (
                        "OBS stream key may contain letters, numbers, dot, underscore, tilde, and dash only."
                    )
                }
            )
        if not isinstance(self.presenter_user_ids, list):
            raise ValidationError({"presenter_user_ids": "Presenter user IDs must be a list."})
        normalized_presenters = self.get_presenter_user_ids()
        if len(normalized_presenters) > self.MAX_STAGE_PARTICIPANTS:
            raise ValidationError(
                {"presenter_user_ids": f"Stage supports up to {self.MAX_STAGE_PARTICIPANTS} participants."}
            )
        if not isinstance(self.speaker_user_ids, list):
            raise ValidationError({"speaker_user_ids": "Speaker user IDs must be a list."})
        normalized_speakers = self.get_speaker_user_ids()
        if len(normalized_speakers) > 1000:
            raise ValidationError({"speaker_user_ids": "Too many speaker overrides for one session."})

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
        self.obs_stream_key = str(self.obs_stream_key or "").strip()
        if self.session_type == self.TYPE_BROADCASTING and self.stream_service == self.STREAM_SERVICE_OBS:
            self.obs_stream_key = self.obs_stream_key or self.default_obs_stream_key()

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
        self.livekit_egress_id = egress_id or ""
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

    @staticmethod
    def _extract_stream_key_from_target(raw_target):
        value = str(raw_target or "").strip()
        if not value:
            return ""
        parsed = urlparse(value)
        path_rows = [row for row in str(parsed.path or "").split("/") if row]
        return path_rows[-1] if path_rows else ""

    @staticmethod
    def _extract_server_url_from_target(raw_target):
        value = str(raw_target or "").strip()
        if not value:
            return ""
        parsed = urlparse(value)
        if not parsed.scheme or not parsed.netloc:
            return ""
        path_rows = [row for row in str(parsed.path or "").split("/") if row]
        base_path = ""
        if len(path_rows) > 1:
            base_path = "/" + "/".join(path_rows[:-1])
        elif len(path_rows) == 1:
            base_path = f"/{path_rows[0]}"
        return f"{parsed.scheme}://{parsed.netloc}{base_path}".rstrip("/")

    @classmethod
    def generate_obs_stream_key(cls):
        generated = re.sub(r"[^A-Za-z0-9]", "", secrets.token_urlsafe(36))
        if len(generated) < 20:
            generated = f"{generated}{secrets.token_hex(16)}"
        return generated[:60]

    def default_obs_stream_key(self):
        candidates = [
            getattr(settings, "OWNCAST_STREAM_KEY", ""),
            self._extract_stream_key_from_target(getattr(settings, "OWNCAST_RTMP_TARGET", "")),
            self._extract_stream_key_from_target(self.rtmp_target_url),
        ]
        for candidate in candidates:
            normalized = str(candidate or "").strip()
            if normalized:
                return normalized
        return self.generate_obs_stream_key()

    def resolve_obs_stream_server_url(self):
        explicit_server_url = str(getattr(settings, "OWNCAST_OBS_STREAM_SERVER_URL", "") or "").strip()
        if explicit_server_url:
            return explicit_server_url.rstrip("/")
        candidates = [
            self._extract_server_url_from_target(getattr(settings, "OWNCAST_RTMP_TARGET", "")),
            self._extract_server_url_from_target(self.rtmp_target_url),
        ]
        for candidate in candidates:
            normalized = str(candidate or "").strip()
            if normalized:
                return normalized.rstrip("/")
        return "rtmp://owncast:1935/live"

    def resolve_stream_target_url(self):
        if self.stream_service == self.STREAM_SERVICE_OBS:
            server_url = self.resolve_obs_stream_server_url()
            stream_key = str(self.obs_stream_key or "").strip() or self.default_obs_stream_key()
            return f"{server_url.rstrip('/')}/{stream_key}".rstrip("/")
        return (self.rtmp_target_url or "").strip() or (
            getattr(settings, "OWNCAST_RTMP_TARGET", "") or ""
        ).strip()

    def rotate_obs_stream_key(self, *, save=True):
        self.obs_stream_key = self.generate_obs_stream_key()
        if save:
            self.save(update_fields=["obs_stream_key", "updated_at"])
        return self.obs_stream_key

    def get_presenter_user_ids(self):
        return self._normalize_user_id_list(self.presenter_user_ids)

    def get_speaker_user_ids(self):
        return self._normalize_user_id_list(self.speaker_user_ids)

    def _normalize_user_id_list(self, raw_values):
        normalized = []
        seen = set()
        for value in raw_values or []:
            try:
                user_id = int(value)
            except (TypeError, ValueError):
                continue
            if user_id <= 0 or user_id in seen:
                continue
            normalized.append(user_id)
            seen.add(user_id)
        return sorted(normalized)

    def get_instructor_user_id(self):
        if self.linked_course_id and getattr(self.linked_course, "instructor_id", None):
            return self.linked_course.instructor_id
        if self.linked_live_class_id and getattr(getattr(self.linked_live_class, "linked_course", None), "instructor_id", None):
            return self.linked_live_class.linked_course.instructor_id
        return None

    def is_instructor_owner(self, user):
        if not user or not getattr(user, "is_authenticated", False):
            return False
        instructor_user_id = self.get_instructor_user_id()
        return bool(instructor_user_id and getattr(user, "id", None) == instructor_user_id)

    def is_moderator_allowed(self, user):
        if not user or not getattr(user, "is_authenticated", False):
            return False
        is_admin = bool(getattr(user, "is_staff", False) or getattr(user, "is_superuser", False))
        return bool(is_admin or user.id == self.host_id or self.is_instructor_owner(user))

    def is_presenter_allowed(self, user):
        if self.is_moderator_allowed(user):
            return True
        return bool(user and getattr(user, "is_authenticated", False) and user.id in self.get_presenter_user_ids())

    def is_speaker_allowed(self, user):
        if self.is_moderator_allowed(user):
            return True
        return bool(user and getattr(user, "is_authenticated", False) and user.id in self.get_speaker_user_ids())

    def grant_presenter(self, user_id):
        presenter_ids = self.get_presenter_user_ids()
        try:
            normalized_user_id = int(user_id)
        except (TypeError, ValueError):
            return presenter_ids
        if normalized_user_id <= 0:
            return presenter_ids
        if normalized_user_id in presenter_ids:
            return presenter_ids
        if len(presenter_ids) >= self.MAX_STAGE_PARTICIPANTS:
            raise ValidationError(
                {"detail": f"Stage is full. Maximum {self.MAX_STAGE_PARTICIPANTS} participants are allowed."}
            )
        presenter_ids.append(normalized_user_id)
        self.presenter_user_ids = sorted(set(presenter_ids))
        self.save(update_fields=["presenter_user_ids", "updated_at"])
        return self.presenter_user_ids

    def revoke_presenter(self, user_id):
        try:
            normalized_user_id = int(user_id)
        except (TypeError, ValueError):
            return self.get_presenter_user_ids()
        presenter_ids = [row for row in self.get_presenter_user_ids() if row != normalized_user_id]
        self.presenter_user_ids = presenter_ids
        self.save(update_fields=["presenter_user_ids", "updated_at"])
        return self.presenter_user_ids

    def grant_speaker(self, user_id):
        speaker_ids = self.get_speaker_user_ids()
        if user_id not in speaker_ids:
            speaker_ids.append(int(user_id))
        self.speaker_user_ids = sorted(set(speaker_ids))
        self.save(update_fields=["speaker_user_ids", "updated_at"])
        return self.speaker_user_ids

    def revoke_speaker(self, user_id):
        speaker_ids = [row for row in self.get_speaker_user_ids() if row != int(user_id)]
        self.speaker_user_ids = speaker_ids
        self.save(update_fields=["speaker_user_ids", "updated_at"])
        return self.speaker_user_ids

    def __str__(self):
        return self.title


class OwncastChatIdentity(models.Model):
    ACCESS_TOKEN_SIGNING_SALT = "realtime.owncast-chat-identity-token"

    session = models.ForeignKey(
        RealtimeSession,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="owncast_chat_identities",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="owncast_chat_identities",
    )
    platform_user_id = models.PositiveBigIntegerField(unique=True)
    platform_email = models.EmailField(blank=True, default="")
    platform_full_name = models.CharField(max_length=255, blank=True, default="")
    platform_role = models.CharField(max_length=40, blank=True, default="")
    platform_display_name = models.CharField(max_length=120, blank=True, default="")
    owncast_user_id = models.CharField(max_length=120, blank=True, default="")
    owncast_display_name = models.CharField(max_length=120)
    owncast_display_color = models.CharField(max_length=32, blank=True, default="")
    owncast_authenticated = models.BooleanField(default=False)
    owncast_is_moderator = models.BooleanField(default=False)
    access_token_hash = models.CharField(max_length=64, blank=True, default="")
    access_token_secret = models.TextField(blank=True, default="")
    launch_ip = models.CharField(max_length=64, blank=True, default="")
    user_agent = models.CharField(max_length=255, blank=True, default="")
    bridge_used_at = models.DateTimeField(null=True, blank=True)
    owncast_disabled_at = models.DateTimeField(null=True, blank=True)
    owncast_timeout_until = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "Handle"
        verbose_name_plural = "Handles"
        indexes = [
            models.Index(fields=["owncast_display_name", "created_at"]),
            models.Index(fields=["owncast_user_id"]),
            models.Index(fields=["session", "created_at"]),
            models.Index(fields=["access_token_hash"]),
            models.Index(fields=["owncast_timeout_until"]),
        ]

    @staticmethod
    def hash_access_token(access_token):
        normalized = str(access_token or "").strip()
        if not normalized:
            return ""
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    @classmethod
    def seal_access_token(cls, access_token):
        normalized = str(access_token or "").strip()
        if not normalized:
            return ""
        return signing.dumps(
            {"access_token": normalized},
            salt=cls.ACCESS_TOKEN_SIGNING_SALT,
            compress=True,
        )

    def reveal_access_token(self):
        if not self.access_token_secret:
            return ""
        try:
            payload = signing.loads(
                self.access_token_secret,
                salt=self.ACCESS_TOKEN_SIGNING_SALT,
            )
        except signing.BadSignature:
            return ""
        if not isinstance(payload, dict):
            return ""
        return str(payload.get("access_token") or "").strip()

    def __str__(self):
        return f"{self.owncast_display_name} -> {self.platform_email or self.platform_user_id}"


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
    BROADCAST_QUALITY_MODE_LOW = "low"
    BROADCAST_QUALITY_MODE_PREMIUM_HD = "premium_hd"
    BROADCAST_QUALITY_MODE_ADAPTIVE = "adaptive"
    BROADCAST_QUALITY_MODE_CHOICES = [
        (BROADCAST_QUALITY_MODE_LOW, "Low"),
        (BROADCAST_QUALITY_MODE_PREMIUM_HD, "Premium HD"),
        (BROADCAST_QUALITY_MODE_ADAPTIVE, "Adaptive"),
    ]
    BROADCAST_LOW_PROFILE = {
        "capture_width": 640,
        "capture_height": 360,
        "fps": 20,
        "max_video_bitrate_kbps": 650,
    }
    BROADCAST_PREMIUM_PROFILE = {
        "capture_width": 1920,
        "capture_height": 1080,
        "fps": 30,
        "max_video_bitrate_kbps": 3800,
    }
    BROADCAST_ADAPTIVE_BASE_PROFILE = {
        "capture_width": 1280,
        "capture_height": 720,
        "fps": 24,
        "max_video_bitrate_kbps": 1500,
    }
    BROADCAST_CONSTRAINED_PROFILE = {
        "capture_width": 854,
        "capture_height": 480,
        "fps": 20,
        "max_video_bitrate_kbps": 1100,
    }
    MEETING_QUALITY_MODE_LOW = "low"
    MEETING_QUALITY_MODE_PREMIUM_HD = "premium_hd"
    MEETING_QUALITY_MODE_ADAPTIVE = "adaptive"
    MEETING_QUALITY_MODE_CHOICES = [
        (MEETING_QUALITY_MODE_LOW, "Low"),
        (MEETING_QUALITY_MODE_PREMIUM_HD, "Premium HD"),
        (MEETING_QUALITY_MODE_ADAPTIVE, "Adaptive"),
    ]
    MEETING_LOW_PROFILE = {
        "camera_capture_width": 854,
        "camera_capture_height": 480,
        "camera_fps": 20,
        "camera_max_video_bitrate_kbps": 850,
        "screen_capture_width": 854,
        "screen_capture_height": 480,
        "screen_fps": 12,
        "screen_max_video_bitrate_kbps": 1400,
    }
    MEETING_PREMIUM_PROFILE = {
        "camera_capture_width": 1920,
        "camera_capture_height": 1080,
        "camera_fps": 30,
        "camera_max_video_bitrate_kbps": 3500,
        "screen_capture_width": 1920,
        "screen_capture_height": 1080,
        "screen_fps": 30,
        "screen_max_video_bitrate_kbps": 6000,
    }
    MEETING_ADAPTIVE_BASE_PROFILE = {
        "camera_capture_width": 1280,
        "camera_capture_height": 720,
        "camera_fps": 24,
        "camera_max_video_bitrate_kbps": 1200,
        "screen_capture_width": 1280,
        "screen_capture_height": 720,
        "screen_fps": 15,
        "screen_max_video_bitrate_kbps": 2500,
    }

    broadcast_capture_width = models.PositiveIntegerField(default=640)
    broadcast_capture_height = models.PositiveIntegerField(default=360)
    broadcast_capture_fps = models.PositiveIntegerField(default=20)
    broadcast_max_video_bitrate_kbps = models.PositiveIntegerField(default=650)
    broadcast_quality_mode = models.CharField(
        max_length=20,
        choices=BROADCAST_QUALITY_MODE_CHOICES,
        default=BROADCAST_QUALITY_MODE_LOW,
    )
    meeting_camera_capture_width = models.PositiveIntegerField(default=1280)
    meeting_camera_capture_height = models.PositiveIntegerField(default=720)
    meeting_camera_capture_fps = models.PositiveIntegerField(default=24)
    meeting_camera_max_video_bitrate_kbps = models.PositiveIntegerField(default=1200)
    meeting_screen_capture_width = models.PositiveIntegerField(default=1920)
    meeting_screen_capture_height = models.PositiveIntegerField(default=1080)
    meeting_screen_capture_fps = models.PositiveIntegerField(default=15)
    meeting_screen_max_video_bitrate_kbps = models.PositiveIntegerField(default=2500)
    meeting_quality_mode = models.CharField(
        max_length=20,
        choices=MEETING_QUALITY_MODE_CHOICES,
        default=MEETING_QUALITY_MODE_LOW,
    )
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
    def low_meeting_profile(cls):
        return dict(cls.MEETING_LOW_PROFILE)

    @classmethod
    def low_broadcast_profile(cls):
        return dict(cls.BROADCAST_LOW_PROFILE)

    @classmethod
    def premium_broadcast_profile(cls):
        return dict(cls.BROADCAST_PREMIUM_PROFILE)

    @classmethod
    def adaptive_base_broadcast_profile(cls):
        return dict(cls.BROADCAST_ADAPTIVE_BASE_PROFILE)

    @classmethod
    def constrained_broadcast_profile(cls):
        return dict(cls.BROADCAST_CONSTRAINED_PROFILE)

    @classmethod
    def premium_meeting_profile(cls):
        return dict(cls.MEETING_PREMIUM_PROFILE)

    @classmethod
    def constrained_meeting_profile(cls):
        return dict(cls.MEETING_LOW_PROFILE)

    @classmethod
    def adaptive_base_meeting_profile(cls):
        return dict(cls.MEETING_ADAPTIVE_BASE_PROFILE)

    def apply_broadcast_profile(self, profile):
        profile = profile or {}
        self.broadcast_capture_width = int(profile.get("capture_width", self.broadcast_capture_width))
        self.broadcast_capture_height = int(profile.get("capture_height", self.broadcast_capture_height))
        self.broadcast_capture_fps = int(profile.get("fps", self.broadcast_capture_fps))
        self.broadcast_max_video_bitrate_kbps = int(
            profile.get("max_video_bitrate_kbps", self.broadcast_max_video_bitrate_kbps)
        )

    def apply_meeting_profile(self, profile):
        profile = profile or {}
        self.meeting_camera_capture_width = int(
            profile.get("camera_capture_width", self.meeting_camera_capture_width)
        )
        self.meeting_camera_capture_height = int(
            profile.get("camera_capture_height", self.meeting_camera_capture_height)
        )
        self.meeting_camera_capture_fps = int(profile.get("camera_fps", self.meeting_camera_capture_fps))
        self.meeting_camera_max_video_bitrate_kbps = int(
            profile.get("camera_max_video_bitrate_kbps", self.meeting_camera_max_video_bitrate_kbps)
        )
        self.meeting_screen_capture_width = int(
            profile.get("screen_capture_width", self.meeting_screen_capture_width)
        )
        self.meeting_screen_capture_height = int(
            profile.get("screen_capture_height", self.meeting_screen_capture_height)
        )
        self.meeting_screen_capture_fps = int(profile.get("screen_fps", self.meeting_screen_capture_fps))
        self.meeting_screen_max_video_bitrate_kbps = int(
            profile.get("screen_max_video_bitrate_kbps", self.meeting_screen_max_video_bitrate_kbps)
        )

    def _resolve_adaptive_meeting_profile(self, *, participant_count=0, meeting_capacity=None):
        safe_default_capacity = max(1, int(getattr(settings, "REALTIME_DEFAULT_MEETING_CAPACITY", 200)))
        try:
            normalized_count = max(0, int(participant_count or 0))
        except (TypeError, ValueError):
            normalized_count = 0
        try:
            normalized_capacity = int(meeting_capacity or 0)
        except (TypeError, ValueError):
            normalized_capacity = 0
        safe_capacity = max(1, normalized_capacity or safe_default_capacity)
        load_ratio = normalized_count / safe_capacity

        # Adaptive tiers:
        # - Start at 720p for normal classroom load.
        # - Drop to 480p when participant load increases.
        if load_ratio <= 0.60 and normalized_count <= 180:
            return self.adaptive_base_meeting_profile()
        return self.constrained_meeting_profile()

    def _resolve_adaptive_broadcast_profile(self, *, audience_count=0, max_audience=None):
        safe_default_max_audience = max(
            1,
            int(getattr(settings, "REALTIME_DEFAULT_MAX_AUDIENCE", RealtimeSession.MAX_AUDIENCE_LIMIT)),
        )
        try:
            normalized_count = max(0, int(audience_count or 0))
        except (TypeError, ValueError):
            normalized_count = 0
        try:
            normalized_max = int(max_audience or 0)
        except (TypeError, ValueError):
            normalized_max = 0
        safe_max = max(1, normalized_max or safe_default_max_audience)
        load_ratio = normalized_count / safe_max

        # Adaptive tiers:
        # - Start at 720p for normal attendance.
        # - Shift to 480p as audience load rises to preserve stream stability.
        # - Drop to low profile only under extreme overload/fallback conditions.
        if load_ratio <= 0.35 and normalized_count <= 200:
            return self.adaptive_base_broadcast_profile()
        if load_ratio <= 1.00 and normalized_count <= safe_max:
            return self.constrained_broadcast_profile()
        return self.low_broadcast_profile()

    @classmethod
    def get_solo(cls):
        obj, _ = cls.objects.get_or_create(
            pk=1,
            defaults={
                "broadcast_capture_width": 640,
                "broadcast_capture_height": 360,
                "broadcast_capture_fps": 20,
                "broadcast_max_video_bitrate_kbps": 650,
                "broadcast_quality_mode": cls.BROADCAST_QUALITY_MODE_LOW,
                "meeting_camera_capture_width": 854,
                "meeting_camera_capture_height": 480,
                "meeting_camera_capture_fps": 20,
                "meeting_camera_max_video_bitrate_kbps": 850,
                "meeting_screen_capture_width": 854,
                "meeting_screen_capture_height": 480,
                "meeting_screen_capture_fps": 12,
                "meeting_screen_max_video_bitrate_kbps": 1400,
                "meeting_quality_mode": cls.MEETING_QUALITY_MODE_LOW,
            },
        )
        return obj

    def to_broadcast_dict(self, *, audience_count=0, max_audience=None):
        mode = str(self.broadcast_quality_mode or self.BROADCAST_QUALITY_MODE_LOW).strip().lower()
        if mode == self.BROADCAST_QUALITY_MODE_PREMIUM_HD:
            return self.premium_broadcast_profile()
        if mode == self.BROADCAST_QUALITY_MODE_ADAPTIVE:
            return self._resolve_adaptive_broadcast_profile(
                audience_count=audience_count,
                max_audience=max_audience,
            )
        return self.low_broadcast_profile()

    def to_meeting_dict(self, *, participant_count=0, meeting_capacity=None):
        mode = str(self.meeting_quality_mode or self.MEETING_QUALITY_MODE_LOW).strip().lower()
        if mode == self.MEETING_QUALITY_MODE_PREMIUM_HD:
            return self.premium_meeting_profile()
        if mode == self.MEETING_QUALITY_MODE_ADAPTIVE:
            return self._resolve_adaptive_meeting_profile(
                participant_count=participant_count,
                meeting_capacity=meeting_capacity,
            )
        return self.low_meeting_profile()

    def to_dict(self):
        # Backwards-compatible alias used by broadcast host-token payloads.
        return self.to_broadcast_dict()

    def __str__(self):
        return "Realtime Configuration"
