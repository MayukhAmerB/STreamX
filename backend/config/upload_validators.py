import os

from django.conf import settings
from django.core.exceptions import ValidationError
from PIL import Image, UnidentifiedImageError


ALLOWED_PROFILE_IMAGE_EXTENSIONS = {"jpg", "png"}
ALLOWED_PROFILE_IMAGE_FORMATS = {"JPEG", "PNG"}
DISALLOWED_EMBEDDED_EXTENSIONS = {
    "php",
    "phtml",
    "phar",
    "jsp",
    "asp",
    "aspx",
    "cgi",
    "pl",
    "py",
    "rb",
    "sh",
    "bash",
    "exe",
    "dll",
    "js",
    "html",
    "htm",
}

ALLOWED_VIDEO_EXTENSIONS = {"mp4", "m4v", "mov", "webm"}
ALLOWED_VIDEO_CONTENT_TYPES = {"video/mp4", "video/quicktime", "video/webm", "application/octet-stream"}
ALLOWED_AUDIO_EXTENSIONS = {"mp3", "m4a", "aac", "wav", "ogg"}
ALLOWED_AUDIO_CONTENT_TYPES = {
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/aac",
    "audio/x-m4a",
    "audio/m4a",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/vnd.wave",
    "audio/ogg",
    "application/ogg",
    "application/octet-stream",
}
ALLOWED_RESOURCE_EXTENSIONS = {"txt", "pdf", "ppt", "pptx", "doc", "docx"}
ALLOWED_RESOURCE_CONTENT_TYPES = {
    "text/plain",
    "application/pdf",
    "application/msword",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/octet-stream",
}

MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024
MAX_PROFILE_IMAGE_WIDTH = 4096
MAX_PROFILE_IMAGE_HEIGHT = 4096
MAX_PROFILE_IMAGE_PIXELS = 16_000_000
DEFAULT_MAX_VIDEO_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024  # 5 GB
DEFAULT_MAX_RESOURCE_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB
DEFAULT_MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB


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


def _validate_no_dangerous_double_extension(file_obj, field_name):
    raw_name = str(getattr(file_obj, "name", "") or "")
    name = raw_name.replace("\\", "/").split("/")[-1]
    parts = [segment.strip().lower() for segment in name.split(".") if segment.strip()]
    if len(parts) < 3:
        return

    embedded_extensions = parts[1:-1]
    if any(extension in DISALLOWED_EMBEDDED_EXTENSIONS for extension in embedded_extensions):
        raise ValidationError(
            {
                field_name: (
                    "File names with embedded executable or script extensions are not allowed."
                )
            }
        )


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


# OBS's own recording containers. Accepted only for class-recording OBS uploads
# (never for general lecture uploads): the stream recorder remuxes them to a
# faststart MP4 (stream copy) before the lecture video is swapped.
OBS_REMUX_EXTENSIONS = {"mkv", "flv", "ts"}
ALLOWED_OBS_RECORDING_EXTENSIONS = ALLOWED_VIDEO_EXTENSIONS | OBS_REMUX_EXTENSIONS
ALLOWED_OBS_RECORDING_CONTENT_TYPES = ALLOWED_VIDEO_CONTENT_TYPES | {
    "video/x-matroska",
    "video/matroska",
    "video/x-flv",
    "video/flv",
    "video/mp2t",
    "video/vnd.dlna.mpeg-tts",
}
MPEG_TS_PACKET_BYTES = 188


def _looks_like_matroska(header):
    return _looks_like_webm(header)  # Same EBML magic: WEBM is a Matroska profile.


def _looks_like_flv(header):
    return len(header) >= 4 and header[:3] == b"FLV" and header[3] == 0x01


def _looks_like_mpeg_ts(header):
    if len(header) < MPEG_TS_PACKET_BYTES + 1:
        return len(header) >= 1 and header[0] == 0x47
    return header[0] == 0x47 and header[MPEG_TS_PACKET_BYTES] == 0x47


