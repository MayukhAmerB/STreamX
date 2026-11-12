"""Re-scan stored report files with fresh virus signatures.

Run by ``manage.py rescan_report_files`` and, every
``REPORTS_RESCAN_INTERVAL_HOURS``, by the async worker: a periodic hook
publishes one deduplicated ``reports.rescan_stored_files`` outbox event per
interval; its handler scans up to ``REPORTS_RESCAN_BATCH_SIZE`` files and
queues a continuation while files are left.

It also covers files stored before scanning existed (``scan_status ==
"unscanned"``): they cannot be downloaded until a re-scan finds them clean.
Their legacy on-disk names (random hex + original extension) are renamed to
``.bin`` once clean.

A stored file found infected later is QUARANTINED, not deleted: it is moved
out of the private storage into ``REPORTS_QUARANTINE_ROOT`` (its own noexec
host directory, mode 0700) with mode 000, every row that points at it is
marked ``infected`` (downloads refuse it), a ``ReportQuarantineRecord`` and a
security event are written and staff are notified. Keeping it lets an admin
confirm a false positive or hand the sample to an investigation; deleting it
is a manual, deliberate step (see SECURITY.md).
"""

from __future__ import annotations

import logging
import os
import shutil
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from config.audit import log_security_event
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db.models import F, Q
from django.utils import timezone

from apps.core.outbox import outbox_handler, publish

from . import antivirus
from .models import (
    SCAN_CLEAN,
    SCAN_INFECTED,
    SCAN_UNSCANNED,
    ReportAttachment,
    ReportFile,
    ReportGrade,
    ReportQuarantineRecord,
)
from .storage import STORED_SUFFIX, private_report_storage, quarantine_root

logger = logging.getLogger("apps.reports.rescan")

EVENT_RESCAN = "reports.rescan_stored_files"
QUARANTINE_FILE_MODE = 0o000


@dataclass(frozen=True)
class Holder:
    """A model column that points at a stored file, plus its scan columns."""

    kind: str
    model: type
    file_field: str
    prefix: str = ""

    def column(self, name):
        return f"{self.prefix}{name}"

    def queryset(self):
        return self.model.objects.exclude(**{self.file_field: ""}).exclude(**{f"{self.file_field}__isnull": True})

    def candidates(self, cutoff):
        status = self.column("scan_status")
        scanned_at = self.column("scanned_at")
        return (
            self.queryset()
            .exclude(**{status: SCAN_INFECTED})
            .filter(Q(**{f"{scanned_at}__isnull": True}) | Q(**{f"{scanned_at}__lt": cutoff}))
        )


HOLDERS = (
    Holder("submission", ReportFile, "file"),
    Holder("attachment", ReportAttachment, "file"),
    Holder("feedback", ReportGrade, "annotated_file", "annotated_"),
)


@dataclass
class RescanStats:
    scanned: int = 0
    clean: int = 0
    infected: int = 0
    missing: int = 0
    refused: int = 0
    renamed: int = 0
    remaining: int = 0
    quarantined: list = field(default_factory=list)

    def as_dict(self):
        return {
            "scanned": self.scanned,
            "clean": self.clean,
            "infected": self.infected,
            "missing": self.missing,
            "refused": self.refused,
            "renamed": self.renamed,
            "remaining": self.remaining,
        }


def _scan_values(holder, verdict, now, *, status, threat=""):
    return {
        holder.column("scan_status"): status,
        holder.column("scanned_at"): now,
        holder.column("scanner"): verdict.scanner if verdict else "",
        holder.column("scan_signature_version"): verdict.signature_version if verdict else "",
        holder.column("scan_threat"): threat,
    }


def _rows_for(holder, name):
    """Every row of this kind that points at ``name`` (duplicated tasks share
    reference files)."""
    return holder.queryset().filter(**{holder.file_field: name})


def _owner_and_task(holder, obj):
    if holder.kind == "submission":
        return obj.owner, obj.task
    if holder.kind == "attachment":
        return obj.uploaded_by, obj.task
    return obj.graded_by, obj.submission.task


def _original_name(holder, obj):
    return obj.annotated_file_name if holder.kind == "feedback" else obj.original_name


def _sha256(holder, obj):
    return "" if holder.kind == "feedback" else obj.sha256


