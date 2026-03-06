from rest_framework import serializers

from config.request_security import (
    contains_active_content,
    is_safe_public_http_url,
    is_safe_public_stream_url,
)

from .models import RealtimeSession
from .services import build_session_join_url


class RealtimeSessionListSerializer(serializers.ModelSerializer):
    host = serializers.SerializerMethodField()
    is_host = serializers.SerializerMethodField()
    join_url = serializers.SerializerMethodField()

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
            "room_name",
            "livekit_room_name",
            "meeting_capacity",
            "max_audience",
            "allow_overflow_broadcast",
            "presenter_user_ids",
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

    def get_join_url(self, obj):
        request = self.context.get("request")
        return build_session_join_url(obj.id, request=request)


class RealtimeSessionCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = RealtimeSession
        fields = (
            "title",
            "description",
            "session_type",
            "status",
            "room_name",
            "livekit_room_name",
            "meeting_capacity",
            "max_audience",
            "allow_overflow_broadcast",
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
        meeting_capacity = attrs.get("meeting_capacity", 300)
        max_audience = attrs.get("max_audience", 50000)

        if meeting_capacity > 300:
            raise serializers.ValidationError({"meeting_capacity": "Meeting capacity cannot exceed 300."})
        if max_audience > 50000:
            raise serializers.ValidationError({"max_audience": "Max audience cannot exceed 50000."})
        if max_audience < meeting_capacity:
            raise serializers.ValidationError(
                {"max_audience": "Max audience must be greater than or equal to meeting capacity."}
            )

        if session_type == RealtimeSession.TYPE_BROADCASTING:
            attrs.setdefault("meeting_capacity", 300)

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


class RealtimePresenterPermissionSerializer(serializers.Serializer):
    user_id = serializers.IntegerField(min_value=1)
