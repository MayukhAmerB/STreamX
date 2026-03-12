from django.core.exceptions import ValidationError as DjangoValidationError
from django.conf import settings
from django.urls import reverse
from rest_framework import serializers

from config.request_security import (
    contains_active_content,
    is_safe_public_http_url,
    is_safe_public_stream_url,
)
from config.upload_validators import validate_video_upload
from config.url_utils import get_media_public_url

from apps.courses.models import LiveClass

from .models import RealtimeSession, RealtimeSessionRecording
from .services import build_session_join_url, resolve_broadcast_urls, resolve_obs_stream_server_url


class RealtimeSessionListSerializer(serializers.ModelSerializer):
    host = serializers.SerializerMethodField()
    is_host = serializers.SerializerMethodField()
    can_manage = serializers.SerializerMethodField()
    join_url = serializers.SerializerMethodField()
    linked_live_class = serializers.SerializerMethodField()
    linked_course = serializers.SerializerMethodField()
    obs_stream_server_url = serializers.SerializerMethodField()
    stream_embed_url = serializers.SerializerMethodField()
    chat_embed_url = serializers.SerializerMethodField()

    class Meta:
        model = RealtimeSession
        fields = (
            "id",
            "title",
            "slug",
            "description",
            "session_type",
            "status",
            "host",
            "is_host",
            "can_manage",
            "linked_live_class",
            "linked_course",
            "room_name",
            "livekit_room_name",
            "meeting_capacity",
            "max_audience",
            "allow_overflow_broadcast",
            "presenter_user_ids",
            "speaker_user_ids",
            "stream_service",
            "obs_stream_server_url",
            "obs_stream_key",
            "join_url",
            "stream_embed_url",
            "chat_embed_url",
            "stream_status",
            "livekit_egress_error",
            "started_at",
            "ended_at",
            "created_at",
            "updated_at",
        )

    def get_host(self, obj):
        return {
            "id": obj.host_id,
            "full_name": obj.host.full_name,
            "email": obj.host.email,
        }

    def get_is_host(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        return request.user.id == obj.host_id

    def get_can_manage(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        return obj.is_moderator_allowed(request.user)

    def get_join_url(self, obj):
        request = self.context.get("request")
        return build_session_join_url(obj.id, request=request)

    def get_obs_stream_server_url(self, obj):
        request = self.context.get("request")
        return resolve_obs_stream_server_url(request=request, session=obj)

    def get_obs_stream_key(self, obj):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        if not obj.is_moderator_allowed(user):
            return ""
        if obj.stream_service == RealtimeSession.STREAM_SERVICE_OBS:
            return str(obj.default_obs_stream_key() or "").strip()
        return str(obj.obs_stream_key or "")

    def _get_resolved_broadcast_urls(self, obj):
        cache_key = f"broadcast_urls:{obj.id}"
        cached = self.context.get(cache_key)
        if isinstance(cached, dict):
            return cached
        request = self.context.get("request")
        resolved = resolve_broadcast_urls(obj, request=request)
        self.context[cache_key] = resolved
        return resolved

    def get_stream_embed_url(self, obj):
        if obj.session_type != RealtimeSession.TYPE_BROADCASTING:
            return str(obj.stream_embed_url or "").strip()
        resolved = self._get_resolved_broadcast_urls(obj)
        return str(resolved.get("stream_embed_url") or "").strip()

    def get_chat_embed_url(self, obj):
        if obj.session_type != RealtimeSession.TYPE_BROADCASTING:
            return str(obj.chat_embed_url or "").strip()
        resolved = self._get_resolved_broadcast_urls(obj)
        return str(resolved.get("chat_embed_url") or "").strip()

    def get_linked_live_class(self, obj):
        live_class = getattr(obj, "linked_live_class", None)
        if not live_class:
            return None
        return {
            "id": live_class.id,
            "title": live_class.title,
            "slug": live_class.slug,
            "level": live_class.level,
            "month_number": live_class.month_number,
            "linked_course_id": live_class.linked_course_id,
            "linked_course_title": getattr(getattr(live_class, "linked_course", None), "title", ""),
        }

    def get_linked_course(self, obj):
        live_class = getattr(obj, "linked_live_class", None)
        if live_class and getattr(live_class, "linked_course", None):
            course = live_class.linked_course
        else:
            course = getattr(obj, "linked_course", None)
        if not course:
            return None
        return {
            "id": course.id,
            "title": course.title,
            "slug": course.slug,
            "category": course.category,
            "level": course.level,
            "instructor_id": course.instructor_id,
        }


class RealtimeSessionCreateSerializer(serializers.ModelSerializer):
    linked_live_class_id = serializers.PrimaryKeyRelatedField(
        source="linked_live_class",
        queryset=LiveClass.objects.filter(is_active=True),
        required=False,
        allow_null=True,
    )

    class Meta:
        model = RealtimeSession
        fields = (
            "title",
            "description",
            "linked_live_class_id",
            "session_type",
            "status",
            "room_name",
            "livekit_room_name",
            "meeting_capacity",
            "max_audience",
            "allow_overflow_broadcast",
            "stream_service",
            "obs_stream_key",
            "stream_embed_url",
            "chat_embed_url",
            "rtmp_target_url",
        )
        extra_kwargs = {
            "description": {"required": False, "allow_blank": True},
            "room_name": {"required": False, "allow_blank": True},
            "livekit_room_name": {"required": False, "allow_blank": True},
            "stream_embed_url": {"required": False, "allow_blank": True},
            "chat_embed_url": {"required": False, "allow_blank": True},
            "rtmp_target_url": {"required": False, "allow_blank": True, "write_only": True},
            "status": {"required": False},
            "meeting_capacity": {"required": False},
            "max_audience": {"required": False},
            "allow_overflow_broadcast": {"required": False},
            "stream_service": {"required": False},
            "obs_stream_key": {"required": False, "allow_blank": True},
        }

    def validate_title(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_description(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_room_name(self, value):
        if value and contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_livekit_room_name(self, value):
        if value and contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_stream_embed_url(self, value):
        if value and not is_safe_public_http_url(value):
            raise serializers.ValidationError(
                "Only public http/https URLs are allowed. Private/local/internal URLs are blocked."
            )
        return value

    def validate_chat_embed_url(self, value):
        if value and not is_safe_public_http_url(value):
            raise serializers.ValidationError(
                "Only public http/https URLs are allowed. Private/local/internal URLs are blocked."
            )
        return value

    def validate(self, attrs):
        session_type = attrs.get("session_type", RealtimeSession.TYPE_MEETING)
        linked_live_class = attrs.get("linked_live_class")
        meeting_capacity = attrs.get("meeting_capacity", RealtimeSession.MAX_MEETING_CAPACITY)
        default_max_audience = int(
            getattr(settings, "REALTIME_DEFAULT_MAX_AUDIENCE", RealtimeSession.MAX_AUDIENCE_LIMIT)
            or RealtimeSession.MAX_AUDIENCE_LIMIT
        )
        max_audience = attrs.get("max_audience", default_max_audience)

        if not linked_live_class:
            if session_type == RealtimeSession.TYPE_MEETING:
                detail = "Select a live class for this meeting session."
            else:
                detail = "Select a live class for this broadcast session."
            raise serializers.ValidationError({"linked_live_class_id": detail})
        if meeting_capacity > RealtimeSession.MAX_MEETING_CAPACITY:
            raise serializers.ValidationError(
                {
                    "meeting_capacity": (
                        f"Meeting capacity cannot exceed {RealtimeSession.MAX_MEETING_CAPACITY}."
                    )
                }
            )
        if max_audience > RealtimeSession.MAX_AUDIENCE_LIMIT:
            raise serializers.ValidationError(
                {"max_audience": f"Max audience cannot exceed {RealtimeSession.MAX_AUDIENCE_LIMIT}."}
            )
        if max_audience < meeting_capacity:
            raise serializers.ValidationError(
                {"max_audience": "Max audience must be greater than or equal to meeting capacity."}
            )

        if session_type == RealtimeSession.TYPE_BROADCASTING:
            attrs.setdefault("meeting_capacity", RealtimeSession.MAX_MEETING_CAPACITY)
        if session_type == RealtimeSession.TYPE_MEETING:
            attrs["stream_service"] = RealtimeSession.STREAM_SERVICE_ALSYED

        rtmp_target_url = (attrs.get("rtmp_target_url") or "").strip()
        if rtmp_target_url and not is_safe_public_stream_url(rtmp_target_url):
            raise serializers.ValidationError(
                {
                    "rtmp_target_url": (
                        "Only public rtmp/rtmps URLs are allowed. "
                        "Private/local/internal URLs are blocked."
                    )
                }
            )

        return attrs


class RealtimeSessionJoinSerializer(serializers.Serializer):
    display_name = serializers.CharField(max_length=100, required=False, allow_blank=True)
    prefer_broadcast = serializers.BooleanField(required=False, default=False)


class RealtimePresenterPermissionSerializer(serializers.Serializer):
    user_id = serializers.IntegerField(min_value=1)


class RealtimeSessionRecordingSerializer(serializers.ModelSerializer):
    started_by = serializers.SerializerMethodField()
    is_active = serializers.SerializerMethodField()
    playback_url = serializers.SerializerMethodField()
    source = serializers.SerializerMethodField()

    class Meta:
        model = RealtimeSessionRecording
        fields = (
            "id",
            "session",
            "recording_type",
            "status",
            "is_active",
            "started_by",
            "livekit_egress_id",
            "output_file_path",
            "output_download_url",
            "playback_url",
            "source",
            "error",
            "started_at",
            "ended_at",
            "created_at",
            "updated_at",
        )

    def get_started_by(self, obj):
        if not obj.started_by_id:
            return None
        return {
            "id": obj.started_by_id,
            "email": obj.started_by.email,
            "full_name": obj.started_by.full_name,
        }

    def get_is_active(self, obj):
        return obj.status in RealtimeSessionRecording.ACTIVE_STATUSES

    def get_playback_url(self, obj):
        request = self.context.get("request")
        if obj.output_download_url:
            return obj.output_download_url
        if getattr(obj, "video_file", None):
            return get_media_public_url(obj.video_file.url, request=request)
        if obj.output_file_path and obj.pk:
            url = reverse("realtime-session-recording-download", kwargs={"recording_id": obj.pk})
            if request:
                return request.build_absolute_uri(url)
            return url
        return ""

    def get_source(self, obj):
        payload = obj.livekit_payload if isinstance(obj.livekit_payload, dict) else {}
        source = str(payload.get("source") or "").strip().lower()
        if source:
            return source
        if getattr(obj, "video_file", None):
            return "browser_fallback"
        return "livekit_egress"


class RealtimeSessionBrowserRecordingUploadSerializer(serializers.Serializer):
    video_file = serializers.FileField(required=True)
    started_at = serializers.DateTimeField(required=False, allow_null=True)
    ended_at = serializers.DateTimeField(required=False, allow_null=True)

    def validate_video_file(self, value):
        try:
            validate_video_upload(value, "video_file")
        except DjangoValidationError as exc:
            detail = getattr(exc, "message_dict", {}).get("video_file")
            if isinstance(detail, list) and detail:
                raise serializers.ValidationError(detail[0])
            if isinstance(detail, str):
                raise serializers.ValidationError(detail)
            raise serializers.ValidationError("Invalid recording video file.")
        return value
