import json
import os
import re
import warnings
import zipfile
from xml.etree import ElementTree

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


# ---------------------------------------------------------------------------
# Weekly report submissions (apps.reports)
#
# Students send PDF, PowerPoint/Word (and their OpenDocument equivalents) and
# Obsidian exports: notes (.md), canvases (.canvas, JSON Canvas), exported
# graphs (PNG/JPEG/WEBP/SVG) or a .zip of a vault folder. Every file is checked
# by content, never by name or browser-sent MIME type: the bytes must match
# the extension, Office macro formats are refused (also when renamed), and a
# .zip is inspected in memory (never extracted) for bombs, traversal paths,
# symlinks, encryption and file types outside the allow-list.
# ---------------------------------------------------------------------------
REPORT_ALLOWED_EXTENSIONS = (
    "pdf",
    "pptx",
    "ppt",
    "docx",
    "doc",
    "odt",
    "odp",
    "md",
    "canvas",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "svg",
    "zip",
)
REPORT_MACRO_EXTENSIONS = frozenset(
    {"pptm", "potm", "ppsm", "ppam", "sldm", "docm", "dotm", "xlsm", "xltm", "xlam"}
)
REPORT_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "ppt": "application/vnd.ms-powerpoint",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "odt": "application/vnd.oasis.opendocument.text",
    "odp": "application/vnd.oasis.opendocument.presentation",
    "md": "text/markdown; charset=utf-8",
    "canvas": "application/json",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "svg": "image/svg+xml",
    "zip": "application/zip",
}
# Files inside an Obsidian vault .zip: notes, canvases, attachments and the
# vault's JSON/CSS settings. Plugins (main.js) and anything executable are not.
REPORT_ZIP_INNER_EXTENSIONS = frozenset(
    {
        "md",
        "markdown",
        "txt",
        "canvas",
        "base",
        "json",
        "css",
        "csv",
        "pdf",
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "bmp",
        "svg",
    }
)
# OS metadata that zip tools add on their own; ignored, never rejected.
REPORT_ZIP_IGNORED_NAMES = frozenset({".ds_store", "thumbs.db", "desktop.ini"})
REPORT_TEXT_MAX_BYTES = 5 * 1024 * 1024
REPORT_CANVAS_MAX_BYTES = 5 * 1024 * 1024
REPORT_CANVAS_MAX_ITEMS = 5000
REPORT_OFFICE_MAX_ENTRIES = 20000
REPORT_OFFICE_MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_REPORT_ZIP_MAX_ENTRIES = 2000
DEFAULT_REPORT_ZIP_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024
DEFAULT_REPORT_ZIP_MAX_RATIO = 100
OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ZIP_LOCAL_HEADER_MAGIC = b"PK\x03\x04"
_OLE_SCAN_CHUNK_BYTES = 1024 * 1024
_OLE_VBA_MARKER = "_VBA_PROJECT".encode("utf-16-le")
_OLE_WORD_MARKER = "WordDocument".encode("utf-16-le")
_OLE_POWERPOINT_MARKER = "PowerPoint Document".encode("utf-16-le")
_SVG_FORBIDDEN_PATTERNS = (
    re.compile(r"<\s*script\b", re.IGNORECASE),
    re.compile(r"<!\s*(?:doctype|entity)\b", re.IGNORECASE),
    re.compile(r"\bon[a-z]+\s*=", re.IGNORECASE),
    re.compile(r"javascript\s*:", re.IGNORECASE),
)
_DRIVE_PATH = re.compile(r"^[A-Za-z]:")


def report_extension(name):
    return os.path.splitext(str(name or ""))[1].lstrip(".").lower()


def report_content_type(extension):
    return REPORT_CONTENT_TYPES.get(str(extension or "").lower(), "application/octet-stream")


def _report_reject(field_name, message):
    raise ValidationError({field_name: message})


def _display_name(file_obj):
    raw = str(getattr(file_obj, "name", "") or "").replace("\\", "/").split("/")[-1]
    return raw[:80] or "This file"


