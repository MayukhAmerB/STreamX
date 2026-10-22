from config.url_utils import get_media_public_url
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import (
    FirFilingGuide,
    LawsSection,
    LawTopic,
    TrackerOverview,
    TrackerUpdate,
)


def _media_url(file_field, request):
    if not file_field or not getattr(file_field, "name", ""):
        return ""
    try:
        url = file_field.url
    except ValueError:
        return ""
    return get_media_public_url(url, request=request)


class LawTopicSerializer(serializers.ModelSerializer):
    audio_url = serializers.SerializerMethodField()

    class Meta:
        model = LawTopic
        fields = ("id", "icon_key", "title", "body", "audio_duration", "audio_url")

    @extend_schema_field(OpenApiTypes.STR)
    def get_audio_url(self, obj):
        return _media_url(obj.audio_file, self.context.get("request"))


class TrackerUpdateSerializer(serializers.ModelSerializer):
    status_display = serializers.CharField(source="get_status_display", read_only=True)
    date = serializers.SerializerMethodField()
    date_iso = serializers.DateField(source="event_date", read_only=True)

    class Meta:
        model = TrackerUpdate
        fields = ("id", "city", "region", "status", "status_display", "status_note", "date", "date_iso")

    @extend_schema_field(OpenApiTypes.STR)
    def get_date(self, obj):
        return obj.event_date.strftime("%d %b %Y") if obj.event_date else ""


class FirFilingGuideSerializer(serializers.ModelSerializer):
    hero_image_url = serializers.SerializerMethodField()
    audio_url = serializers.SerializerMethodField()

    class Meta:
        model = FirFilingGuide
        fields = (
            "badge_label",
            "section_label",
            "title",
            "subtitle",
            "hero_image_url",
            "audio_kicker",
            "audio_title",
            "audio_duration",
            "audio_url",
            "is_active",
        )

    @extend_schema_field(OpenApiTypes.STR)
    def get_hero_image_url(self, obj):
        return _media_url(obj.hero_image, self.context.get("request"))

    @extend_schema_field(OpenApiTypes.STR)
    def get_audio_url(self, obj):
        return _media_url(obj.audio_file, self.context.get("request"))


class LawsSectionSerializer(serializers.ModelSerializer):
    hero_image_url = serializers.SerializerMethodField()
    topics = serializers.SerializerMethodField()

    class Meta:
        model = LawsSection
        fields = (
            "section_label",
            "title",
            "subtitle",
            "hero_image_url",
            "cta_kicker",
            "cta_title",
            "cta_body",
            "topics",
            "is_active",
        )

    @extend_schema_field(OpenApiTypes.STR)
    def get_hero_image_url(self, obj):
        return _media_url(obj.hero_image, self.context.get("request"))

    @extend_schema_field(LawTopicSerializer(many=True))
    def get_topics(self, obj):
        return LawTopicSerializer(
            getattr(obj, "public_topics", ()), many=True, context=self.context
        ).data


class TrackerOverviewSerializer(serializers.ModelSerializer):
    hero_image_url = serializers.SerializerMethodField()
    stats = serializers.SerializerMethodField()
    updates = serializers.SerializerMethodField()

    class Meta:
        model = TrackerOverview
        fields = (
            "section_label",
            "title",
            "subtitle",
            "tagline",
            "hero_image_url",
            "stats",
            "updates_cta_kicker",
            "updates_cta_body",
            "full_tracker_url",
            "updates",
            "is_active",
        )

    @extend_schema_field(OpenApiTypes.STR)
    def get_hero_image_url(self, obj):
        return _media_url(obj.hero_image, self.context.get("request"))

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_stats(self, obj):
        return {
            "total_filed": obj.total_filed,
            "in_progress": obj.in_progress,
            "completed": obj.completed,
            "planned": obj.planned,
        }

    @extend_schema_field(TrackerUpdateSerializer(many=True))
    def get_updates(self, obj):
        return TrackerUpdateSerializer(
            getattr(obj, "public_updates", ()), many=True, context=self.context
        ).data


class NationalDeskInstagramSerializer(serializers.Serializer):
    enabled = serializers.BooleanField()
    url = serializers.CharField(allow_blank=True)


class NationalDeskDataSerializer(serializers.Serializer):
    is_published = serializers.BooleanField()
    instagram = NationalDeskInstagramSerializer()
    file_fir = FirFilingGuideSerializer()
    laws = LawsSectionSerializer()
    tracker = TrackerOverviewSerializer()


class NationalDeskResponseSerializer(serializers.Serializer):
    success = serializers.BooleanField()
    message = serializers.CharField()
    data = NationalDeskDataSerializer(allow_null=True)
    errors = serializers.JSONField(allow_null=True)
