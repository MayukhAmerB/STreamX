"""Private storage for profile images.

Images never live under MEDIA_ROOT (nginx serves that publicly). They are
written below ``settings.PROFILES_PRIVATE_ROOT`` (default
``<REPORTS_PRIVATE_ROOT>/profiles``: the same ``noexec`` private volume as
report files) with random names, and leave only through
``GET /api/profiles/media/<id>/``, which checks that the viewer may see the
profile. ``url()`` fails on purpose so nothing can link to a file directly.
"""

from __future__ import annotations

import os
import uuid

from django.conf import settings
from django.core.files.storage import FileSystemStorage
from django.utils import timezone
from django.utils.deconstruct import deconstructible

FILE_MODE = 0o640
DIRECTORY_MODE = 0o750


def private_root() -> str:
    configured = str(getattr(settings, "PROFILES_PRIVATE_ROOT", "") or "").strip()
    if configured:
        return os.path.abspath(configured)
    base = str(getattr(settings, "REPORTS_PRIVATE_ROOT", "") or os.path.join(settings.BASE_DIR, "private_media"))
    return os.path.abspath(os.path.join(base, "profiles"))


@deconstructible(path="apps.profiles.storage.PrivateProfileStorage")
class PrivateProfileStorage(FileSystemStorage):
    def __init__(self):
        super().__init__()

    @property
    def base_location(self):
        return private_root()

    @property
    def location(self):
        return private_root()

    @property
    def base_url(self):
        return None

    @property
    def file_permissions_mode(self):
        return FILE_MODE

    @property
    def directory_permissions_mode(self):
        return DIRECTORY_MODE

    def url(self, name):
        raise ValueError("Profile images are private; serve them through /api/profiles/media/<id>/.")


_storage = PrivateProfileStorage()


def private_profile_storage():
    """Callable for ``FileField(storage=...)`` so migrations reference it by name."""
    return _storage


def new_stored_name() -> str:
    today = timezone.now()
    return f"images/{today:%Y}/{today:%m}/{uuid.uuid4().hex}.bin"


def profile_image_upload_to(instance, filename):
    return new_stored_name()


def incoming_dir() -> str:
    """Where uploads wait for the virus scan (mode 0700)."""
    path = os.path.join(private_root(), ".incoming")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path
