"""Asynchronous virus scanning for self-service report uploads (B11).

The legacy upload (``intake.ingest_upload``) scans inside the web request, so
a slow ClamAV pins a web thread for up to ``CLAMD_TIMEOUT_SECONDS``. Weekly
self-service uploads instead go::

    1. validate (type, size, structure) and copy into ``.incoming/`` (0600),
       exactly like intake;
    2. move into ``<private root>/.pending/<random>.bin`` (0600) and create the
       ``ReportFile`` row with ``scan_status="unscanned"`` plus a
       ``reports.scan_upload`` outbox event, in one transaction;
    3. the worker (``process_async_jobs``) scans the pending file; clean ->
       renamed into its final random name (0640) and marked clean; infected
       -> bytes deleted, quarantine record + security event, row marked
       ``infected``; scanner down -> the outbox retries with backoff.

Still fail-closed: downloads refuse anything that is not ``clean``
(``views.require_clean_scan``), a submit is refused while any file is not
clean (``services.submit_locked``), so graders never see an unscanned file,
and the periodic re-scan skips ``.pending/`` files (this module owns them).
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from apps.core.concurrency import DistributedLock
from apps.core.outbox import outbox_handler, publish

from . import antivirus
from .intake import _move_into_storage, _stage, _unlink_quietly, _validate, clean_original_name, ensure_disk_space
from .intake import record_blocked_upload as _record_blocked
from .models import PENDING_PREFIX, SCAN_CLEAN, SCAN_INFECTED, SCAN_UNSCANNED, ReportFile
from .storage import ensure_private_dir, new_stored_name, private_report_storage

logger = logging.getLogger("apps.reports.scanning")

EVENT_SCAN_UPLOAD = "reports.scan_upload"
SCAN_MAX_ATTEMPTS = 20
REFUSED_MESSAGE = "Too large or too complex for the virus scanner to check. Upload a smaller file."


def _new_pending_name():
    return f"{PENDING_PREFIX}{uuid.uuid4().hex}.bin"


def stage_pending(uploaded, *, allowed_extensions, max_bytes, field_name="file"):
    """Validate and park an upload for the async scan. Returns the field dict
    for ``ReportFile`` (``scan_status="unscanned"``)."""
    from apps.core.errors import ValidationFailed

    if uploaded is None:
        raise ValidationFailed("Choose a file to upload.", details={field_name: ["Choose a file to upload."]})
    info = _validate(uploaded, allowed_extensions=allowed_extensions, max_bytes=max_bytes, field_name=field_name)
    ensure_disk_space(getattr(uploaded, "size", 0))
    original_name = clean_original_name(getattr(uploaded, "name", ""))
    staged_path, size, sha256 = _stage(uploaded, max_bytes=max_bytes, field_name=field_name)
    name = _new_pending_name()
    storage = private_report_storage()
    final_path = storage.path(name)
    try:
        ensure_private_dir(os.path.dirname(final_path))
        os.chmod(staged_path, 0o600)
        os.replace(staged_path, final_path)
    finally:
        _unlink_quietly(staged_path)
    return {
        "file": name,
        "original_name": original_name,
        "extension": info["extension"],
        "content_type": info["content_type"],
        "size": size,
        "sha256": sha256,
        "scan_status": SCAN_UNSCANNED,
        "scanned_at": None,
        "scanner": "",
        "scan_signature_version": "",
        "scan_threat": "",
    }


def queue_scan(report_file, *, attempt=0):
    """Publish the scan job (call inside the transaction that created the row)."""
    return publish(
        EVENT_SCAN_UPLOAD,
        {"file_id": report_file.pk},
        dedupe_key=f"report-scan:{report_file.pk}:{attempt}",
        max_attempts=SCAN_MAX_ATTEMPTS,
    )


def discard_pending_bytes(name):
    if not name:
        return
    try:
        private_report_storage().delete(name)
    except OSError:
        logger.warning("reports: could not delete pending upload %s", name)


SCAN_LOCK_TTL_SECONDS = 600


def scan_pending_file(file_id):
    """Scan one pending upload. Raises ``antivirus.ScannerUnavailable`` when
    the scanner is down (the outbox retries). Returns the new scan status, or
    None when there was nothing to do.

    One scan per file at a time: the original job (retrying while ClamAV was
    down) and a ``requeue_stuck_scans`` job can both be queued for the same
    file. Without the lock the second could find the pending bytes already
    moved by the first and delete the (clean) file's row.
    """
    lock = DistributedLock(f"reports-scan:{file_id}", ttl=SCAN_LOCK_TTL_SECONDS)
    if not lock.acquire(blocking=False):
        logger.info("reports: scan of file %s already running elsewhere; skipping", file_id)
        return None
    try:
        return _scan_pending_file_locked(file_id)
    finally:
        lock.release()


def _scan_pending_file_locked(file_id):
    item = ReportFile.objects.select_related("task", "owner").filter(pk=file_id).first()
    if item is None or not item.scan_pending:
        return None
    pending_name = item.file.name
    storage = private_report_storage()
    path = storage.path(pending_name)
    if not os.path.isfile(path):
        logger.warning("reports: pending upload %s is gone; dropping file %s", pending_name, file_id)
        ReportFile.objects.filter(pk=file_id, file=pending_name, submitted=False).delete()
        return None
    now = timezone.now()
    try:
        verdict = antivirus.scan_path(path, size=os.path.getsize(path))
    except antivirus.ScanRefused:
        ReportFile.objects.filter(pk=file_id, file=pending_name).update(
            file="", scan_status=SCAN_INFECTED, scanned_at=now, scan_threat=REFUSED_MESSAGE[:255]
        )
        discard_pending_bytes(pending_name)
        return SCAN_INFECTED
    if not verdict.clean:
        _record_blocked(
            kind="submission",
            verdict=verdict,
            user=item.owner,
            task=item.task,
            original_name=item.original_name,
            size=item.size,
            sha256=item.sha256,
            field_name="file",
        )
        ReportFile.objects.filter(pk=file_id, file=pending_name).update(
            file="",
            scan_status=SCAN_INFECTED,
            scanned_at=now,
            scanner=verdict.scanner,
            scan_signature_version=verdict.signature_version,
            scan_threat=verdict.signature,
        )
        discard_pending_bytes(pending_name)
        return SCAN_INFECTED

    final_name = new_stored_name("submission", item.task_id)
    # Claim the row first, then move the bytes inside the same transaction: a
    # failed move rolls the claim back, and a row the student removed during
    # the scan is never moved into place.
    with transaction.atomic():
        updated = ReportFile.objects.filter(pk=file_id, file=pending_name).update(
            file=final_name,
            scan_status=SCAN_CLEAN,
            scanned_at=now,
            scanner=verdict.scanner,
            scan_signature_version=verdict.signature_version,
            scan_threat="",
        )
        if updated:
            _move_into_storage(path, final_name)
    if not updated:
        # The student removed the file while it was being scanned.
        discard_pending_bytes(pending_name)
        return None
    return SCAN_CLEAN


@outbox_handler(EVENT_SCAN_UPLOAD, max_attempts=SCAN_MAX_ATTEMPTS)
def handle_scan_upload(event):
    status = scan_pending_file(int((event.payload or {}).get("file_id") or 0))
    if status:
        logger.info("reports: async scan file=%s status=%s", event.payload.get("file_id"), status)
    return status


def requeue_stuck_scans(*, older_than_seconds=600, now=None, limit=200):
    """Housekeeping: re-publish scans for pending files older than
    ``older_than_seconds`` (a lost or exhausted job). Idempotent per 10-minute
    bucket."""
    now = now or timezone.now()
    cutoff = now - timedelta(seconds=older_than_seconds)
    bucket = int(now.timestamp()) // 600
    stuck = list(
        ReportFile.objects.filter(
            file__startswith=PENDING_PREFIX, scan_status=SCAN_UNSCANNED, created_at__lt=cutoff
        ).values_list("pk", flat=True)[:limit]
    )
    for pk in stuck:
        publish(
            EVENT_SCAN_UPLOAD,
            {"file_id": pk},
            dedupe_key=f"report-scan:{pk}:requeue:{bucket}",
            max_attempts=SCAN_MAX_ATTEMPTS,
        )
    return len(stuck)
