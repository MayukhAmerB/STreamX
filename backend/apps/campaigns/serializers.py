import re

from rest_framework import serializers

from config.request_security import contains_active_content

from .models import Campaign, CampaignVolunteer


PHONE_PATTERN = re.compile(r"^\+?[0-9][0-9()\-\s]{6,22}$")


def _reject_active_content(value, field_name):
    if contains_active_content(value):
        raise serializers.ValidationError({field_name: "Suspicious script or active-content payload detected."})


class CampaignPublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = Campaign
        fields = ("id", "name", "campaign_number", "description", "image_data_url", "is_featured")


class CampaignAdminSerializer(serializers.ModelSerializer):
    volunteer_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Campaign
        fields = (
            "id",
            "name",
            "campaign_number",
            "description",
            "image_data_url",
            "is_featured",
            "is_active",
            "sort_order",
            "volunteer_count",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("id", "volunteer_count", "created_at", "updated_at")

    def validate_image_data_url(self, value):
        text = str(value or "").strip()
        if not text:
            return ""
        if not text.startswith("data:image/"):
            raise serializers.ValidationError("Only image data URLs are allowed.")
        if len(text) > 2_500_000:
            raise serializers.ValidationError("Image is too large. Use an image under roughly 1.8 MB.")
        return text

    def validate(self, attrs):
        for field_name in ("name", "campaign_number", "description"):
            if field_name in attrs:
                _reject_active_content(str(attrs.get(field_name) or ""), field_name)
        return attrs


class CampaignVolunteerCreateSerializer(serializers.ModelSerializer):
    campaign_id = serializers.IntegerField(min_value=1, write_only=True)

    class Meta:
        model = CampaignVolunteer
        fields = (
            "campaign_id",
            "full_name",
            "whatsapp_number",
            "alternate_number",
            "city",
            "state",
            "gender",
        )

    @staticmethod
    def _normalize_phone_number(value):
        return re.sub(r"\s+", " ", str(value or "").strip())

    def _validate_phone_number(self, value, *, required=True):
        normalized = self._normalize_phone_number(value)
        if not normalized and not required:
            return ""
        if not PHONE_PATTERN.fullmatch(normalized):
            raise serializers.ValidationError(
                "Enter a valid phone number with digits, spaces, (), -, and optional + prefix."
            )
        return normalized

    def validate_whatsapp_number(self, value):
        return self._validate_phone_number(value)

    def validate_alternate_number(self, value):
        return self._validate_phone_number(value, required=False)

    def validate(self, attrs):
        campaign = Campaign.objects.filter(pk=attrs.pop("campaign_id"), is_active=True).first()
        if not campaign:
            raise serializers.ValidationError({"campaign_id": "Campaign not found or inactive."})
        attrs["campaign"] = campaign
        for field_name in ("full_name", "city", "state"):
            text = str(attrs.get(field_name) or "").strip()
            if len(text) < 2:
                raise serializers.ValidationError({field_name: "Enter at least 2 characters."})
            _reject_active_content(text, field_name)
            attrs[field_name] = text
        return attrs


class CampaignVolunteerAdminSerializer(serializers.ModelSerializer):
    campaign_name = serializers.CharField(source="campaign.name", read_only=True)
    campaign_number = serializers.CharField(source="campaign.campaign_number", read_only=True)

    class Meta:
        model = CampaignVolunteer
        fields = (
            "id",
            "campaign",
            "campaign_name",
            "campaign_number",
            "full_name",
            "whatsapp_number",
            "alternate_number",
            "city",
            "state",
            "gender",
            "status",
            "notes",
            "source_ip",
            "user_agent",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "campaign",
            "campaign_name",
            "campaign_number",
            "full_name",
            "whatsapp_number",
            "alternate_number",
            "city",
            "state",
            "gender",
            "source_ip",
            "user_agent",
            "created_at",
            "updated_at",
        )

    def validate_notes(self, value):
        text = str(value or "").strip()
        _reject_active_content(text, "notes")
        return text