def needs_obs_remux(file_name):
    return os.path.splitext(str(file_name or ""))[1].lstrip(".").lower() in OBS_REMUX_EXTENSIONS


def validate_obs_recording_upload(file_obj, field_name="video_file", max_bytes=None):
    """Class-recording OBS upload: the lecture formats plus OBS's MKV/FLV/TS."""
    if not file_obj:
        return
    ext = _extension(file_obj)
    if ext not in OBS_REMUX_EXTENSIONS:
        try:
            validate_video_upload(file_obj, field_name, max_bytes=max_bytes)
        except ValidationError as exc:
            if ext not in ALLOWED_VIDEO_EXTENSIONS:
                raise ValidationError(
                    {field_name: "Only MP4, M4V, MOV, WEBM, MKV, FLV or TS recordings are allowed."}
                ) from exc
            raise
        return
    _validate_filename(file_obj, field_name)
    size = getattr(file_obj, "size", None)
    max_video_upload_bytes = int(max_bytes or _max_video_upload_bytes())
    if size and size > max_video_upload_bytes:
        limit_gb = max_video_upload_bytes / float(1024 * 1024 * 1024)
        raise ValidationError({field_name: f"Video file is too large. Max allowed size is {limit_gb:.0f} GB."})
    content_type = _content_type(file_obj)
    if content_type and content_type not in ALLOWED_OBS_RECORDING_CONTENT_TYPES:
        raise ValidationError({field_name: "Unsupported video content type."})
    header = _read_head(file_obj, bytes_count=MPEG_TS_PACKET_BYTES + 1)
    if not header:
        raise ValidationError({field_name: "Uploaded video file is empty."})
    checks = {"mkv": _looks_like_matroska, "flv": _looks_like_flv, "ts": _looks_like_mpeg_ts}
    if not checks[ext](header):
        raise ValidationError({field_name: f"Uploaded file does not match {ext.upper()} format."})


def validate_profile_image_upload(file_obj, field_name="profile_image"):
    if not file_obj:
        return
    _validate_filename(file_obj, field_name)
    _validate_no_dangerous_double_extension(file_obj, field_name)
    ext = _extension(file_obj)
    if ext not in ALLOWED_PROFILE_IMAGE_EXTENSIONS:
        raise ValidationError({field_name: "Only JPG or PNG profile images are allowed."})
    size = getattr(file_obj, "size", None)
    if size and size > MAX_PROFILE_IMAGE_BYTES:
        raise ValidationError({field_name: "Profile image must be 5 MB or smaller."})
    content_type = _content_type(file_obj)
    # Browsers/clients can send many valid image MIME aliases (e.g., image/pjpeg, image/jfif).
    # Rely on extension + binary verification, and only reject non-image MIME types.
    if content_type and not content_type.startswith("image/"):
        raise ValidationError({field_name: "Unsupported profile image type."})
    _validate_profile_image_binary(file_obj, field_name)


def validate_video_upload(file_obj, field_name="video_file", max_bytes=None):
    if not file_obj:
        return
    _validate_filename(file_obj, field_name)
    ext = _extension(file_obj)
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise ValidationError({field_name: "Only MP4, M4V, MOV, or WEBM video files are allowed."})
    size = getattr(file_obj, "size", None)
    max_video_upload_bytes = int(max_bytes or _max_video_upload_bytes())
    if size and size > max_video_upload_bytes:
        if max_video_upload_bytes < 1024 * 1024 * 1024:
            limit_mb = max_video_upload_bytes / float(1024 * 1024)
            raise ValidationError({field_name: f"Video file is too large. Max allowed size is {limit_mb:.0f} MB."})
        limit_gb = max_video_upload_bytes / float(1024 * 1024 * 1024)
        raise ValidationError({field_name: f"Video file is too large. Max allowed size is {limit_gb:.0f} GB."})
    content_type = _content_type(file_obj)
    if content_type and content_type not in ALLOWED_VIDEO_CONTENT_TYPES:
        raise ValidationError({field_name: "Unsupported video content type."})
    _validate_video_binary(file_obj, field_name)


