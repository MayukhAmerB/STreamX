"""Profile image intake: limits, virus scan, metadata PII check, re-encode.

``process_upload`` turns an uploaded file into clean WebP bytes:

1. Size and type limits: at most ``PROFILES_IMAGE_MAX_BYTES`` (8 MB); the
   first bytes must be JPEG, PNG or WebP (SVG, GIF, HEIC and anything else are
   refused); at most 40 megapixels and 64 px on the short side.
2. ClamAV: the original file is written to a private ``.incoming`` folder and
   scanned with the existing scanner (``apps.reports.antivirus``), fail
   closed: an outage refuses the upload (503), an infected file is refused.
3. Metadata: EXIF/XMP/IPTC/PNG text and JPEG comments are read and run
   through the PII guard; an author name, email, phone number or address in
   them refuses the upload with the reason. GPS data is noted.
4. Re-encode: orientation applied, cropped/resized for its slot, then a NEW
   image is built from the decoded pixels only and saved as WebP. No EXIF,
   GPS, ICC, XMP, comment or trailing bytes survive, so a polyglot
   (image + HTML/ZIP/script) cannot either. The result is decoded again to
   prove it is a valid image.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import uuid
from dataclasses import dataclass, field

from django.conf import settings
from PIL import Image, ImageOps, UnidentifiedImageError
from PIL import features as pil_features

from apps.core.errors import DomainError, ValidationFailed

from . import pii
from .storage import incoming_dir

logger = logging.getLogger("apps.profiles.images")

MAX_PIXELS = 40_000_000
MIN_SIDE = 64
MAX_SIDE = 12_000
TARGETS = {
    # kind: (width, height, crop?)
    "avatar": (512, 512, True),
    "banner": (2400, 800, True),
    "gallery": (1600, 1600, False),
}
WEBP_QUALITY = 82
_SIGNATURES = (
    (b"\xff\xd8\xff", "JPEG"),
    (b"\x89PNG\r\n\x1a\n", "PNG"),
)
# EXIF tags that hold free text a person typed (or a camera owner name).
TEXT_TAGS = {
    0x010D: "DocumentName",
    0x010E: "ImageDescription",
    0x013B: "Artist",
    0x8298: "Copyright",
    0x9286: "UserComment",
    0x9C9B: "XPTitle",
    0x9C9C: "XPComment",
    0x9C9D: "XPAuthor",
    0x9C9E: "XPKeywords",
    0x9C9F: "XPSubject",
    0xA430: "CameraOwnerName",
}
EXIF_IFD = 0x8769
GPS_IFD = 0x8825


class ImageRejected(DomainError):
    status = 400
    code = "image_rejected"
    default_message = "This image can't be used."


class ImageMetadataPii(DomainError):
    status = 422
    code = "pii_in_image_metadata"
    default_message = "This image's hidden details contain personal information."


@dataclass
class ProcessedImage:
    data: bytes
    width: int
    height: int
    content_type: str
    sha256: str
    original_format: str
    stripped: list[str] = field(default_factory=list)
    scanner: str = ""
    scanner_version: str = ""


def max_upload_bytes() -> int:
    return int(getattr(settings, "PROFILES_IMAGE_MAX_BYTES", 8 * 1024 * 1024) or 8 * 1024 * 1024)


def sniff_format(head: bytes) -> str | None:
    for signature, name in _SIGNATURES:
        if head.startswith(signature):
            return name
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WEBP"
    return None


def _decode_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, tuple) and all(isinstance(item, int) for item in value):
        value = bytes(value)
    if isinstance(value, bytes):
        if value.startswith((b"ASCII\x00\x00\x00", b"UNICODE\x00", b"JIS\x00\x00\x00\x00\x00", b"\x00" * 8)):
            prefix, value = value[:8], value[8:]
            if prefix.startswith(b"UNICODE"):
                for encoding in ("utf-16-be", "utf-16-le"):
                    try:
                        return value.decode(encoding).replace("\x00", " ").strip()
                    except UnicodeDecodeError:
                        continue
        if len(value) >= 2 and value.count(b"\x00") >= len(value) // 3:
            try:
                return value.decode("utf-16-le").replace("\x00", " ").strip()
            except UnicodeDecodeError:
                pass
        return value.decode("utf-8", errors="ignore").replace("\x00", " ").strip()
    return str(value).replace("\x00", " ").strip()


_XMP_TEXT = re.compile(r">([^<>]{2,500})<")
_XMP_ATTR = re.compile(r'(?:creator|rights|description|title|Author|Credit|CiEmailWork|CiTelWork|CiAdrExtadr|CiAdrCity|CiAdrPcode|CiUrlWork|Owner\w*)="([^"]{2,500})"')


def _xmp_texts(xmp) -> list[str]:
    text = _decode_text(xmp)
    found = [value.strip() for value in _XMP_TEXT.findall(text)] + [value.strip() for value in _XMP_ATTR.findall(text)]
    # Skip machine identifiers (xmp.iid:..., uuid:..., hex digests).
    return [value for value in found if value and " " in value or (value and not re.fullmatch(r"[\w.:\-/+=]+", value))]


def metadata_texts(image: Image.Image) -> tuple[list[tuple[str, str]], list[str]]:
    """``([(path, text), ...], [present kinds])`` of the image's metadata."""
    texts: list[tuple[str, str]] = []
    present: list[str] = []
    try:
        exif = image.getexif()
    except Exception:  # noqa: BLE001 - unreadable EXIF is dropped by the re-encode anyway
        exif = None
    if exif:
        present.append("exif")
        for tag, name in TEXT_TAGS.items():
            if tag in exif:
                texts.append((f"image.metadata.{name}", _decode_text(exif.get(tag))))
        try:
            sub = exif.get_ifd(EXIF_IFD)
        except Exception:  # noqa: BLE001
            sub = {}
        for tag, name in TEXT_TAGS.items():
            if tag in sub:
                texts.append((f"image.metadata.{name}", _decode_text(sub.get(tag))))
        try:
            gps = exif.get_ifd(GPS_IFD)
        except Exception:  # noqa: BLE001
            gps = {}
        if gps:
            present.append("location")
    info = getattr(image, "info", {}) or {}
    if info.get("comment"):
        present.append("comment")
        texts.append(("image.metadata.comment", _decode_text(info.get("comment"))))
    for key in ("xmp", "XML:com.adobe.xmp"):
        if info.get(key):
            present.append("xmp")
            for index, value in enumerate(_xmp_texts(info.get(key))):
                texts.append((f"image.metadata.xmp[{index}]", value))
    png_text = getattr(image, "text", None)
    if isinstance(png_text, dict):
        for key, value in png_text.items():
            if key in ("XML:com.adobe.xmp",):
                continue
            present.append("text")
            texts.append((f"image.metadata.{str(key)[:40]}", _decode_text(value)))
    if info.get("icc_profile"):
        present.append("color_profile")
    return [(path, value) for path, value in texts if value], sorted(set(present))


