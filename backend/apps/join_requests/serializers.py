import re

from config.request_security import contains_active_content
from django.utils import timezone
from rest_framework import serializers

from .india_locations import is_valid_district, is_valid_state
from .models import JoinApplication

WHITESPACE_RE = re.compile(r"\s+")
PHONE_SEPARATORS_RE = re.compile(r"[\s()-]")
INDIA_MOBILE_RE = re.compile(r"^[6-9]\d{9}$")


def _clean_text(value):
    text = WHITESPACE_RE.sub(" ", str(value or "")).strip()
    if contains_active_content(text):
        raise serializers.ValidationError("Suspicious script or active-content payload detected.")
    return text


class JoinApplicationCreateSerializer(serializers.ModelSerializer):
    # Declared explicitly so input is normalised to +91XXXXXXXXXX before validation.
    phone_number = serializers.CharField(max_length=24)
    terms_accepted = serializers.BooleanField(write_only=True)

    class Meta:
        model = JoinApplication
        fields = (
            "role",
            "full_name",
            "age",
            "phone_number",
            "address",
            "state",
            "district",
            "terms_accepted",
        )
        extra_kwargs = {
            "age": {"min_value": 18, "max_value": 100},
            "address": {"required": False},
        }

    def validate_full_name(self, value):
        name = _clean_text(value)
        if len(name) < 2:
            raise serializers.ValidationError("Enter your full name.")
        return name

    def validate_address(self, value):
        return _clean_text(value)

    def validate_phone_number(self, value):
        digits = PHONE_SEPARATORS_RE.sub("", str(value or ""))
        if digits.startswith("+91"):
            digits = digits[3:]
        if not INDIA_MOBILE_RE.fullmatch(digits):
            raise serializers.ValidationError("Enter a valid 10-digit Indian mobile number.")
        return f"+91{digits}"

    def validate_state(self, value):
        state = _clean_text(value)
        if not is_valid_state(state):
            raise serializers.ValidationError("Select a valid state.")
        return state

    def validate_terms_accepted(self, value):
        if value is not True:
            raise serializers.ValidationError("You must accept the Terms and Conditions.")
        return value

    def validate(self, attrs):
        attrs["district"] = _clean_text(attrs.get("district"))
        if not is_valid_district(attrs.get("state"), attrs["district"]):
            raise serializers.ValidationError({"district": "Select a district from the chosen state."})
        already_pending = (
            JoinApplication.objects.filter(phone_number=attrs["phone_number"], role=attrs["role"])
            .exclude(status=JoinApplication.STATUS_REJECTED)
            .exists()
        )
        if already_pending:
            raise serializers.ValidationError(
                {"phone_number": "A joining form with this number is already under review."}
            )
        attrs.pop("terms_accepted")
        attrs["terms_accepted_at"] = timezone.now()
        return attrs


class JoinApplicationCreatedSerializer(serializers.Serializer):
    application_id = serializers.IntegerField()
    status = serializers.CharField()


class JoinApplicationCreateResponseSerializer(serializers.Serializer):
    success = serializers.BooleanField()
    message = serializers.CharField()
    data = JoinApplicationCreatedSerializer(allow_null=True)
    errors = serializers.JSONField(allow_null=True)


class JoinFormSettingsSerializer(serializers.Serializer):
    instagram_url = serializers.URLField()


class JoinFormSettingsResponseSerializer(serializers.Serializer):
    success = serializers.BooleanField()
    message = serializers.CharField()
    data = JoinFormSettingsSerializer()
    errors = serializers.JSONField(allow_null=True)


class JoinLocationSerializer(serializers.Serializer):
    state = serializers.CharField()
    districts = serializers.ListField(child=serializers.CharField())


class JoinLocationDirectoryResponseSerializer(serializers.Serializer):
    success = serializers.BooleanField()
    message = serializers.CharField()
    data = JoinLocationSerializer(many=True)
    errors = serializers.JSONField(allow_null=True)