def _normalise_legacy_name(holder, name):
    """hex.pdf -> hex.bin (files stored before extension-less names)."""
    if name.endswith(STORED_SUFFIX):
        return name
    directory, _slash, base = name.rpartition("/")
    stem = base.split(".", 1)[0] or uuid.uuid4().hex
    new_name = f"{directory}/{stem}{STORED_SUFFIX}" if directory else f"{stem}{STORED_SUFFIX}"
    storage = private_report_storage()
    old_path, new_path = storage.path(name), storage.path(new_name)
    if os.path.exists(new_path):
        new_name = f"{directory}/{uuid.uuid4().hex}{STORED_SUFFIX}" if directory else f"{uuid.uuid4().hex}{STORED_SUFFIX}"
        new_path = storage.path(new_name)
    os.replace(old_path, new_path)
    try:
        os.chmod(new_path, 0o640)
    except OSError:
        pass
    # Repoint every row (any kind) that referenced the old name.
    for other in HOLDERS:
        other.queryset().filter(**{other.file_field: name}).update(**{other.file_field: new_name})
    return new_name


def _notify_staff(record, holder, original_name, task):
    from apps.notifications.models import Notification
    from apps.notifications.services import create_notification

    staff_ids = list(
        get_user_model()
        .objects.filter(is_active=True)
        .filter(Q(is_staff=True) | Q(is_superuser=True))
        .values_list("pk", flat=True)
    )
    task_text = f" for “{task.title}”" if task is not None else ""
    create_notification(
        kind=Notification.KIND_ANNOUNCEMENT,
        title="A stored report file was quarantined",
        body=(
            f"The virus scanner found {record.signature} in “{original_name}”{task_text}. "
            "Downloads of it are blocked. Review it under Admin → Weekly reports → Quarantined / blocked files."
        ),
        recipients=staff_ids,
        event_key=f"report-quarantine:{record.pk}",
    )


def _quarantine(holder, obj, name, path, verdict, now, stats):
    target_name = f"{holder.kind}/{uuid.uuid4().hex}{STORED_SUFFIX}"
    target_path = os.path.join(quarantine_root(), *target_name.split("/"))
    os.makedirs(os.path.dirname(target_path), mode=0o700, exist_ok=True)
    # Block downloads first, then move the bytes away.
    _rows_for(holder, name).update(**_scan_values(holder, verdict, now, status=SCAN_INFECTED, threat=verdict.signature))
    action = ReportQuarantineRecord.ACTION_QUARANTINED
    size = 0
    try:
        size = os.path.getsize(path)
        shutil.move(path, target_path)  # separate filesystem: copy + delete
        os.chmod(target_path, QUARANTINE_FILE_MODE)
    except FileNotFoundError:
        action = ReportQuarantineRecord.ACTION_MISSING
        target_name = ""
    except OSError:
        logger.exception("reports: could not move infected file %s to quarantine", name)
        action = ReportQuarantineRecord.ACTION_BLOCKED
        target_name = ""
        try:
            os.chmod(path, QUARANTINE_FILE_MODE)
        except OSError:
            pass
    user, task = _owner_and_task(holder, obj)
    original_name = _original_name(holder, obj)
    record = ReportQuarantineRecord.objects.create(
        source=ReportQuarantineRecord.SOURCE_RESCAN,
        kind=holder.kind,
        action=action,
        user=user,
        task=task,
        object_id=obj.pk,
        original_name=original_name,
        size=size,
        sha256=_sha256(holder, obj),
        signature=verdict.signature,
        scanner=verdict.scanner,
        signature_version=verdict.signature_version,
        quarantine_name=target_name,
    )
    log_security_event(
        "reports.stored_file_quarantined",
        kind=holder.kind,
        object_id=obj.pk,
        user_id=getattr(user, "pk", None),
        task_id=getattr(task, "pk", None),
        filename=original_name,
        sha256=record.sha256,
        signature=verdict.signature,
        signature_version=verdict.signature_version,
        quarantine_name=target_name,
    )
    try:
        _notify_staff(record, holder, original_name, task)
    except Exception:  # noqa: BLE001 - the file is already blocked; the notice is best effort
        logger.exception("reports: could not notify staff about quarantined file %s", record.pk)
    stats.infected += 1
    stats.quarantined.append(record.pk)


