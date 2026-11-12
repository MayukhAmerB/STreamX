"""Private file storage for weekly report files.

Report files never live under MEDIA_ROOT: the nginx media container serves
every path below it publicly. They are written below
``settings.REPORTS_PRIVATE_ROOT`` (on the VPS the host directory
``/srv/streamx/reports``, a ``noexec,nosuid,nodev`` mount bound only into the
backend and worker containers) and leave only through the authenticated
download views in ``views.py``. ``url()`` deliberately fails so no template,
serializer or admin widget can ever link to a file directly.

On disk a file is ``<area>/<YYYY>/<MM>/<32 hex>.bin``: a random name with no
trace of the original name or extension (those live only in the database),
mode 0640 in 0750 directories. Uploads land in ``.incoming/`` (mode 0700) and
are moved into place with an atomic rename only after the virus scan passed
(``intake.py``). See SECURITY.md.
"""

from __future__ import annotations

import os
import shutil
import uuid

from django.conf import settings
from django.core.files.storage import FileSystemStorage
from django.utils import timezone
from django.utils.deconstruct import deconstructible

FILE_MODE = 0o640
DIRECTORY_MODE = 0o750
INCOMING_DIRNAME = ".incoming"
STORED_SUFFIX = ".bin"


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
        return FILE_MODE

    @property
    def directory_permissions_mode(self):
        return DIRECTORY_MODE

    def url(self, name):
        raise ValueError("Report files are private; serve them through the authenticated download view.")


_private_storage = PrivateReportStorage()


def private_report_storage():
    """Callable used by FileField(storage=...) so migrations reference it by name."""
    return _private_storage


def _random_name(prefix):
    today = timezone.now()
    return f"{prefix}/{today:%Y}/{today:%m}/{uuid.uuid4().hex}{STORED_SUFFIX}"


def area_prefix(kind, task_id=None):
    if kind == "submission":
        return f"reports/submissions/{int(task_id)}"
    if kind == "attachment":
        return f"reports/attachments/{int(task_id)}"
    if kind == "feedback":
        return "reports/feedback"
    raise ValueError(f"Unknown report file kind: {kind!r}")


def new_stored_name(kind, task_id=None):
    return _random_name(area_prefix(kind, task_id))


# ``upload_to`` callables (referenced by migration 0001). Files are no longer
# saved through FieldFile.save(), but any code path that does still gets a
# random, extension-less name.
def submission_file_upload_to(instance, filename):
    return new_stored_name("submission", instance.task_id)


def attachment_upload_to(instance, filename):
    return new_stored_name("attachment", instance.task_id)


def feedback_file_upload_to(instance, filename):
    return new_stored_name("feedback")


def ensure_private_dir(path):
    """Create ``path`` (and parents) with mode 0750, never widening it."""
    os.makedirs(path, mode=DIRECTORY_MODE, exist_ok=True)
    return path


def incoming_dir():
    """Where uploads wait for their virus scan (same filesystem: atomic rename)."""
    path = os.path.join(_private_storage.location, INCOMING_DIRNAME)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def quarantine_root():
    root = str(getattr(settings, "REPORTS_QUARANTINE_ROOT", "") or os.path.join(settings.BASE_DIR, "private_quarantine"))
    root = os.path.abspath(root)
    os.makedirs(root, mode=0o700, exist_ok=True)
    return root


def free_bytes():
    """Free space on the private volume (creating the root on first use)."""
    root = _private_storage.location
    ensure_private_dir(root)
    return shutil.disk_usage(root).free


def mount_flags(path):
    """{"noexec", "nosuid", "nodev"} -> bool for the filesystem holding ``path``
    (None where the platform cannot tell, e.g. Windows development)."""
    try:
        flags = os.statvfs(path).f_flag
    except (AttributeError, OSError):
        return None
    return {
        "noexec": bool(flags & getattr(os, "ST_NOEXEC", 8)),
        "nosuid": bool(flags & getattr(os, "ST_NOSUID", 2)),
        "nodev": bool(flags & getattr(os, "ST_NODEV", 4)),
    }
