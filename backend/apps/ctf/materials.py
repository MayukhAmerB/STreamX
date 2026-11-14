"""Exam evidence files: Console upload, signed URLs and delivery.

Before Phase 3 evidence was baked into the labs image and served publicly.
Now staff upload it from Console -> Exams (``save_upload``) and it lives in
``MEDIA_ROOT/ctf_materials/`` (not in nginx's public /media/ allowlist).

A student who has STARTED the exam gets, in the question payload, a
short-lived signed URL per file (``signed_url``):
``/api/ctf/materials/<token>/``. The token binds the material and the
student and expires after ``CTF_MATERIAL_URL_TTL_SECONDS``; the view re-checks
that the participation still exists. The labs page loads images straight from
that URL (an ``<img>`` cannot carry the Authorization or CSRF headers), so
the token *is* the credential. Production hands the bytes to nginx with
``X-Accel-Redirect`` (no web thread streams files), like lecture resources.

Questions whose files were not uploaded keep their labs path, so exams
whose evidence is still in the labs image keep working unchanged.
"""

from __future__ import annotations

import hashlib
import mimetypes
import re
from datetime import timedelta
from pathlib import PurePosixPath

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.http import FileResponse, HttpResponse, HttpResponseNotFound
from django.urls import reverse
from django.utils import timezone

from apps.core.errors import ValidationFailed

from .loader import MATERIAL_EXTENSIONS
from .models import CtfMaterial, CtfParticipation

TOKEN_SALT = "apps.ctf.material-url"
SAFE_ACCEL_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif"}
CONTENT_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
    "gif": "image/gif",
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
    "csv": "text/csv; charset=utf-8",
    "json": "application/json",
    "md": "text/plain; charset=utf-8",
    "zip": "application/zip",
}
# First bytes of the binary formats: an "image" that is really HTML (or a
# script) is refused at upload, so it can never render on any origin.
MAGIC = {
    "jpg": (b"\xff\xd8\xff",),
    "jpeg": (b"\xff\xd8\xff",),
    "png": (b"\x89PNG\r\n\x1a\n",),
    "gif": (b"GIF87a", b"GIF89a"),
    "webp": (b"RIFF",),
    "pdf": (b"%PDF-",),
    "zip": (b"PK\x03\x04", b"PK\x05\x06"),
}


def extension_of(name):
    suffix = PurePosixPath(str(name or "")).suffix.lower().lstrip(".")
    return suffix if suffix in MATERIAL_EXTENSIONS else ""


def max_upload_bytes():
    return int(getattr(settings, "CTF_MATERIAL_MAX_UPLOAD_MB", 25)) * 1024 * 1024


def url_ttl_seconds():
    return int(getattr(settings, "CTF_MATERIAL_URL_TTL_SECONDS", 7200))


# ---------------------------------------------------------------------------
# Signed URLs
# ---------------------------------------------------------------------------
def issue_token(material, user):
    return signing.dumps({"m": material.pk, "u": user.pk}, salt=TOKEN_SALT, compress=False)


def read_token(token):
    """Return ``(material_id, user_id)`` or ``None`` (bad or expired token)."""
    try:
        payload = signing.loads(str(token or ""), salt=TOKEN_SALT, max_age=url_ttl_seconds())
    except signing.BadSignature:  # includes SignatureExpired
        return None
    try:
        return int(payload["m"]), int(payload["u"])
    except (KeyError, TypeError, ValueError):
        return None


def signed_url(request, material, user):
    path = reverse("ctf-material-file", kwargs={"token": issue_token(material, user)})
    return request.build_absolute_uri(path) if request is not None else path


def url_expiry(at=None):
    return (at or timezone.now()) + timedelta(seconds=url_ttl_seconds())


def uploaded_by_path(exam):
    return {item.path: item for item in CtfMaterial.objects.filter(exam=exam)}


def may_open(user_id, material):
    """The student still has a participation in the material's exam (staff always may)."""
    from django.contrib.auth import get_user_model

    user = get_user_model().objects.filter(pk=user_id, is_active=True).first()
    if user is None:
        return False
    if user.is_staff or user.is_superuser:
        return True
    return CtfParticipation.objects.filter(exam_id=material.exam_id, user_id=user_id).exists()


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------
def _use_accel_redirect():
    return bool(getattr(settings, "COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT", not settings.DEBUG))


def _disposition(material, inline):
    name = PurePosixPath(material.path).name or "evidence"
    fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "evidence"
    return f"{'inline' if inline else 'attachment'}; filename=\"{fallback}\""


