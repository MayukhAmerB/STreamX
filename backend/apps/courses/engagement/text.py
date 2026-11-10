"""Plain-text normalisation for user-written lecture comments."""

import re

from django.core.exceptions import ValidationError
from django.utils.html import strip_tags

from config.model_validators import validate_no_active_content

from .models import COMMENT_MAX_LENGTH

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_EXCESS_BLANK_LINES = re.compile(r"\n{3,}")


def clean_comment_body(raw_value):
    """Return the comment as plain text or raise ValidationError({"body": ...}).

    HTML tags are stripped (never rendered), control characters dropped and
    script-like payloads rejected with the project-wide active-content check.
    Clients must still render the result as text, never as HTML.
    """
    text = _CONTROL_CHARS.sub("", str(raw_value or "")).replace("\r\n", "\n").replace("\r", "\n")
    text = strip_tags(text)
    text = _EXCESS_BLANK_LINES.sub("\n\n", text).strip()
    if not text:
        raise ValidationError({"body": "Comment cannot be empty."})
    if len(text) > COMMENT_MAX_LENGTH:
        raise ValidationError({"body": f"Comment cannot exceed {COMMENT_MAX_LENGTH} characters."})
    validate_no_active_content(text, "body")
    return text