def _format_megabytes(byte_count):
    megabytes = byte_count / float(1024 * 1024)
    if megabytes >= 10 or float(megabytes).is_integer():
        return f"{megabytes:.0f} MB"
    return f"{megabytes:.1f} MB"


def _looks_like_executable(header):
    return (
        header.startswith(b"MZ")
        or header.startswith(b"\x7fELF")
        or header.startswith(b"#!")
        or header[:4] in {b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe"}
    )


def _read_all_limited(file_obj, limit, field_name, label):
    cursor = _safe_tell(file_obj)
    try:
        _safe_seek(file_obj, 0)
        data = file_obj.read(limit + 1) or b""
    finally:
        if cursor is not None:
            _safe_seek(file_obj, cursor)
    if isinstance(data, str):
        data = data.encode("utf-8")
    if len(data) > limit:
        _report_reject(field_name, f"{label} files must be {_format_megabytes(limit)} or smaller.")
    return bytes(data)


def _decode_utf8_text(data, field_name, label):
    if b"\x00" in data:
        _report_reject(field_name, f"This {label} file contains binary data. Upload a plain-text {label} file.")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        _report_reject(field_name, f"This {label} file is not UTF-8 text. Save it as UTF-8 and upload again.")


def _open_zip(file_obj, field_name, ext):
    _safe_seek(file_obj, 0)
    try:
        return zipfile.ZipFile(file_obj)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, ValueError, EOFError):
        _report_reject(field_name, f"This .{ext} file is damaged or is not a real .{ext} file.")


def _zip_totals_within(infos, max_entries, max_uncompressed):
    return len(infos) <= max_entries and sum(max(0, int(info.file_size)) for info in infos) <= max_uncompressed


def _check_office_container(file_obj, ext, field_name):
    """.docx / .pptx: an Office Open XML zip with the right main part and no VBA."""
    kind = "Word document" if ext == "docx" else "PowerPoint presentation"
    archive = _open_zip(file_obj, field_name, ext)
    try:
        infos = archive.infolist()
        if not _zip_totals_within(infos, REPORT_OFFICE_MAX_ENTRIES, REPORT_OFFICE_MAX_UNCOMPRESSED_BYTES):
            _report_reject(field_name, f"This .{ext} file is unusually large inside. Save it again and retry.")
        names = {info.filename.replace("\\", "/").lower() for info in infos}
        if "[content_types].xml" not in names:
            _report_reject(field_name, f"This file is not a real .{ext} {kind}.")
        main_part = "word/document.xml" if ext == "docx" else "ppt/presentation.xml"
        if main_part not in names:
            _report_reject(field_name, f"This file is not a {kind}. Check the file type and try again.")
        try:
            content_types = archive.read("[Content_Types].xml")[: 2 * 1024 * 1024].lower()
        except (KeyError, zipfile.BadZipFile, OSError, RuntimeError, NotImplementedError, ValueError):
            content_types = None
        if content_types is None:
            _report_reject(field_name, f"This .{ext} file is damaged.")
        if any(name.endswith("vbaproject.bin") for name in names) or b"macroenabled" in content_types:
            _report_reject(
                field_name,
                f"This file contains macros, which are not accepted. Save it as a normal .{ext} (without macros) and upload again.",
            )
    finally:
        archive.close()


def _check_opendocument(file_obj, ext, field_name):
    expected = {
        "odt": b"application/vnd.oasis.opendocument.text",
        "odp": b"application/vnd.oasis.opendocument.presentation",
    }[ext]
    archive = _open_zip(file_obj, field_name, ext)
    try:
        infos = archive.infolist()
        if not infos or infos[0].filename != "mimetype":
            _report_reject(field_name, f"This file is not a real OpenDocument (.{ext}) file.")
        if not _zip_totals_within(infos, REPORT_OFFICE_MAX_ENTRIES, REPORT_OFFICE_MAX_UNCOMPRESSED_BYTES):
            _report_reject(field_name, f"This .{ext} file is unusually large inside. Save it again and retry.")
        try:
            mimetype = archive.read("mimetype")[:200].strip()
        except (KeyError, zipfile.BadZipFile, OSError, RuntimeError, NotImplementedError, ValueError):
            mimetype = b""
        if mimetype != expected:
            _report_reject(field_name, f"This file is not a real OpenDocument (.{ext}) file.")
        if any(info.filename.startswith(("Basic/", "Scripts/")) for info in infos):
            _report_reject(field_name, "This file contains macros, which are not accepted. Remove them and upload again.")
    finally:
        archive.close()


