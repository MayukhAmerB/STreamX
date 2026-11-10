"""Staff-only file responses for recording videos (admin player and downloads).

Files under MEDIA_ROOT are handed to nginx with ``X-Accel-Redirect`` to the
``internal`` ``/_protected_media/`` location -- the same mechanism the course
player uses -- so nginx serves byte ranges and Django only checks access.
Everything else (the read-only ``/recordings`` volume, the recorder work dir)
or any setup without accel-redirect is streamed by Django with HTTP Range
support. Open-ended ranges (``bytes=N-``, what video elements ask for) are
answered in chunks of at most ``MAX_OPEN_RANGE_BYTES`` so a long recording
never ties a worker up for the whole download; browsers simply ask for the
next range.

Nothing here is public: callers are admin views wrapped in
``admin_site.admin_view`` (active staff only) that also check the model
permission, and every file must pass ``services.is_managed_path``.
"""

import mimetypes
import re
from pathlib import Path
from urllib.parse import quote

from django.conf import settings
from django.http import FileResponse, Http404, HttpResponse, StreamingHttpResponse

from .services import is_managed_path

MAX_OPEN_RANGE_BYTES = 8 * 1024 * 1024
READ_CHUNK_BYTES = 256 * 1024
RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")
SAFE_ACCEL_PATH = re.compile(r"^[A-Za-z0-9._/-]+$")
CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".flv": "video/x-flv",
    ".ts": "video/mp2t",
}


def content_type_for(path):
    suffix = Path(path).suffix.lower()
    return CONTENT_TYPES.get(suffix) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def _media_relative(path):
    try:
        return Path(path).resolve().relative_to(Path(settings.MEDIA_ROOT).resolve()).as_posix()
    except (ValueError, OSError):
        return None


def _use_accel_redirect():
    return bool(getattr(settings, "COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT", not settings.DEBUG))


def _content_disposition(path, download):
    name = Path(path).name
    fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "recording"
    kind = "attachment" if download else "inline"
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(name)}"


def _iter_file(path, start, length):
    with open(path, "rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            chunk = handle.read(min(READ_CHUNK_BYTES, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def parse_range(header, size):
    """``(start, end)`` for one satisfiable ``bytes=`` range, ``"invalid"`` for an
    unsatisfiable one, or None to answer with the whole file (no/odd header)."""
    match = RANGE_PATTERN.match((header or "").strip())
    if not match:
        return None
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        return None
    if start_text:
        start = int(start_text)
        end = int(end_text) if end_text else size - 1
        if start >= size or start > end:
            return "invalid"
        if not end_text:
            end = min(end, start + MAX_OPEN_RANGE_BYTES - 1)
    else:
        suffix = int(end_text)
        if suffix == 0 or size == 0:
            return "invalid"
        start = max(0, size - suffix)
        end = size - 1
    return start, min(end, size - 1)


def ranged_file_response(request, path, *, download=False):
    path = Path(path)
    size = path.stat().st_size
    content_type = content_type_for(path)
    byte_range = parse_range(request.META.get("HTTP_RANGE", ""), size)
    if byte_range == "invalid":
        response = HttpResponse(status=416)
        response["Content-Range"] = f"bytes */{size}"
    elif byte_range is not None:
        start, end = byte_range
        length = end - start + 1
        response = StreamingHttpResponse(_iter_file(path, start, length), status=206, content_type=content_type)
        response["Content-Range"] = f"bytes {start}-{end}/{size}"
        response["Content-Length"] = str(length)
    else:
        response = FileResponse(path.open("rb"), content_type=content_type)
        response["Content-Length"] = str(size)
    response["Accept-Ranges"] = "bytes"
    return response


def staff_file_response(request, path, *, download=False):
    """A response for ``path`` (already authorised by the caller)."""
    if path is None:
        raise Http404("No file.")
    path = Path(path)
    if path.is_symlink() or not path.is_file() or not is_managed_path(path):
        raise Http404("Recording file not found.")
    relative = _media_relative(path)
    if relative and _use_accel_redirect() and SAFE_ACCEL_PATH.match(relative):
        response = HttpResponse(content_type=content_type_for(path))
        response["X-Accel-Redirect"] = f"/_protected_media/{relative}"
    else:
        response = ranged_file_response(request, path, download=download)
    response["Content-Disposition"] = _content_disposition(path, download)
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response
