import re

from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
import pyotp

from config.request_security import contains_active_content, contains_suspicious_sqli
from config.upload_validators import validate_profile_image_upload
from config.url_utils import get_media_public_url

from .models import User
from .terms import TERMS_LAST_UPDATED, TERMS_TITLE, TERMS_VERSION

PHONE_PATTERN = re.compile(r"^\+?[0-9][0-9()\-\s]{6,22}$")


def normalize_phone_number(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def validate_phone_number_value(value):
    normalized = normalize_phone_number(value)
    if normalized and not PHONE_PATTERN.fullmatch(normalized):
        raise serializers.ValidationError(
            "Enter a valid phone number with digits, spaces, (), -, and optional + prefix."
        )
    return normalized


class UserSerializer(serializers.ModelSerializer):
    profile_image_url = serializers.SerializerMethodField()
    is_admin = serializers.SerializerMethodField()
    terms_required_version = serializers.SerializerMethodField()
    terms_acceptance_required = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = (
            "id",
            "email",
            "full_name",
            "phone_number",
            "role",
            "is_admin",
            "profile_image_url",
            "two_factor_enabled",
            "terms_accepted_version",
            "terms_accepted_at",
            "notifications_consent_version",
            "notifications_consented_at",
            "terms_required_version",
            "terms_acceptance_required",
            "created_at",
            "updated_at",
        )

    def get_profile_image_url(self, obj):
        request = self.context.get("request")
        if not getattr(obj, "profile_image", None):
            return None
        return get_media_public_url(obj.profile_image.url, request=request)

    def get_is_admin(self, obj):
        return bool(getattr(obj, "is_staff", False) or getattr(obj, "is_superuser", False))

    def get_terms_required_version(self, obj):
        return TERMS_VERSION

    def get_terms_acceptance_required(self, obj):
        return str(getattr(obj, "terms_accepted_version", "") or "") != TERMS_VERSION


class TermsSerializer(serializers.Serializer):
    title = serializers.CharField(default=TERMS_TITLE)
    version = serializers.CharField(default=TERMS_VERSION)
    last_updated = serializers.CharField(default=TERMS_LAST_UPDATED)
    body = serializers.CharField()


class TermsAcceptSerializer(serializers.Serializer):
    accepted = serializers.BooleanField()
    terms_version = serializers.CharField(max_length=40, required=False, allow_blank=True)

    def validate(self, attrs):
        if not attrs.get("accepted"):
            raise serializers.ValidationError({"accepted": "You must explicitly agree to continue."})
        requested_version = str(attrs.get("terms_version") or TERMS_VERSION).strip()
        if requested_version != TERMS_VERSION:
            raise serializers.ValidationError(
                {"terms_version": f"Terms version must be the active version: {TERMS_VERSION}."}
            )
        attrs["terms_version"] = TERMS_VERSION
        return attrs


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=8)

    class Meta:
        model = User
        fields = ("email", "full_name", "phone_number", "password", "role")
        extra_kwargs = {
            "role": {"required": False},
        }

    def validate_password(self, value):
        validate_password(value)
        return value

    def validate_email(self, value):
        normalized = User.objects.normalize_auth_email(value)
        if User.objects.filter(email__iexact=normalized).exists():
            raise serializers.ValidationError("A user with that email already exists.")
        return normalized

    def validate_full_name(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_phone_number(self, value):
        return validate_phone_number_value(value)

    def validate_role(self, value):
        # Public/self-service registration is always student-only.
        return User.ROLE_STUDENT

    def create(self, validated_data):
        password = validated_data.pop("password")
        validated_data["role"] = User.ROLE_STUDENT
        return User.objects.create_user(password=password, **validated_data)


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)
    otp_code = serializers.CharField(write_only=True, required=False, allow_blank=True)

    def validate(self, attrs):
        email = User.objects.normalize_auth_email(attrs.get("email", ""))
        password = str(attrs.get("password", ""))
        if contains_suspicious_sqli(email) or contains_suspicious_sqli(password):
            raise serializers.ValidationError({"detail": "Suspicious input detected."})
        user = authenticate(
            request=self.context.get("request"),
            email=email,
            password=password,
        )
        if not user:
            raise serializers.ValidationError({"detail": "Invalid email or password."})
        if not user.is_active:
            raise serializers.ValidationError({"detail": "User account is disabled."})

        if user.two_factor_enabled:
            otp_code = (attrs.get("otp_code") or "").strip()
            if not otp_code:
                raise serializers.ValidationError(
                    {"detail": "Two-factor code required.", "requires_2fa": True}
                )
            if not user.two_factor_secret or not pyotp.TOTP(user.two_factor_secret).verify(
                otp_code, valid_window=1
            ):
                raise serializers.ValidationError(
                    {"detail": "Invalid two-factor code.", "requires_2fa": True}
                )
        attrs["user"] = user
        return attrs


class GoogleLoginSerializer(serializers.Serializer):
    credential = serializers.CharField()
    role = serializers.ChoiceField(
        choices=User.ROLE_CHOICES,
        required=False,
        default=User.ROLE_STUDENT,
    )

    def validate_role(self, value):
        # Public/social signup must never elevate role.
        return User.ROLE_STUDENT


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    new_password = serializers.CharField(min_length=8)

    def validate_new_password(self, value):
        validate_password(value)
        return value


class ContactMessageSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=120)
    email = serializers.EmailField()
    subject = serializers.CharField(max_length=180)
    message = serializers.CharField(min_length=10, max_length=5000)

    def validate(self, attrs):
        for field in ("name", "subject", "message"):
            if contains_active_content(attrs.get(field, "")):
                raise serializers.ValidationError(
                    {field: "Suspicious script or active-content payload detected."}
                )
        return attrs


class ProfileUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ("full_name", "phone_number", "profile_image")

    def validate_full_name(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_phone_number(self, value):
        return validate_phone_number_value(value)

    def validate_profile_image(self, value):
        if value in (None, ""):
            return value
        if isinstance(value, str):
            normalized = value.strip()
            if normalized:
                raise serializers.ValidationError("Profile image must be an uploaded JPG or PNG file, not a URL.")
            return value
        try:
            validate_profile_image_upload(value, "profile_image")
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict.get("profile_image") if hasattr(exc, "message_dict") else str(exc))
        return value


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, min_length=8)

    def validate_new_password(self, value):
        validate_password(value)
        return value


class TwoFactorCodeSerializer(serializers.Serializer):
    code = serializers.CharField(min_length=6, max_length=8)


class TwoFactorDisableSerializer(serializers.Serializer):
    password = serializers.CharField(write_only=True)