def _check_ole_document(file_obj, header, ext, field_name):
    """Legacy .doc / .ppt (OLE2 compound file): the right stream and no VBA project."""
    kind = "Word document" if ext == "doc" else "PowerPoint presentation"
    if not header.startswith(OLE2_MAGIC):
        _report_reject(field_name, f"This file is not a real .{ext} {kind}.")
    marker = _OLE_WORD_MARKER if ext == "doc" else _OLE_POWERPOINT_MARKER
    found_marker = False
    found_macros = False
    tail = b""
    cursor = _safe_tell(file_obj)
    try:
        _safe_seek(file_obj, 0)
        while True:
            chunk = file_obj.read(_OLE_SCAN_CHUNK_BYTES)
            if not chunk:
                break
            window = tail + chunk
            if _OLE_VBA_MARKER in window:
                found_macros = True
                break
            found_marker = found_marker or marker in window
            tail = window[-64:]
    finally:
        if cursor is not None:
            _safe_seek(file_obj, cursor)
    if found_macros:
        _report_reject(
            field_name,
            f"This file contains macros, which are not accepted. Save it as .{ext}x without macros and upload again.",
        )
    if not found_marker:
        _report_reject(field_name, f"This file is not a {kind}. Check the file type and try again.")


def _check_report_image(file_obj, header, ext, field_name):
    signatures = {
        "png": header.startswith(b"\x89PNG\r\n\x1a\n"),
        "jpg": header.startswith(b"\xff\xd8\xff"),
        "jpeg": header.startswith(b"\xff\xd8\xff"),
        "webp": len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP",
    }
    if not signatures[ext]:
        _report_reject(field_name, f"This file is not a real .{ext} image.")
    expected_format = {"png": "PNG", "jpg": "JPEG", "jpeg": "JPEG", "webp": "WEBP"}[ext]
    problem = None
    cursor = _safe_tell(file_obj)
    try:
        _safe_seek(file_obj, 0)
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(file_obj) as image:
                if str(image.format or "").upper() != expected_format:
                    problem = f"This file is not a real .{ext} image."
                else:
                    image.verify()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        problem = "This image is too large (too many pixels). Export it at a smaller size."
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError):
        problem = f"This .{ext} image is damaged."
    finally:
        if cursor is not None:
            _safe_seek(file_obj, cursor)
    if problem:
        _report_reject(field_name, problem)


def _check_report_svg(file_obj, field_name):
    text = _decode_utf8_text(_read_all_limited(file_obj, REPORT_TEXT_MAX_BYTES, field_name, "SVG"), field_name, "SVG")
    if any(pattern.search(text) for pattern in _SVG_FORBIDDEN_PATTERNS):
        _report_reject(
            field_name,
            "This SVG contains scripts or embedded definitions, which are not accepted. Export it again as a plain image.",
        )
    try:
        root = ElementTree.fromstring(text.strip())
    except ElementTree.ParseError:
        root = None
    if root is None or str(root.tag).rsplit("}", 1)[-1].lower() != "svg":
        _report_reject(field_name, "This file is damaged or is not an SVG image.")


