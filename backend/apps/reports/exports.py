"""CSV marks export and the streamed bulk-download zip (Console downloads).

Owner rule (Console): students are identified by @handle only: roll number,
handle and stats lead every row; no real name and no e-mail. The full
identity lives in Django admin -> Examination.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile

from django.utils import timezone

from apps.users import identity

from .models import SCAN_CLEAN, SCAN_INFECTED, ReportCriterion, ReportSubmission
from .services import course_gradebook, format_marks

_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_UNSAFE_PATH_CHARS = re.compile(r'[\x00-\x1f<>:"/\\|?*]+')
_STORE_EXTENSIONS = {"pdf", "pptx", "docx", "odt", "odp", "png", "jpg", "jpeg", "webp", "zip"}
ZIP_CHUNK_BYTES = 256 * 1024


def csv_safe(value):
    """Neutralise spreadsheet formulas (CSV injection) in user-provided text."""
    text = "" if value is None else str(value)
    if text.startswith(_FORMULA_PREFIXES):
        return "'" + text
    return text


def _local(value):
    return timezone.localtime(value).strftime("%Y-%m-%d %H:%M IST") if value else ""


def _write_rows(rows):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    for row in rows:
        writer.writerow([csv_safe(cell) for cell in row])
    # UTF-8 BOM so Excel opens names in any script correctly.
    return "﻿" + buffer.getvalue()


def course_marks_csv(course):
    book = course_gradebook(course)
    tasks = book["tasks"]
    # Owner rule: the student block (roll number, handle, stats) comes first; handles only.
    header = list(identity.CONSOLE_IDENTITY_HEADER)
    for task in tasks:
        label = f"W{task.week_number} " if task.week_number else ""
        header.append(f"{label}{task.title} (/{format_marks(task.max_marks)})")
    header += ["Total", "Out of (graded)", "Percent", "Graded", "Missing", "Late"]
    rows = [header]
    blocks = identity.identity_blocks([(row["student"], None) for row in book["rows"]], course_id=course.pk)
    for row, block in zip(book["rows"], blocks, strict=True):
        line = identity.console_identity_cells(block)
        for cell in row["cells"]:
            if cell["final_marks"] is not None:
                line.append(format_marks(cell["final_marks"]))
            elif cell["is_missing"]:
                line.append("missing")
            else:
                line.append(cell["status"].replace("_", " ") if cell["submission_id"] else "")
        totals = row["totals"]
        line += [
            format_marks(totals["total_marks"]),
            format_marks(totals["max_marks"]),
            "" if totals["percentage"] is None else format_marks(totals["percentage"]),
            totals["graded_count"],
            totals["missing_count"],
            totals["late_count"],
        ]
        rows.append(line)
    return _write_rows(rows)


def task_marks_csv(task):
    criteria = list(ReportCriterion.objects.filter(task=task).order_by("order", "id"))
    header = [
        *identity.CONSOLE_IDENTITY_HEADER,
        "Status",
        "Submitted at",
        "Late",
        "Minutes late",
        "Version",
        "Marks before penalty",
        "Late penalty",
        "Final marks",
        "Out of",
    ]
    header += [f"{item.name} (/{format_marks(item.max_marks)})" for item in criteria]
    header += ["Graded by", "Graded at", "Feedback"]
    auto = task.origin == "auto"
    target_at = len(identity.CONSOLE_IDENTITY_HEADER)  # right after the identity block
    if auto:  # self-service week: one row per target
        header.insert(target_at, "Target")
    rows = [header]
    submissions = (
        ReportSubmission.objects.filter(task=task)
        .exclude(status=ReportSubmission.STATUS_NOT_SUBMITTED)
        .select_related("student", "grade", "grade__graded_by")
        .order_by("student_id", "target_key", "id")
    )
    submissions = list(submissions)
    blocks = identity.identity_blocks(
        [(submission.student, submission) for submission in submissions], course_id=task.course_id
    )
    for submission, block in zip(submissions, blocks, strict=True):
        grade = getattr(submission, "grade", None)
        stored = (grade.criteria_marks or {}) if grade else {}
        graded_by = grade.graded_by if grade else None
        row = [
            *identity.console_identity_cells(block),
            submission.get_status_display(),
            _local(submission.submitted_at),
            "yes" if submission.is_late else "no",
            submission.minutes_late,
            submission.version_count,
            format_marks(grade.raw_marks) if grade else "",
            format_marks(grade.late_penalty) if grade and grade.raw_marks is not None else "",
            format_marks(grade.final_marks) if grade else "",
            format_marks(task.max_marks),
            *[stored.get(str(item.pk), "") for item in criteria],
            (graded_by.full_name or graded_by.email) if graded_by else "",
            _local(grade.graded_at) if grade else "",
            grade.feedback if grade else "",
        ]
        if auto:
            row.insert(target_at, submission.target_name)
        rows.append(row)
    return _write_rows(rows)


def safe_component(value, fallback="file", limit=80):
    text = _UNSAFE_PATH_CHARS.sub("_", str(value or "")).strip(" .")
    text = text.replace("..", "_")
    return (text or fallback)[:limit]


class _ZipSink(io.RawIOBase):
    """Write-only, non-seekable buffer that zipfile streams into."""

    def __init__(self):
        super().__init__()
        self._chunks = []
        self._position = 0

    def writable(self):
        return True

    def write(self, data):
        if data:
            self._chunks.append(bytes(data))
            self._position += len(data)
        return len(data)

    def tell(self):
        return self._position

    def flush(self):
        return None

    def drain(self):
        data = b"".join(self._chunks)
        self._chunks = []
        return data


def iter_task_zip(task):
    """Yield a zip of every student's current version, built on the fly.

    Nothing is written to disk and memory stays bounded by ``ZIP_CHUNK_BYTES``
    (zipfile writes data descriptors because the sink cannot seek). Folder and
    file names are sanitised, so a crafted original name can never produce a
    path outside the archive.
    """
    submissions = (
        ReportSubmission.objects.filter(task=task, current_version__isnull=False)
        .select_related("student", "current_version", "grade")
        .order_by("student_id")
    )
    sink = _ZipSink()
    manifest = [
        [*identity.CONSOLE_IDENTITY_HEADER, "Status", "Version", "Submitted at", "Late", "File", "Size (bytes)", "SHA-256"]
    ]
    with zipfile.ZipFile(sink, mode="w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        used = set()
        for submission, block in identity.chunked_blocks(
            submissions.iterator(), lambda item: item.student, lambda item: item, course_id=task.course_id
        ):
            student = submission.student
            who = identity.console_identity_cells(block)
            # Handles only: "@handle (AL-SYD-00042)", or "AL-SYD-00042 (no handle)".
            label = identity.console_label(block)
            if not label.startswith(block["roll_number"]):
                label = f"{label} ({block['roll_number']})"
            folder = safe_component(label, fallback=f"student-{student.pk}")
            if task.origin == "auto" and submission.target_name:
                # Self-service week: one sub-folder per target.
                folder = (
                    f"{folder}/{safe_component(submission.target_name, fallback=f'target-{submission.pk}', limit=60)}"
                )
            version = submission.current_version
            for item in version.files.all().order_by("created_at", "id"):
                if item.scan_status != SCAN_CLEAN:
                    # Never ship a file without a clean virus scan, not even to graders.
                    label = "BLOCKED BY VIRUS SCANNER" if item.scan_status == SCAN_INFECTED else "NOT SCANNED YET"
                    manifest.append(
                        [
                            *who,
                            submission.status,
                            version.number,
                            "",
                            "",
                            f"{label}: {item.original_name}",
                            item.size,
                            item.sha256,
                        ]
                    )
                    continue
                base = safe_component(item.original_name)
                arcname = f"{folder}/v{version.number}/{base}"
                counter = 2
                while arcname.lower() in used:
                    stem, dot, ext = base.rpartition(".")
                    arcname = f"{folder}/v{version.number}/{stem or base}-{counter}{dot}{ext if stem else ''}"
                    counter += 1
                used.add(arcname.lower())
                info = zipfile.ZipInfo(arcname, date_time=timezone.localtime(version.submitted_at).timetuple()[:6])
                info.compress_type = zipfile.ZIP_STORED if item.extension in _STORE_EXTENSIONS else zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                try:
                    source = item.file.open("rb")
                except OSError:
                    manifest.append(
                        [
                            *who,
                            submission.status,
                            version.number,
                            "",
                            "",
                            f"MISSING: {item.original_name}",
                            item.size,
                            item.sha256,
                        ]
                    )
                    continue
                with source, archive.open(info, mode="w", force_zip64=True) as target:
                    while True:
                        chunk = source.read(ZIP_CHUNK_BYTES)
                        if not chunk:
                            break
                        target.write(chunk)
                        yield sink.drain()
                manifest.append(
                    [
                        *who,
                        submission.get_status_display(),
                        version.number,
                        _local(version.submitted_at),
                        "yes" if version.is_late else "no",
                        arcname,
                        item.size,
                        item.sha256,
                    ]
                )
                yield sink.drain()
        archive.writestr("manifest.csv", _write_rows(manifest).encode("utf-8"))
    yield sink.drain()