def material_response(material):
    extension = extension_of(material.path) or extension_of(material.file.name)
    content_type = CONTENT_TYPES.get(extension) or mimetypes.guess_type(material.file.name)[0]
    content_type = content_type or "application/octet-stream"
    name = str(material.file.name or "").replace("\\", "/").lstrip("/")
    if not name or ".." in name.split("/") or not name.startswith("ctf_materials/"):
        return HttpResponseNotFound("Not found.")
    if _use_accel_redirect() and SAFE_ACCEL_PATH.match(name):
        response = HttpResponse(content_type=content_type)
        response["X-Accel-Redirect"] = f"/_protected_media/{name}"
    else:
        try:
            handle = material.file.storage.open(name, "rb")
        except Exception:  # noqa: BLE001 - missing or unreadable file
            return HttpResponseNotFound("Not found.")
        response = FileResponse(handle, content_type=content_type)
        if material.size:
            response["Content-Length"] = str(material.size)
    response["Content-Disposition"] = _disposition(material, extension in IMAGE_EXTENSIONS)
    response["Cache-Control"] = "private, max-age=300"
    response["X-Content-Type-Options"] = "nosniff"
    # The labs page (a sibling subdomain) shows these images.
    response["Cross-Origin-Resource-Policy"] = "same-site"
    response["Content-Security-Policy"] = "default-src 'none'; sandbox"
    return response


# ---------------------------------------------------------------------------
# Upload (Console, staff only)
# ---------------------------------------------------------------------------
def _sniff_ok(extension, head):
    signatures = MAGIC.get(extension)
    if signatures is None:
        # Text formats: must decode as UTF-8 and carry no NUL bytes.
        if b"\x00" in head:
            return False
        try:
            head.decode("utf-8")
        except UnicodeDecodeError as exc:
            # A multi-byte character cut at the sniff boundary is fine.
            return exc.start >= len(head) - 3
        return True
    if extension == "webp":
        return head.startswith(b"RIFF") and head[8:12] == b"WEBP"
    return any(head.startswith(signature) for signature in signatures)


def save_upload(*, exam, path, uploaded_file, user):
    """Store (or replace) the file for one referenced material path."""
    from .readiness import referenced_material_paths

    path = str(path or "").strip()
    if path not in referenced_material_paths(exam):
        raise ValidationFailed(
            "No question in this exam uses that evidence path.", code="ctf_material_unknown_path"
        )
    expected = extension_of(path)
    actual = extension_of(getattr(uploaded_file, "name", ""))
    if not expected or actual != expected:
        raise ValidationFailed(
            f"Upload a .{expected or 'supported'} file for this evidence path.", code="ctf_material_wrong_type"
        )
    size = int(getattr(uploaded_file, "size", 0) or 0)
    if size <= 0:
        raise ValidationFailed("The file is empty.", code="ctf_material_empty")
    if size > max_upload_bytes():
        raise ValidationFailed(
            f"Evidence files can be at most {max_upload_bytes() // (1024 * 1024)} MB.", code="ctf_material_too_large"
        )
    uploaded_file.seek(0)
    head = uploaded_file.read(64)
    if not _sniff_ok(expected, head):
        raise ValidationFailed("The file's content does not match its type.", code="ctf_material_bad_content")
    digest = hashlib.sha256()
    uploaded_file.seek(0)
    for chunk in uploaded_file.chunks():
        digest.update(chunk)
    uploaded_file.seek(0)

    with transaction.atomic():
        material = CtfMaterial.objects.select_for_update().filter(exam=exam, path=path).first()
        old_name = material.file.name if material is not None and material.file else ""
        if material is None:
            material = CtfMaterial(exam=exam, path=path)
        material.original_name = str(getattr(uploaded_file, "name", "") or "")[:255]
        material.content_type = CONTENT_TYPES.get(expected, "application/octet-stream")[:120]
        material.size = size
        material.sha256 = digest.hexdigest()
        material.uploaded_by = user
        material.file.save(PurePosixPath(path).name, uploaded_file, save=False)
        material.save()
        if old_name and old_name != material.file.name:
            storage = material.file.storage
            transaction.on_commit(lambda: storage.delete(old_name))
    return material


def delete_material(material):
    name = material.file.name if material.file else ""
    storage = material.file.storage if material.file else None
    material.delete()
    if name and storage is not None:
        transaction.on_commit(lambda: storage.delete(name))
