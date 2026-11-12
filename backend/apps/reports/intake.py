"""Upload intake: validate -> stage -> virus scan -> move into storage.

The one way a report file (student submission file, task reference file,
grader's annotated feedback file) gets onto disk::

    1. Django streams the request body to a temporary upload file
       (TemporaryFileUploadHandler; tiny files stay in memory).
    2. ``validate_report_upload``: type, size and structure checks.
    3. The bytes are copied (and hashed) into ``<private root>/.incoming/``,
       a 0600 file with a random name, on the noexec private filesystem.
    4. clamd INSTREAM scan of exactly that staged file. Clean or nothing:
       infected -> deleted, security event, quarantine record, HTTP 400;
       scanner trouble -> deleted, HTTP 503 (fail closed).
    5. Only a clean file is renamed (atomically, same filesystem) to its final
       random ``.bin`` name, mode 0640.
    6. The caller creates the database row with the scan record; a file only
       becomes usable through that row.

Nothing here (or anywhere) opens, converts, renders or unpacks a report
file on the server; the validators only read bytes.
"""

from __future__ import annotations

import hashlib
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime

from config.audit import log_security_event
from config.upload_validators import validate_report_upload
from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils import timezone

from apps.core.errors import DomainError, ValidationFailed

from . import antivirus
from .models import SCAN_CLEAN, ReportQuarantineRecord
from .storage import (
    FILE_MODE,
    ensure_private_dir,
    free_bytes,
    incoming_dir,
    new_stored_name,
    private_report_storage,
)

logger = logging.getLogger("apps.reports.intake")

COPY_CHUNK_BYTES = 1024 * 1024
INCOMING_MAX_AGE_SECONDS = 24 * 3600


class StorageFull(DomainError):
    status = 507
    code = "storage_full"
    default_message = "The server is low on storage, so uploads are paused. Try again later."


@dataclass
class StoredUpload:
    """A clean file already moved into private storage, not yet in the database."""

    name: str
    original_name: str
    extension: str
    content_type: str
    size: int
    sha256: str
    scanner: str
    signature_version: str
    scanned_at: datetime
    scan_status: str = SCAN_CLEAN

    def file_fields(self) -> dict:
        """Kwargs for ReportFile / ReportAttachment."""
        return {
            "file": self.name,
            "original_name": self.original_name,
            "extension": self.extension,
            "content_type": self.content_type,
            "size": self.size,
            "sha256": self.sha256,
            "scan_status": self.scan_status,
            "scanned_at": self.scanned_at,
            "scanner": self.scanner,
            "scan_signature_version": self.signature_version,
            "scan_threat": "",
        }

    def discard(self) -> None:
        """Remove the stored file (the database row was never created)."""
        delete_stored_name(self.name)


def delete_stored_name(name) -> None:
    if not name:
        return
    try:
        private_report_storage().delete(name)
    except OSError:
        logger.warning("reports: could not delete stored file %s", name)


def clean_original_name(name):
    base = str(name or "").replace("\\", "/").split("/")[-1].strip()
    base = "".join(char for char in base if ord(char) >= 32 and char not in '<>:"|?*')
    return (base or "file")[:255]


def ensure_disk_space(incoming_bytes):
    reserve = int(getattr(settings, "REPORTS_MIN_FREE_BYTES", 1024 * 1024 * 1024))
    try:
        available = free_bytes()
    except OSError:
        logger.exception("reports: private storage is not reachable")
        raise StorageFull("Uploads are unavailable right now. Try again later.") from None
    if available < reserve + 2 * int(incoming_bytes or 0):
        logger.error("reports: refusing upload, only %s bytes free on private storage", available)
        raise StorageFull()


def _validate(uploaded, *, allowed_extensions, max_bytes, field_name):
    try:
        return validate_report_upload(
            uploaded,
            field_name=field_name,
            allowed_extensions=allowed_extensions,
            max_bytes=max_bytes,
            zip_limits={
                "max_entries": getattr(settings, "REPORTS_ZIP_MAX_ENTRIES", 2000),
                "max_uncompressed_bytes": getattr(settings, "REPORTS_ZIP_MAX_UNCOMPRESSED_BYTES", 500 * 1024 * 1024),
                "max_ratio": getattr(settings, "REPORTS_ZIP_MAX_RATIO", 100),
            },
        )
    except DjangoValidationError as exc:
        messages = exc.message_dict.get(field_name) if hasattr(exc, "message_dict") else exc.messages
        message = (messages or ["This file can't be accepted."])[0]
        raise ValidationFailed(message, details={field_name: [message]}) from None


