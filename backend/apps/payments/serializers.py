from rest_framework import serializers

from config.request_security import contains_active_content


def _validate_plain_text(value, field_name):
    text = str(value or "").strip()
    if contains_active_content(text):
        raise serializers.ValidationError(
            f"{field_name} contains unsupported active content."
        )
    return text


class CheckoutProfileSerializer(serializers.Serializer):
    buyer_name = serializers.CharField(min_length=2, max_length=255, trim_whitespace=True)
    buyer_email = serializers.EmailField(max_length=254)
    whatsapp_number = serializers.RegexField(
        regex=r"^\+?[0-9][0-9 ()-]{7,22}$",
        max_length=24,
        error_messages={"invalid": "Enter a valid WhatsApp number with country code."},
    )
    alternate_number = serializers.RegexField(
        regex=r"^\+?[0-9][0-9 ()-]{7,22}$",
        max_length=24,
        required=False,
        allow_blank=True,
        error_messages={"invalid": "Enter a valid alternate number with country code."},
    )
    age = serializers.IntegerField(min_value=5, max_value=120, required=False, allow_null=True)
    country = serializers.CharField(
        min_length=2, max_length=120, trim_whitespace=True, required=False, allow_blank=True
    )
    state = serializers.CharField(
        min_length=2, max_length=120, trim_whitespace=True, required=False, allow_blank=True
    )
    city = serializers.CharField(
        min_length=2, max_length=120, trim_whitespace=True, required=False, allow_blank=True
    )
    pincode = serializers.RegexField(
        regex=r"^[A-Za-z0-9][A-Za-z0-9 -]{2,19}$",
        max_length=20,
        required=False,
        allow_blank=True,
        error_messages={"invalid": "Enter a valid postal or PIN code."},
    )

    def validate(self, attrs):
        active_content_errors = {}
        for field_name in ("buyer_name", "country", "state", "city", "pincode"):
            if not attrs.get(field_name):
                continue
            try:
                attrs[field_name] = _validate_plain_text(attrs[field_name], field_name)
            except serializers.ValidationError as exc:
                active_content_errors[field_name] = exc.detail
        if active_content_errors:
            raise serializers.ValidationError(active_content_errors)
        attrs["buyer_email"] = str(attrs["buyer_email"]).strip().lower()
        attrs["whatsapp_number"] = str(attrs["whatsapp_number"]).strip()
        attrs["alternate_number"] = str(attrs.get("alternate_number") or "").strip()
        return attrs


class CreateOrderSerializer(CheckoutProfileSerializer):
    course_id = serializers.IntegerField(min_value=1)
    plan = serializers.ChoiceField(choices=("full", "monthly"), default="full")


class VerifyPaymentSerializer(serializers.Serializer):
    course_id = serializers.IntegerField(min_value=1)
    checkout_reference = serializers.UUIDField(required=False)
    razorpay_order_id = serializers.CharField()
    razorpay_payment_id = serializers.CharField()
    razorpay_signature = serializers.CharField()
