import unicodedata

from rest_framework import serializers

from config.request_security import contains_active_content, contains_suspicious_sqli


NAME_PUNCTUATION = {" ", "'", "\u2019", "-", "."}
LOCATION_PUNCTUATION = NAME_PUNCTUATION | {",", "(", ")", "&", "/"}


def _validate_plain_text(
    value,
    field_name,
    *,
    allowed_punctuation=None,
    allow_numbers=True,
):
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    if any(unicodedata.category(char) in {"Cc", "Cf"} for char in text):
        raise serializers.ValidationError(f"{field_name} contains unsupported characters.")
    if "<" in text or ">" in text or contains_active_content(text):
        raise serializers.ValidationError(
            f"{field_name} contains unsupported active content."
        )
    if contains_suspicious_sqli(text):
        raise serializers.ValidationError(f"{field_name} contains unsupported input.")
    if allowed_punctuation is not None:
        invalid_character = any(
            not (
                unicodedata.category(char).startswith(
                    ("L", "M", "N") if allow_numbers else ("L", "M")
                )
                or char in allowed_punctuation
            )
            for char in text
        )
        if invalid_character:
            raise serializers.ValidationError(
                f"{field_name} contains unsupported characters."
            )
    return text


class CheckoutProfileSerializer(serializers.Serializer):
    buyer_name = serializers.CharField(min_length=2, max_length=120, trim_whitespace=True)
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
        validation_errors = {}
        for field_name in ("buyer_name", "country", "state", "city", "pincode"):
            if not attrs.get(field_name):
                continue
            try:
                allowed_punctuation = (
                    NAME_PUNCTUATION
                    if field_name == "buyer_name"
                    else LOCATION_PUNCTUATION
                )
                attrs[field_name] = _validate_plain_text(
                    attrs[field_name],
                    field_name,
                    allowed_punctuation=allowed_punctuation,
                    allow_numbers=field_name != "buyer_name",
                )
            except serializers.ValidationError as exc:
                validation_errors[field_name] = exc.detail

        try:
            attrs["buyer_email"] = _validate_plain_text(
                attrs["buyer_email"], "buyer_email"
            ).lower()
        except serializers.ValidationError as exc:
            validation_errors["buyer_email"] = exc.detail

        attrs["whatsapp_number"] = str(attrs["whatsapp_number"]).strip()
        attrs["alternate_number"] = str(attrs.get("alternate_number") or "").strip()
        whatsapp_digits = "".join(char for char in attrs["whatsapp_number"] if char.isdigit())
        alternate_digits = "".join(char for char in attrs["alternate_number"] if char.isdigit())
        if not 8 <= len(whatsapp_digits) <= 15:
            validation_errors["whatsapp_number"] = [
                "Enter a valid WhatsApp number with 8 to 15 digits."
            ]
        if attrs["alternate_number"] and not 8 <= len(alternate_digits) <= 15:
            validation_errors["alternate_number"] = [
                "Enter a valid alternate number with 8 to 15 digits."
            ]
        if alternate_digits and alternate_digits == whatsapp_digits:
            validation_errors["alternate_number"] = [
                "Alternate number must be different from the WhatsApp number."
            ]
        if validation_errors:
            raise serializers.ValidationError(validation_errors)
        return attrs


class CreateOrderSerializer(CheckoutProfileSerializer):
    course_id = serializers.IntegerField(min_value=1)
    plan = serializers.ChoiceField(choices=("full", "monthly"), default="full")


class VerifyPaymentSerializer(serializers.Serializer):
    course_id = serializers.IntegerField(min_value=1)
    checkout_reference = serializers.UUIDField(required=False)
    razorpay_order_id = serializers.RegexField(
        regex=r"^order_[A-Za-z0-9_-]{1,120}$",
        max_length=126,
        error_messages={"invalid": "Invalid Razorpay order identifier."},
    )
    razorpay_payment_id = serializers.RegexField(
        regex=r"^pay_[A-Za-z0-9_-]{1,120}$",
        max_length=124,
        error_messages={"invalid": "Invalid Razorpay payment identifier."},
    )
    razorpay_signature = serializers.RegexField(
        regex=r"^[A-Za-z0-9_-]{8,255}$",
        max_length=255,
        error_messages={"invalid": "Invalid Razorpay signature format."},
    )
