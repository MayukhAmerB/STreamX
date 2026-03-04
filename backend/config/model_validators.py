from django.core.exceptions import ValidationError

from config.request_security import contains_active_content, is_safe_public_http_url


def validate_no_active_content(value, field_name="field"):
    text = str(value or "")
    if contains_active_content(text):
        raise ValidationError({field_name: "Suspicious script or active-content payload detected."})


def validate_safe_public_url(value, field_name="url"):
    text = str(value or "").strip()
    if not text:
        return
    if not is_safe_public_http_url(text):
        raise ValidationError(
            {
                field_name: (
                    "Only public http/https URLs are allowed. Private/local/internal URLs are blocked."
                )
            }
        )