def _scan_one(holder, obj, now, stats):
    field_file = getattr(obj, holder.file_field)
    name = getattr(field_file, "name", "") or ""
    if not name:
        return
    storage = private_report_storage()
    path = storage.path(name)
    if not os.path.isfile(path):
        # Nothing to scan; remember the attempt so the batch makes progress.
        stats.missing += 1
        logger.warning("reports: stored %s file %s is missing", holder.kind, name)
        _rows_for(holder, name).update(**{holder.column("scanned_at"): now})
        return
    try:
        verdict = antivirus.scan_path(path, size=os.path.getsize(path))
    except antivirus.ScanRefused:
        stats.refused += 1
        logger.error("reports: stored %s file %s is too large for the scanner", holder.kind, name)
        _rows_for(holder, name).update(**{holder.column("scanned_at"): now})
        return
    stats.scanned += 1
    if not verdict.clean:
        _quarantine(holder, obj, name, path, verdict, now, stats)
        return
    _rows_for(holder, name).update(**_scan_values(holder, verdict, now, status=SCAN_CLEAN))
    stats.clean += 1
    if not name.endswith(STORED_SUFFIX):
        try:
            _normalise_legacy_name(holder, name)
            stats.renamed += 1
        except OSError:
            logger.warning("reports: could not rename legacy stored file %s", name)


def rescan_stored_files(*, cutoff=None, limit=None, now=None) -> RescanStats:
    """Scan stored files whose last scan is older than ``cutoff`` (default:
    one interval ago) or that were never scanned. Raises
    ``antivirus.ScannerUnavailable`` when the scanner is down (nothing is
    marked; the next run retries)."""
    now = now or timezone.now()
    if cutoff is None:
        cutoff = now - timedelta(hours=int(getattr(settings, "REPORTS_RESCAN_INTERVAL_HOURS", 24)))
    limit = int(limit or getattr(settings, "REPORTS_RESCAN_BATCH_SIZE", 200))
    stats = RescanStats()
    processed = 0
    for holder in HOLDERS:
        ids = list(
            holder.candidates(cutoff)
            .order_by(F(holder.column("scanned_at")).asc(nulls_first=True), "pk")
            .values_list("pk", flat=True)[: max(0, limit - processed)]
        )
        for pk in ids:
            obj = holder.candidates(cutoff).filter(pk=pk).first()  # re-read: shared files may be done already
            processed += 1
            if obj is not None:
                _scan_one(holder, obj, now, stats)
        if processed >= limit:
            break
    stats.remaining = sum(holder.candidates(cutoff).count() for holder in HOLDERS)
    return stats


def unscanned_count() -> int:
    return sum(holder.queryset().filter(**{holder.column("scan_status"): SCAN_UNSCANNED}).count() for holder in HOLDERS)


# ---------------------------------------------------------------------------
# Periodic hook + outbox handler
# ---------------------------------------------------------------------------
def _interval_seconds():
    return int(getattr(settings, "REPORTS_RESCAN_INTERVAL_HOURS", 24)) * 3600


def schedule_periodic_rescan(now=None):
    """Publish this interval's re-scan event (idempotent per interval)."""
    now = now or timezone.now()
    bucket = int(now.timestamp()) // _interval_seconds()
    return publish(EVENT_RESCAN, {"bucket": bucket, "seq": 0}, dedupe_key=f"reports-rescan:{bucket}:0")


@outbox_handler(EVENT_RESCAN, max_attempts=12)
def handle_rescan_event(event):
    payload = event.payload or {}
    bucket = int(payload.get("bucket") or 0)
    seq = int(payload.get("seq") or 0)
    cutoff = datetime.fromtimestamp(bucket * _interval_seconds(), tz=UTC)
    stats = rescan_stored_files(cutoff=cutoff)  # ScannerUnavailable -> outbox retries with backoff
    logger.info("reports: rescan bucket=%s seq=%s %s", bucket, seq, stats.as_dict())
    if stats.remaining and (stats.scanned or stats.missing or stats.refused):
        publish(
            EVENT_RESCAN,
            {"bucket": bucket, "seq": seq + 1},
            dedupe_key=f"reports-rescan:{bucket}:{seq + 1}",
            delay_seconds=5,
        )