def _scan(path: str):
    from apps.reports import antivirus

    try:
        verdict = antivirus.scan_path(path)
    except antivirus.ScanRefused:
        raise ImageRejected("This image is too large to check for viruses.", code="image_too_large") from None
    if not verdict.clean:
        raise ImageRejected("This file was blocked by the virus scanner.", code="image_blocked", details={"blocked": True})
    return verdict


def _resize(image: Image.Image, kind: str) -> Image.Image:
    width, height, crop = TARGETS[kind]
    if crop:
        if image.width < width or image.height < height:
            # Crop to the slot's aspect ratio without upscaling.
            ratio = width / height
            if image.width / image.height > ratio:
                target = (max(1, int(image.height * ratio)), image.height)
            else:
                target = (image.width, max(1, int(image.width / ratio)))
            return ImageOps.fit(image, target, method=Image.Resampling.LANCZOS)
        return ImageOps.fit(image, (width, height), method=Image.Resampling.LANCZOS)
    copy = image.copy()
    copy.thumbnail((width, height), Image.Resampling.LANCZOS)
    return copy


def _reencode(image: Image.Image, kind: str) -> tuple[bytes, int, int, str]:
    image = ImageOps.exif_transpose(image)
    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    mode = "RGBA" if has_alpha else "RGB"
    image = image.convert(mode)
    image = _resize(image, kind)
    # A brand-new image from raw pixels: nothing but pixels is carried over.
    clean = Image.frombytes(mode, image.size, image.tobytes())
    buffer = io.BytesIO()
    if pil_features.check("webp"):
        clean.save(buffer, format="WEBP", quality=WEBP_QUALITY, method=4)
        content_type, expected = "image/webp", "WEBP"
    elif mode == "RGBA":  # pragma: no cover - Pillow builds without libwebp
        clean.save(buffer, format="PNG", optimize=True)
        content_type, expected = "image/png", "PNG"
    else:  # pragma: no cover
        clean.save(buffer, format="JPEG", quality=85, optimize=True)
        content_type, expected = "image/jpeg", "JPEG"
    data = buffer.getvalue()
    with Image.open(io.BytesIO(data)) as check:
        check.verify()
    with Image.open(io.BytesIO(data)) as check:
        if check.format != expected:
            raise ImageRejected("This image could not be processed.")
        check.load()
        width, height = check.size
        if check.getexif() or check.info.get("exif") or check.info.get("icc_profile") or check.info.get("xmp"):
            raise ImageRejected("This image could not be cleaned.")  # pragma: no cover - defensive
    return data, width, height, content_type