def validate_obsidian_canvas_text(text, field_name="file"):
    """JSON Canvas (https://jsoncanvas.org): ``{"nodes": [...], "edges": [...]}``."""
    try:
        payload = json.loads(text) if str(text or "").strip() else {}
    except (ValueError, RecursionError):
        payload = None
    if payload is None:
        _report_reject(field_name, "This .canvas file is not valid JSON. Export it from Obsidian again.")
    if not isinstance(payload, dict):
        _report_reject(field_name, "This .canvas file is not an Obsidian canvas.")
    nodes = payload.get("nodes", [])
    edges = payload.get("edges", [])
    if not isinstance(nodes, list) or not isinstance(edges, list):
        _report_reject(field_name, "This .canvas file is not an Obsidian canvas.")
    if len(nodes) + len(edges) > REPORT_CANVAS_MAX_ITEMS:
        _report_reject(field_name, f"This canvas has more than {REPORT_CANVAS_MAX_ITEMS} cards and connections.")
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str):
            _report_reject(field_name, "This .canvas file has a card without an id. Export it from Obsidian again.")
    for edge in edges:
        if not isinstance(edge, dict) or not isinstance(edge.get("fromNode"), str) or not isinstance(edge.get("toNode"), str):
            _report_reject(field_name, "This .canvas file has a broken connection. Export it from Obsidian again.")
    return payload


def _zip_limit(limits, key, default):
    try:
        return max(1, int((limits or {}).get(key) or default))
    except (TypeError, ValueError):
        return default


def _check_obsidian_zip(file_obj, field_name, limits=None):
    max_entries = _zip_limit(limits, "max_entries", DEFAULT_REPORT_ZIP_MAX_ENTRIES)
    max_uncompressed = _zip_limit(limits, "max_uncompressed_bytes", DEFAULT_REPORT_ZIP_MAX_UNCOMPRESSED_BYTES)
    max_ratio = _zip_limit(limits, "max_ratio", DEFAULT_REPORT_ZIP_MAX_RATIO)
    archive = _open_zip(file_obj, field_name, "zip")
    try:
        infos = archive.infolist()
        if len(infos) > max_entries:
            _report_reject(field_name, f"This .zip has more than {max_entries} entries. Zip only the vault folder you need.")
        total_uncompressed = 0
        total_compressed = 0
        file_count = 0
        for info in infos:
            name = info.filename.replace("\\", "/")
            if not name or len(name) > 1024 or any(ord(char) < 32 for char in name):
                _report_reject(field_name, "This .zip contains a file with an invalid name.")
            if name.startswith("/") or _DRIVE_PATH.match(name):
                _report_reject(field_name, "This .zip contains absolute paths, which are not allowed.")
            if ".." in name.split("/"):
                _report_reject(field_name, "This .zip contains '..' paths, which are not allowed.")
            if info.flag_bits & 0x1:
                _report_reject(field_name, "This .zip is password-protected. Upload it without a password.")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                _report_reject(field_name, "This .zip contains symbolic links, which are not allowed.")
            if name.endswith("/"):
                continue
            file_size = max(0, int(info.file_size))
            compress_size = max(0, int(info.compress_size))
            total_uncompressed += file_size
            total_compressed += compress_size
            if total_uncompressed > max_uncompressed:
                _report_reject(
                    field_name,
                    f"This .zip unpacks to more than {_format_megabytes(max_uncompressed)}. Zip a smaller part of the vault.",
                )
            if file_size > 1024 * 1024 and file_size > max_ratio * max(1, compress_size):
                _report_reject(field_name, "This .zip is compressed suspiciously well (a possible zip bomb) and was rejected.")
            parts = [part for part in name.split("/") if part]
            base_name = parts[-1] if parts else ""
            if (parts and parts[0] == "__MACOSX") or base_name.lower() in REPORT_ZIP_IGNORED_NAMES or base_name.startswith("._"):
                continue
            file_count += 1
            if report_extension(base_name) not in REPORT_ZIP_INNER_EXTENSIONS:
                shown = name if len(name) <= 80 else f"...{name[-77:]}"
                hint = " Leave out the .obsidian/plugins folder." if "/plugins/" in f"/{name}" else ""
                _report_reject(
                    field_name,
                    f"This .zip contains a file type that is not allowed ({shown}). "
                    f"Vault zips may contain notes, canvases, images and PDFs only.{hint}",
                )
        if file_count == 0:
            _report_reject(field_name, "This .zip has no notes or files in it.")
        if total_uncompressed > 1024 * 1024 and total_uncompressed > max_ratio * max(1, total_compressed):
            _report_reject(field_name, "This .zip is compressed suspiciously well (a possible zip bomb) and was rejected.")
    finally:
        archive.close()