def _stage(uploaded, *, max_bytes, field_name):
    """Copy the upload into .incoming/ (0600, O_EXCL); returns (path, size, sha256)."""
    path = os.path.join(incoming_dir(), f"{uuid.uuid4().hex}.part")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    digest = hashlib.sha256()
    size = 0
    try:
        descriptor = os.open(path, flags, 0o600)
        with os.fdopen(descriptor, "wb") as target:
            if hasattr(uploaded, "seek"):
                uploaded.seek(0)
            for chunk in uploaded.chunks(COPY_CHUNK_BYTES):
                size += len(chunk)
                if size > max_bytes:
                    message = "This file is larger than the allowed size."
                    raise ValidationFailed(message, details={field_name: [message]})
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
    except BaseException:
        _unlink_quietly(path)
        raise
    finally:
        if hasattr(uploaded, "seek"):
            try:
                uploaded.seek(0)
            except (OSError, ValueError):
                pass
    if size == 0:
        _unlink_quietly(path)
        message = "This file is empty."
        raise ValidationFailed(message, details={field_name: [message]})
    return path, size, digest.hexdigest()


def _unlink_quietly(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning("reports: could not remove staged upload %s", path)


def _move_into_storage(staged_path, name):
    storage = private_report_storage()
    final_path = storage.path(name)
    ensure_private_dir(os.path.dirname(final_path))
    os.chmod(staged_path, FILE_MODE)
    if os.path.exists(final_path):  # 128 random bits: never happens, but never overwrite
        raise FileExistsError(final_path)
    os.replace(staged_path, final_path)


def record_blocked_upload(*, kind, verdict, user, task, original_name, size, sha256, field_name):
    """Security event + admin-visible quarantine record (no file content)."""
    log_security_event(
        "reports.upload_blocked_by_antivirus",
        user_id=getattr(user, "pk", None),
        user_email=getattr(user, "email", None),
        task_id=getattr(task, "pk", None),
        kind=kind,
        field=field_name,
        filename=original_name,
        size=size,
        sha256=sha256,
        signature=verdict.signature,
        scanner=verdict.scanner,
        signature_version=verdict.signature_version,
    )
    try:
        ReportQuarantineRecord.objects.create(
            source=ReportQuarantineRecord.SOURCE_UPLOAD,
            kind=kind,
            action=ReportQuarantineRecord.ACTION_REJECTED,
            user=user if getattr(user, "pk", None) else None,
            task=task if getattr(task, "pk", None) else None,
            original_name=original_name,
            size=size,
            sha256=sha256,
            signature=verdict.signature,
            scanner=verdict.scanner,
            signature_version=verdict.signature_version,
        )
    except Exception:  # noqa: BLE001 - the upload is refused either way
        logger.exception("reports: could not write the quarantine record")


def ingest_upload(
    uploaded,
    *,
    kind,
    task=None,
    user=None,
    allowed_extensions=None,
    max_bytes,
    field_name="file",
) -> StoredUpload:
    """Run the whole intake pipeline; returns a clean, stored file."""
    if uploaded is None:
        raise ValidationFailed("Choose a file to upload.", details={field_name: ["Choose a file to upload."]})
    info = _validate(uploaded, allowed_extensions=allowed_extensions, max_bytes=max_bytes, field_name=field_name)
    ensure_disk_space(getattr(uploaded, "size", 0))
    original_name = clean_original_name(getattr(uploaded, "name", ""))

    staged_path, size, sha256 = _stage(uploaded, max_bytes=max_bytes, field_name=field_name)
    try:
        try:
            verdict = antivirus.scan_path(staged_path, size=size)
        except antivirus.ScanRefused:
            message = "This file is too large or too complex for the virus scanner to check. Upload a smaller file."
            raise ValidationFailed(
                message, code="file_too_large_to_scan", details={field_name: [message]}
            ) from None
        if not verdict.clean:
            record_blocked_upload(
                kind=kind,
                verdict=verdict,
                user=user,
                task=task,
                original_name=original_name,
                size=size,
                sha256=sha256,
                field_name=field_name,
            )
            raise ValidationFailed(
                antivirus.FILE_BLOCKED_MESSAGE,
                code="file_infected",
                details={field_name: [antivirus.FILE_BLOCKED_MESSAGE]},
            )
        name = new_stored_name(kind, getattr(task, "pk", None))
        _move_into_storage(staged_path, name)
    finally:
        _unlink_quietly(staged_path)  # no-op once renamed into place

    return StoredUpload(
        name=name,
        original_name=original_name,
        extension=info["extension"],
        content_type=info["content_type"],
        size=size,
        sha256=sha256,
        scanner=verdict.scanner,
        signature_version=verdict.signature_version,
        scanned_at=timezone.now(),
    )


def prune_incoming(*, max_age_seconds=INCOMING_MAX_AGE_SECONDS, now=None):
    """Delete staged uploads a crashed request left behind."""
    import time

    try:
        directory = incoming_dir()
    except OSError:
        return 0
    cutoff = (now or time.time()) - max_age_seconds
    removed = 0
    for entry in os.scandir(directory):
        try:
            if entry.is_file(follow_symlinks=False) and entry.stat(follow_symlinks=False).st_mtime < cutoff:
                os.unlink(entry.path)
                removed += 1
        except OSError:
            continue
    return removed
