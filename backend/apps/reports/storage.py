"""Private file storage for weekly report files.

Report files never live under MEDIA_ROOT: the nginx media container serves
every path below it publicly. They are written below
``settings.REPORTS_PRIVATE_ROOT`` (its own Docker volume, mounted only into
the backend containers) under random names, and leave only through the
authenticated download views in ``views.py``. ``url()`` deliberately fails so
no template, serializer or admin widget can ever link to a file directly.
"""

from __future__ import annotations

import os
import uuid

from django.conf import settings
from django.core.files.storage import FileSystemStorage
from django.utils import timezone
from django.utils.deconstruct import deconstructible


@deconstructible(path="apps.reports.storage.PrivateReportStorage")
class PrivateReportStorage(FileSystemStorage):
    """FileSystemStorage rooted at REPORTS_PRIVATE_ROOT, read on every access
    (so ``override_settings`` in tests and env changes need no restart)."""

    def __init__(self):
        super().__init__()

    @property
    def base_location(self):
        return str(getattr(settings, "REPORTS_PRIVATE_ROOT", "") or os.path.join(settings.BASE_DIR, "private_media"))

    @property
    def location(self):
        return os.path.abspath(self.base_location)

    @property
    def base_url(self):
        return None

    @property
    def file_permissions_mode(self):
        return 0o640

    @property
    def directory_permissions_mode(self):
        return 0o750

    def url(self, name):
        raise ValueError("Report files are private; serve them through the authenticated download view.")


_private_storage = PrivateReportStorage()


def private_report_storage():
    """Callable used by FileField(storage=...) so migrations reference it by name."""
    return _private_storage


def _random_name(prefix, extension):
    today = timezone.now()
    safe_ext = "".join(char for char in str(extension or "").lower() if char.isalnum())[:12]
    suffix = f".{safe_ext}" if safe_ext else ""
    return f"{prefix}/{today:%Y}/{today:%m}/{uuid.uuid4().hex}{suffix}"


def submission_file_upload_to(instance, filename):
    return _random_name(f"reports/submissions/{instance.task_id}", getattr(instance, "extension", ""))


def attachment_upload_to(instance, filename):
    return _random_name(f"reports/attachments/{instance.task_id}", getattr(instance, "extension", ""))


def feedback_file_upload_to(instance, filename):
    return _random_name("reports/feedback", getattr(instance, "annotated_extension", ""))


def free_bytes():
    """Free space on the private volume (creating the root on first use)."""
    import shutil

    root = _private_storage.location
    os.makedirs(root, exist_ok=True)
    return shutil.disk_usage(root).free
