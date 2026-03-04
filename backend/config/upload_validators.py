import os

from django.core.exceptions import ValidationError


ALLOWED_PROFILE_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
ALLOWED_PROFILE_IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}

ALLOWED_VIDEO_EXTENSIONS = {"mp4", "m4v", "mov", "webm"}
ALLOWED_VIDEO_CONTENT_TYPES = {"video/mp4", "video/quicktime", "video/webm", "application/octet-stream"}

MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024
MAX_VIDEO_UPLOAD_BYTES = 1024 * 1024 * 1024  # 1 GB local/admin safety cap


def _extension(file_obj):
    name = getattr(file_obj, "name", "") or ""
    return os.path.splitext(name)[1].lstrip(".").lower()


def _content_type(file_obj):
    return str(getattr(file_obj, "content_type", "") or "").lower()


def validate_profile_image_upload(file_obj, field_name="profile_image"):
    if not file_obj:
        return
    ext = _extension(file_obj)
    if ext not in ALLOWED_PROFILE_IMAGE_EXTENSIONS:
        raise ValidationError({field_name: "Only JPG, PNG, or WEBP profile images are allowed."})
    size = getattr(file_obj, "size", None)
    if size and size > MAX_PROFILE_IMAGE_BYTES:
        raise ValidationError({field_name: "Profile image must be 5 MB or smaller."})
    content_type = _content_type(file_obj)
    if content_type and content_type not in ALLOWED_PROFILE_IMAGE_CONTENT_TYPES:
        raise ValidationError({field_name: "Unsupported profile image type."})


def validate_video_upload(file_obj, field_name="video_file"):
    if not file_obj:
        return
    ext = _extension(file_obj)
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise ValidationError({field_name: "Only MP4, M4V, MOV, or WEBM video files are allowed."})
    size = getattr(file_obj, "size", None)
    if size and size > MAX_VIDEO_UPLOAD_BYTES:
        raise ValidationError({field_name: "Video file is too large. Max allowed size is 1 GB."})
    content_type = _content_type(file_obj)
    if content_type and content_type not in ALLOWED_VIDEO_CONTENT_TYPES:
        raise ValidationError({field_name: "Unsupported video content type."})