def validate_report_upload(file_obj, *, max_bytes, field_name="file", allowed_extensions=None, zip_limits=None):
    """Validate one weekly-report file by its content.

    Returns ``{"extension": ..., "content_type": ...}`` (the type to serve it
    with, derived from the verified extension, never from the browser).
    Raises ``ValidationError({field_name: message})`` with a sentence the
    student can act on.
    """
    if not file_obj:
        _report_reject(field_name, "Choose a file to upload.")
    _validate_filename(file_obj, field_name)
    _validate_no_dangerous_double_extension(file_obj, field_name)
    ext = _extension(file_obj)
    if ext in REPORT_MACRO_EXTENSIONS:
        _report_reject(
            field_name,
            "Macro-enabled Office files (.pptm, .docm) are not accepted. Save it as .pptx or .docx and upload again.",
        )
    wanted = set(allowed_extensions or REPORT_ALLOWED_EXTENSIONS)
    allowed = [value for value in REPORT_ALLOWED_EXTENSIONS if value in wanted]
    if ext not in allowed:
        listed = ", ".join(f".{value}" for value in allowed)
        shown = f".{ext} files are" if ext else "Files without an extension are"
        _report_reject(field_name, f"{shown} not accepted for this report. Allowed: {listed}.")
    size = getattr(file_obj, "size", None)
    if not size:
        _report_reject(field_name, f"{_display_name(file_obj)} is empty.")
    max_bytes = max(1, int(max_bytes))
    if size > max_bytes:
        _report_reject(field_name, f"{_display_name(file_obj)} is larger than the {_format_megabytes(max_bytes)} limit.")
    header = _read_head(file_obj, bytes_count=2048)
    if not header:
        _report_reject(field_name, f"{_display_name(file_obj)} is empty.")
    if _looks_like_executable(header):
        _report_reject(field_name, "Programs and scripts are not accepted.")

    if ext == "pdf":
        if b"%PDF-" not in header[:1024]:
            _report_reject(field_name, "This file is not a real PDF. Export or save it as PDF and try again.")
    elif ext in {"docx", "pptx"}:
        if header.startswith(OLE2_MAGIC):
            _report_reject(
                field_name,
                f"This .{ext} looks password-protected or saved in an older format. "
                f"Remove the password or save it as .{ext} again.",
            )
        if not header.startswith(ZIP_LOCAL_HEADER_MAGIC):
            _report_reject(field_name, f"This file is not a real .{ext} file.")
        _check_office_container(file_obj, ext, field_name)
    elif ext in {"odt", "odp"}:
        if not header.startswith(ZIP_LOCAL_HEADER_MAGIC):
            _report_reject(field_name, f"This file is not a real .{ext} file.")
        _check_opendocument(file_obj, ext, field_name)
    elif ext in {"doc", "ppt"}:
        _check_ole_document(file_obj, header, ext, field_name)
    elif ext == "md":
        data = _read_all_limited(file_obj, REPORT_TEXT_MAX_BYTES, field_name, "Markdown")
        _decode_utf8_text(data, field_name, "Markdown")
    elif ext == "canvas":
        data = _read_all_limited(file_obj, REPORT_CANVAS_MAX_BYTES, field_name, "Canvas")
        validate_obsidian_canvas_text(_decode_utf8_text(data, field_name, "canvas"), field_name)
    elif ext in {"png", "jpg", "jpeg", "webp"}:
        _check_report_image(file_obj, header, ext, field_name)
    elif ext == "svg":
        _check_report_svg(file_obj, field_name)
    elif ext == "zip":
        if not header.startswith(ZIP_LOCAL_HEADER_MAGIC):
            _report_reject(field_name, "This file is not a real .zip file.")
        _check_obsidian_zip(file_obj, field_name, zip_limits)
    _safe_seek(file_obj, 0)
    return {"extension": ext, "content_type": report_content_type(ext)}
