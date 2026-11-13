"""Authorised delivery of lecture resource files (paid course downloads).

Resource files live under ``MEDIA_ROOT/lecture_resources/``, which the public
``/media/`` origin no longer serves (infra/hostinger/nginx/media.conf is an
allowlist). Callers check access first; this module only builds the response:

* In production nginx serves the bytes: Django answers with
  ``X-Accel-Redirect`` to the ``internal`` ``/_protected_media/`` location, so
  no web thread streams a file.
* Paths nginx might mangle (anything outside ``SAFE_ACCEL_PATH``), and setups
  without accel-redirect (local development), are streamed by Django.
"""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from urllib.parse import quote

from django.conf import settings
from django.http import FileResponse, HttpResponse, HttpResponseNotFound

RESOURCE_PREFIX = "lecture_resources/"
SAFE_ACCEL_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")


def _use_accel_redirect():
    return bool(getattr(settings, "COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT", not settings.DEBUG))


def _content_disposition(name):
    fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "resource"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name)}"


def _local_relative_name(resource_file):
    """The storage name when the file is a plain file inside MEDIA_ROOT."""
    name = str(getattr(resource_file, "name", "") or "").replace("\\", "/").strip().lstrip("/")
    if not name or ".." in name.split("/"):
        return None
    media_root = Path(settings.MEDIA_ROOT).resolve()
    try:
        path = (media_root / name).resolve()
        path.relative_to(media_root)
    except (ValueError, OSError):
        return None
    if path.is_symlink() or not path.is_file():
        return None
    return name


def resource_file_response(resource_file):
    """Download response for a LectureResource file the caller already authorised."""
    file_name = str(getattr(resource_file, "name", "") or "").strip()
    if not resource_file or not file_name:
        return HttpResponseNotFound("Lecture resource not found.")
    display_name = Path(file_name).name
    content_type, _ = mimetypes.guess_type(file_name)
    content_type = content_type or "application/octet-stream"

    relative = _local_relative_name(resource_file)
    if relative and not relative.startswith(RESOURCE_PREFIX):
        # Only lecture resources are ever handed out here: a storage name that
        # points elsewhere in MEDIA_ROOT (an admin typo or a crafted value) is
        # never served, by nginx or by Django.
        return HttpResponseNotFound("Lecture resource not found.")
    if relative and _use_accel_redirect() and SAFE_ACCEL_PATH.match(relative):
        response = HttpResponse(content_type=content_type)
        response["X-Accel-Redirect"] = f"/_protected_media/{relative}"
    else:
        try:
            file_handle = resource_file.storage.open(file_name, "rb")
        except Exception:  # noqa: BLE001 - missing or unreadable file
            return HttpResponseNotFound("Lecture resource not found.")
        response = FileResponse(file_handle, content_type=content_type)
        try:
            file_size = resource_file.size
        except Exception:  # noqa: BLE001
            file_size = None
        if file_size:
            response["Content-Length"] = str(file_size)
    response["Content-Disposition"] = _content_disposition(display_name)
    response["Cache-Control"] = "private, max-age=300"
    response["X-Content-Type-Options"] = "nosniff"
    return response
