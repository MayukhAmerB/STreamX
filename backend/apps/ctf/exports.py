"""CSV exports of CTF scores and attempts (admin only).

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

FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

PARTICIPATION_HEADER = [
    "Position",
    "Exam",
    "Student email",
    "Student name",
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

ATTEMPT_HEADER = [
    "Time",
    "Exam",
    "Question",
    "Question key",
    "Category",
    "Student email",
    "Student name",
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


def participation_row(participation, position):
    user = participation.user
    course = participation.batch_course
    return [
        position,
        participation.exam.slug,
        user.email,
        getattr(user, "full_name", "") or "",
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


def attempt_row(attempt):
    user = attempt.user
    course = attempt.participation.batch_course
    question = attempt.question
    return [
        attempt.created_at,
        attempt.exam.slug,
        f"Q{question.order}: {question.title_en}",
        question.key,
        question.category,
        user.email,
        getattr(user, "full_name", "") or "",
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


def iter_participations_csv(queryset):
    queryset = queryset.select_related("exam", "user", "batch_course")
    rows = (participation_row(item, position) for position, item in enumerate(queryset.iterator(chunk_size=1000), 1))
    return _iter_rows(PARTICIPATION_HEADER, rows)


def iter_attempts_csv(queryset):
    queryset = queryset.select_related("exam", "user", "question", "participation__batch_course")
    rows = (attempt_row(item) for item in queryset.iterator(chunk_size=2000))
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
