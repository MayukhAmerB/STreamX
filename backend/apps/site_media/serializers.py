"""Response contract for GET /api/site/youtube/ (documentation only: the view
builds the payload in ``youtube.build_public_payload``)."""

from rest_framework import serializers


class YouTubeVideoSerializer(serializers.Serializer):
    video_id = serializers.RegexField(r"^[A-Za-z0-9_-]{11}$")
    title = serializers.CharField(allow_blank=True)
    published_at = serializers.DateTimeField(allow_null=True)
    thumbnail = serializers.URLField()


class YouTubeChannelInfoSerializer(serializers.Serializer):
    title = serializers.CharField()
    handle = serializers.CharField(allow_blank=True)
    url = serializers.URLField()
    subscribe_url = serializers.URLField()


class YouTubeLiveSerializer(serializers.Serializer):
    is_live = serializers.BooleanField()
    video_id = serializers.RegexField(r"^[A-Za-z0-9_-]{11}$", allow_null=True)
    title = serializers.CharField(allow_blank=True)


class YouTubeSectionSerializer(serializers.Serializer):
    title = serializers.CharField(allow_blank=True)
    subtitle = serializers.CharField(allow_blank=True)


class YouTubeChannelPayloadSerializer(serializers.Serializer):
    enabled = serializers.BooleanField()
    available = serializers.BooleanField()
    section = YouTubeSectionSerializer()
    channel = YouTubeChannelInfoSerializer()
    live = YouTubeLiveSerializer()
    featured = YouTubeVideoSerializer(allow_null=True)
    latest = YouTubeVideoSerializer(many=True)
    fetched_at = serializers.DateTimeField(allow_null=True)


class YouTubeChannelResponseSerializer(serializers.Serializer):
    success = serializers.BooleanField()
    message = serializers.CharField()
    data = YouTubeChannelPayloadSerializer()
    errors = serializers.JSONField(allow_null=True)
