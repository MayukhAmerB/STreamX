"""CSV exports of CTF scores and attempts.

* Django admin (Examination): the full identity (roll number, real name,
  handle, stats) plus the student's e-mail.
* Console (``console=True``): handles only, by owner rule. No real name and no
  e-mail; the roll number stays as the staff reference.

Every text cell goes through ``csv_cell`` so a student cannot plant a
spreadsheet formula (``=HYPERLINK(...)``) in an answer that later runs in
the instructor's Excel/Sheets. Exports are streamed row by row, so a whole
exam's attempts never sit in memory.
"""

from __future__ import annotations

import csv
from datetime import datetime
from urllib.parse import quote

from django.http import StreamingHttpResponse
from django.utils import timezone

from apps.users import identity

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

# Owner rule: the student block (roll number, real name, handle, stats) comes
# first, then the record's own fields. The real name lives in the block.
PARTICIPATION_HEADER = [
    *identity.IDENTITY_HEADER,
    "Position",
    "Exam",
    "Student email",
    "Batch course",
    "Batch",
    "Status",
    "Score",
    "Solved",
    "Wrong answers",
    "Answers submitted",
    "Started at",
    "Deadline",
    "Submitted at",
    "Last correct answer at",
    "Staff preview",
]

# Console results CSV: the same record columns, handles only (no real name, no e-mail).
CONSOLE_PARTICIPATION_HEADER = [
    *identity.CONSOLE_IDENTITY_HEADER,
    *[name for name in PARTICIPATION_HEADER[len(identity.IDENTITY_HEADER) :] if name != "Student email"],
]

ATTEMPT_HEADER = [
    *identity.IDENTITY_HEADER,
    "Time",
    "Exam",
    "Question",
    "Question key",
    "Category",
    "Student email",
    "Batch course",
    "Attempt number",
    "Submitted answer",
    "Normalised answer",
    "Correct",
    "Points awarded",
    "IP hash (short)",
    "User agent",
]


def csv_cell(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int):
        return value
    if isinstance(value, datetime):
        return timezone.localtime(value).strftime("%Y-%m-%d %H:%M:%S")
    text = str(value)
    if text[:1] in FORMULA_PREFIXES:
        return f"'{text}"
    return text


class _Echo:
    def write(self, value):
        return value


def participation_row(participation, position, block=None):
    user = participation.user
    course = participation.batch_course
    if block is None:
        block = identity.block_for_user(user, record=participation)
    return [
        *identity.identity_cells(block),
        position,
        participation.exam.slug,
        user.email,
        course.title if course else "",
        course.batch if course else "",
        participation.get_status_display(),
        participation.score,
        participation.solved_count,
        participation.wrong_count,
        participation.attempt_count,
        participation.started_at,
        participation.deadline_at,
        participation.submitted_at,
        participation.last_correct_at,
        participation.is_staff_preview,
    ]


def console_participation_row(participation, position, block):
    """``participation_row`` for the Console: handle-only identity, no e-mail."""
    full = participation_row(participation, position, block)
    record = full[len(identity.IDENTITY_HEADER) :]
    email_at = PARTICIPATION_HEADER.index("Student email") - len(identity.IDENTITY_HEADER)
    return [*identity.console_identity_cells(block), *record[:email_at], *record[email_at + 1 :]]


def attempt_row(attempt, block=None):
    user = attempt.user
    course = attempt.participation.batch_course
    question = attempt.question
    if block is None:
        block = identity.block_for_user(user, record=attempt.participation)
    return [
        *identity.identity_cells(block),
        attempt.created_at,
        attempt.exam.slug,
        f"Q{question.order}: {question.title_en}",
        question.key,
        question.category,
        user.email,
        course.title if course else "",
        attempt.attempt_number,
        attempt.submitted_answer,
        attempt.normalized_answer,
        attempt.is_correct,
        attempt.points_awarded,
        attempt.client_ip_hash[:12],
        attempt.user_agent,
    ]


def _iter_rows(header, rows):
    writer = csv.writer(_Echo())
    yield "﻿"  # Excel opens UTF-8 (Urdu names) correctly with a BOM.
    yield writer.writerow(header)
    for row in rows:
        yield writer.writerow([csv_cell(value) for value in row])


def iter_participations_csv(queryset, *, console=False):
    """Scores CSV. ``console=True``: handles only (the Console export)."""
    queryset = queryset.select_related("exam", "user", "batch_course")
    pairs = identity.chunked_blocks(queryset.iterator(chunk_size=1000), lambda item: item.user, lambda item: item)
    if console:
        rows = (console_participation_row(item, position, block) for position, (item, block) in enumerate(pairs, 1))
        return _iter_rows(CONSOLE_PARTICIPATION_HEADER, rows)
    rows = (participation_row(item, position, block) for position, (item, block) in enumerate(pairs, 1))
    return _iter_rows(PARTICIPATION_HEADER, rows)


def iter_attempts_csv(queryset):
    queryset = queryset.select_related("exam", "user", "question", "participation__batch_course")
    pairs = identity.chunked_blocks(
        queryset.iterator(chunk_size=2000), lambda item: item.user, lambda item: item.participation, size=1000
    )
    rows = (attempt_row(item, block) for item, block in pairs)
    return _iter_rows(ATTEMPT_HEADER, rows)


def csv_response(chunks, filename):
    response = StreamingHttpResponse(chunks, content_type="text/csv; charset=utf-8")
    ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "export.csv"
    response["Content-Disposition"] = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
    response["X-Content-Type-Options"] = "nosniff"
    response["Cache-Control"] = "private, no-store"
    response["X-Accel-Buffering"] = "no"
    return response


def export_filename(prefix, exam_slug=""):
    stamp = timezone.localtime().strftime("%Y%m%d-%H%M")
    middle = f"-{exam_slug}" if exam_slug else ""
    return f"{prefix}{middle}-{stamp}.csv"