def _looks_like_mp3(header):
    if len(header) >= 3 and header[:3] == b"ID3":
        return True
    # MPEG audio frame sync: 11 set bits (0xFF followed by 0xE0..0xFF high bits).
    return len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0


def _looks_like_wav(header):
    return len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE"


def _looks_like_ogg(header):
    return len(header) >= 4 and header[:4] == b"OggS"


def _looks_like_adts_aac(header):
    return len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xF6) == 0xF0


def _validate_audio_binary(file_obj, field_name):
    header = _read_head(file_obj, bytes_count=64)
    if not header:
        raise ValidationError({field_name: "Uploaded audio file is empty."})
    ext = _extension(file_obj)
    if ext == "wav":
        if not _looks_like_wav(header):
            raise ValidationError({field_name: "Uploaded file does not match WAV format."})
        return
    if ext == "ogg":
        if not _looks_like_ogg(header):
            raise ValidationError({field_name: "Uploaded file does not match OGG format."})
        return
    if ext in {"m4a", "aac"}:
        # m4a/aac is usually an MP4 container (ftyp); bare AAC uses an ADTS sync word.
        if not (_looks_like_mp4_family(header) or _looks_like_adts_aac(header)):
            raise ValidationError({field_name: "Uploaded file does not match AAC/M4A format."})
        return
    if ext == "mp3" and not _looks_like_mp3(header):
        raise ValidationError({field_name: "Uploaded file does not match MP3 format."})


def validate_audio_upload(file_obj, field_name="audio_file", max_bytes=None):
    if not file_obj:
        return
    _validate_filename(file_obj, field_name)
    _validate_no_dangerous_double_extension(file_obj, field_name)
    ext = _extension(file_obj)
    if ext not in ALLOWED_AUDIO_EXTENSIONS:
        raise ValidationError({field_name: "Only MP3, M4A, AAC, WAV, or OGG audio files are allowed."})
    size = getattr(file_obj, "size", None)
    max_audio_upload_bytes = int(max_bytes or DEFAULT_MAX_AUDIO_UPLOAD_BYTES)
    if size and size > max_audio_upload_bytes:
        limit_mb = max_audio_upload_bytes / float(1024 * 1024)
        raise ValidationError(
            {field_name: f"Audio file is too large. Max allowed size is {limit_mb:.0f} MB."}
        )
    content_type = _content_type(file_obj)
    if content_type and content_type not in ALLOWED_AUDIO_CONTENT_TYPES:
        raise ValidationError({field_name: "Unsupported audio content type."})
    _validate_audio_binary(file_obj, field_name)


def validate_resource_upload(file_obj, field_name="resource_file", max_bytes=None):
    if not file_obj:
        return
    _validate_filename(file_obj, field_name)
    ext = _extension(file_obj)
    if ext not in ALLOWED_RESOURCE_EXTENSIONS:
        raise ValidationError(
            {field_name: "Only TXT, PDF, PPT, PPTX, DOC, or DOCX files are allowed."}
        )
    size = getattr(file_obj, "size", None)
    max_resource_upload_bytes = int(max_bytes or DEFAULT_MAX_RESOURCE_UPLOAD_BYTES)
    if size and size > max_resource_upload_bytes:
        limit_mb = max_resource_upload_bytes / float(1024 * 1024)
        raise ValidationError(
            {field_name: f"Resource file is too large. Max allowed size is {limit_mb:.0f} MB."}
        )
    content_type = _content_type(file_obj)
    if content_type and content_type not in ALLOWED_RESOURCE_CONTENT_TYPES:
        raise ValidationError({field_name: "Unsupported resource content type."})
