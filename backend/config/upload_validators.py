import os

from django.conf import settings
from django.core.exceptions import ValidationError
from PIL import Image, UnidentifiedImageError


ALLOWED_PROFILE_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
ALLOWED_PROFILE_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}

ALLOWED_VIDEO_EXTENSIONS = {"mp4", "m4v", "mov", "webm"}
ALLOWED_VIDEO_CONTENT_TYPES = {"video/mp4", "video/quicktime", "video/webm", "application/octet-stream"}

MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024
MAX_PROFILE_IMAGE_WIDTH = 4096
MAX_PROFILE_IMAGE_HEIGHT = 4096
MAX_PROFILE_IMAGE_PIXELS = 16_000_000
DEFAULT_MAX_VIDEO_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB


def _max_video_upload_bytes():
    configured = getattr(settings, "MAX_VIDEO_UPLOAD_BYTES", DEFAULT_MAX_VIDEO_UPLOAD_BYTES)
    try:
        value = int(configured)
    except (TypeError, ValueError):
        return DEFAULT_MAX_VIDEO_UPLOAD_BYTES
    return max(1, value)


def _extension(file_obj):
    name = getattr(file_obj, "name", "") or ""
    return os.path.splitext(name)[1].lstrip(".").lower()


def _content_type(file_obj):
    return str(getattr(file_obj, "content_type", "") or "").lower()


def _safe_tell(file_obj):
    try:
        return file_obj.tell()
    except (AttributeError, OSError, ValueError):
        return None


def _safe_seek(file_obj, position):
    try:
        file_obj.seek(position)
    except (AttributeError, OSError, ValueError):
        return


def _read_head(file_obj, bytes_count=64):
    if not file_obj:
        return b""
    cursor = _safe_tell(file_obj)
    try:
        chunk = file_obj.read(bytes_count) or b""
        if isinstance(chunk, str):
            return chunk.encode("utf-8", errors="ignore")
        return bytes(chunk)
    finally:
        if cursor is not None:
            _safe_seek(file_obj, cursor)


def _validate_filename(file_obj, field_name):
    raw_name = str(getattr(file_obj, "name", "") or "")
    name = raw_name.replace("\\", "/").split("/")[-1]
    if not name or name in {".", ".."}:
        raise ValidationError({field_name: "Uploaded file name is invalid."})
    if len(name) > 255:
        raise ValidationError({field_name: "Uploaded file name is too long."})
    if any(ord(char) < 32 for char in name):
        raise ValidationError({field_name: "Uploaded file name contains control characters."})


def _validate_profile_image_binary(file_obj, field_name):
    cursor = _safe_tell(file_obj)
    try:
        with Image.open(file_obj) as image:
            image_format = str(getattr(image, "format", "") or "").upper()
            if image_format not in ALLOWED_PROFILE_IMAGE_FORMATS:
                raise ValidationError({field_name: "Unsupported profile image type."})
            width, height = image.size
            if width <= 0 or height <= 0:
                raise ValidationError({field_name: "Profile image dimensions are invalid."})
            if width > MAX_PROFILE_IMAGE_WIDTH or height > MAX_PROFILE_IMAGE_HEIGHT:
                raise ValidationError(
                    {
                        field_name: (
                            f"Profile image dimensions are too large. Max allowed is "
                            f"{MAX_PROFILE_IMAGE_WIDTH}x{MAX_PROFILE_IMAGE_HEIGHT}."
                        )
                    }
                )
            if width * height > MAX_PROFILE_IMAGE_PIXELS:
                raise ValidationError({field_name: "Profile image pixel count is too large."})
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError):
        raise ValidationError({field_name: "Uploaded file is not a valid image."})
    finally:
        if cursor is not None:
            _safe_seek(file_obj, cursor)


def _looks_like_mp4_family(header):
    return len(header) >= 12 and header[4:8] == b"ftyp"


def _looks_like_webm(header):
    return len(header) >= 4 and header.startswith(b"\x1A\x45\xDF\xA3")


def _validate_video_binary(file_obj, field_name):
    header = _read_head(file_obj, bytes_count=64)
    if not header:
        raise ValidationError({field_name: "Uploaded video file is empty."})
    ext = _extension(file_obj)
    if ext == "webm":
        if not _looks_like_webm(header):
            raise ValidationError({field_name: "Uploaded file does not match WEBM format."})
        return
    if ext in {"mp4", "m4v", "mov"} and not _looks_like_mp4_family(header):
        raise ValidationError({field_name: "Uploaded file does not match MP4/MOV container format."})


def validate_profile_image_upload(file_obj, field_name="profile_image"):
    if not file_obj:
        return
    _validate_filename(file_obj, field_name)
    ext = _extension(file_obj)
    if ext not in ALLOWED_PROFILE_IMAGE_EXTENSIONS:
        raise ValidationError({field_name: "Only JPG, PNG, or WEBP profile images are allowed."})
    size = getattr(file_obj, "size", None)
    if size and size > MAX_PROFILE_IMAGE_BYTES:
        raise ValidationError({field_name: "Profile image must be 5 MB or smaller."})
    content_type = _content_type(file_obj)
    # Browsers/clients can send many valid image MIME aliases (e.g., image/pjpeg, image/jfif).
    # Rely on extension + binary verification, and only reject non-image MIME types.
    if content_type and not content_type.startswith("image/"):
        raise ValidationError({field_name: "Unsupported profile image type."})
    _validate_profile_image_binary(file_obj, field_name)


def validate_video_upload(file_obj, field_name="video_file"):
    if not file_obj:
        return
    _validate_filename(file_obj, field_name)
    ext = _extension(file_obj)
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise ValidationError({field_name: "Only MP4, M4V, MOV, or WEBM video files are allowed."})
    size = getattr(file_obj, "size", None)
    max_video_upload_bytes = _max_video_upload_bytes()
    if size and size > max_video_upload_bytes:
        limit_gb = max_video_upload_bytes / float(1024 * 1024 * 1024)
        raise ValidationError({field_name: f"Video file is too large. Max allowed size is {limit_gb:.0f} GB."})
    content_type = _content_type(file_obj)
    if content_type and content_type not in ALLOWED_VIDEO_CONTENT_TYPES:
        raise ValidationError({field_name: "Unsupported video content type."})
    _validate_video_binary(file_obj, field_name)