def process_upload(upload, *, kind: str, ctx: pii.ScanContext) -> ProcessedImage:
    """Validate, scan, check and re-encode one uploaded image (see module docstring)."""
    if kind not in TARGETS:
        raise ValidationFailed(details={"kind": ["Choose avatar, banner or gallery."]})
    size = int(getattr(upload, "size", 0) or 0)
    limit = max_upload_bytes()
    if size <= 0:
        raise ImageRejected("This file is empty.", code="image_empty")
    if size > limit:
        raise ImageRejected(
            f"Images can be up to {limit // (1024 * 1024)} MB. This one is {size / (1024 * 1024):.1f} MB.",
            code="image_too_large",
        )
    temp_path = os.path.join(incoming_dir(), f"{uuid.uuid4().hex}.upload")
    written = 0
    head = b""
    try:
        with open(temp_path, "wb") as handle:
            for chunk in upload.chunks():
                if not head:
                    head = bytes(chunk[:16])
                written += len(chunk)
                if written > limit:
                    raise ImageRejected("This image is too large.", code="image_too_large")
                handle.write(chunk)
        if os.name != "nt":
            os.chmod(temp_path, 0o600)
        sniffed = sniff_format(head)
        if sniffed is None:
            raise ImageRejected("Use a JPEG, PNG or WebP image.", code="image_type")
        verdict = _scan(temp_path)
        try:
            with Image.open(temp_path) as image:
                if image.format != sniffed:
                    raise ImageRejected("The file type doesn't match its contents.", code="image_type")
                width, height = image.size
                if width * height > MAX_PIXELS or max(width, height) > MAX_SIDE:
                    raise ImageRejected("This image has too many pixels. Resize it below 40 megapixels.", code="image_too_large")
                if min(width, height) < MIN_SIDE:
                    raise ImageRejected(f"Use an image at least {MIN_SIDE} pixels on each side.", code="image_too_small")
                texts, present = metadata_texts(image)
                findings = pii.scan_fields(texts, ctx)
                if findings:
                    raise ImageMetadataPii(
                        "This image's hidden details (metadata) contain "
                        + ", ".join(dict.fromkeys(finding.label for finding in findings))
                        + ". Export the photo again without metadata (or take a screenshot of it) and upload that.",
                        details={"findings": [finding.as_dict() for finding in findings]},
                    )
                image.seek(0)
                image.load()
                data, out_width, out_height, content_type = _reencode(image, kind)
        except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError) as exc:
            logger.info("profiles.image_undecodable kind=%s error=%s", kind, type(exc).__name__)
            raise ImageRejected("This image is damaged or not really an image.", code="image_invalid") from None
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass
    return ProcessedImage(
        data=data,
        width=out_width,
        height=out_height,
        content_type=content_type,
        sha256=hashlib.sha256(data).hexdigest(),
        original_format=sniffed,
        stripped=present,
        scanner=verdict.scanner,
        scanner_version=verdict.signature_version,
    )
