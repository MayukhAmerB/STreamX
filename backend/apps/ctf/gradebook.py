"""The unified, read-only gradebook: weekly reports and CTF exams together.

* Reports come from ``apps.reports.services`` (``course_gradebook`` for
  staff and instructors, ``student_marks`` for the student's own view, which
  only shows marks the course has released).
* Exams come from ``CtfExamResult`` (written by ``ctf.scheduler`` when an exam
  closes). An exam that has not been finalized shows as ``pending``; a
  finalized exam the student did not sit shows as ``absent``.

Report marks and exam points are on different scales, so each part has its
own percentage and ``overall_percentage`` is the mean of the parts the
student has a percentage for.

Access: a student sees only their own gradebook; an instructor sees the
batches (courses) they teach; staff see every batch.
"""

from __future__ import annotations

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone

from apps.core.errors import NotFound, PermissionDenied
from apps.courses.models import Course, Enrollment

from . import access
from .models import CtfExam, CtfExamResult, CtfParticipation

KIND_REPORT = "report"
KIND_EXAM = "exam"


def _number(value):
    if value is None:
        return None
    try:
        return round(float(Decimal(str(value))), 2)
    except (ArithmeticError, ValueError):
        return None


def _percent(part, whole):
    if not whole:
        return None
    return round(float(part) * 100.0 / float(whole), 1)


def person(user):
    return {"id": user.pk, "full_name": getattr(user, "full_name", "") or "", "email": user.email}


def course_dict(course):
    return {"id": course.pk, "slug": course.slug, "title": course.title, "batch": getattr(course, "batch", "") or ""}


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------
def viewable_courses(user):
    if access.is_staff_user(user):
        return Course.objects.all()
    if not user or not user.is_authenticated:
        return Course.objects.none()
    return Course.objects.filter(instructor_id=user.pk)


def require_reader(user):
    if not (access.is_staff_user(user) or viewable_courses(user).exists()):
        raise PermissionDenied("Only staff and instructors can open batch gradebooks.", code="gradebook_forbidden")


def viewable_course_or_404(user, course_id):
    course = viewable_courses(user).filter(pk=course_id).first()
    if course is None:
        raise NotFound("Batch not found.", code="gradebook_course_not_found")
    return course


def viewable_student_or_404(viewer, student_id):
    """Staff: any student. Instructor: a student enrolled in a course they teach."""
    User = get_user_model()
    student = User.objects.filter(pk=student_id).first()
    if student is None:
        raise NotFound("Student not found.", code="gradebook_student_not_found")
    if access.is_staff_user(viewer):
        return student
    taught = viewable_courses(viewer).values_list("pk", flat=True)
    if not Enrollment.objects.filter(user=student, course_id__in=taught).exists():
        raise NotFound("Student not found.", code="gradebook_student_not_found")
    return student


# ---------------------------------------------------------------------------
# Columns and cells
# ---------------------------------------------------------------------------
def course_exams(course):
    return list(
        CtfExam.objects.filter(eligible_courses=course)
        .exclude(status=CtfExam.STATUS_DRAFT)
        .order_by("opens_at", "id")
        .distinct()
    )


def report_column(task):
    week = getattr(task, "week_number", None)
    return {
        "key": f"{KIND_REPORT}:{task.pk}",
        "kind": KIND_REPORT,
        "id": task.pk,
        "title": task.title,
        "short_title": f"W{week}" if week else task.title[:12],
        "date": task.due_at,
        "max": _number(task.max_marks),
    }


def exam_column(exam, total_points=None):
    return {
        "key": f"{KIND_EXAM}:{exam.pk}",
        "kind": KIND_EXAM,
        "id": exam.pk,
        "title": exam.title,
        "short_title": exam.title[:12],
        "date": exam.closes_at or exam.opens_at,
        "max": total_points,
    }


def report_cell(column, cell):
    marks = cell.get("final_marks")
    status = cell.get("status") or ""
    if cell.get("is_missing"):
        status = "missing"
    elif marks is not None:
        status = "graded"
    return {
        "key": column["key"],
        "kind": KIND_REPORT,
        "status": status,
        "value": _number(marks),
        "max": column["max"],
        "is_late": bool(cell.get("is_late")),
        "rank": None,
    }


def exam_cell(column, exam, result, participation=None):
    if result is not None:
        return {
            "key": column["key"],
            "kind": KIND_EXAM,
            "status": "result",
            "value": float(result.score),
            "max": float(result.total_points),
            "is_late": False,
            "rank": result.rank,
        }
    status = "absent" if exam.results_finalized_at else "pending"
    if participation is not None and not exam.results_finalized_at:
        status = "in_progress" if participation.status == CtfParticipation.STATUS_ACTIVE else "pending"
    return {
        "key": column["key"],
        "kind": KIND_EXAM,
        "status": status,
        "value": None,
        "max": column["max"],
        "is_late": False,
        "rank": None,
    }


def totals(cells):
    parts = {}
    for kind in (KIND_REPORT, KIND_EXAM):
        scored = [cell for cell in cells if cell["kind"] == kind and cell["value"] is not None and cell["max"]]
        total = round(sum(cell["value"] for cell in scored), 2)
        out_of = round(sum(cell["max"] for cell in scored), 2)
        parts[kind] = {"total": total, "max": out_of, "percentage": _percent(total, out_of), "count": len(scored)}
    available = [part["percentage"] for part in parts.values() if part["percentage"] is not None]
    return {
        "reports": parts[KIND_REPORT],
        "exams": parts[KIND_EXAM],
        "overall_percentage": round(sum(available) / len(available), 1) if available else None,
        "missing_count": sum(1 for cell in cells if cell["status"] in {"missing", "absent"}),
        "late_count": sum(1 for cell in cells if cell["is_late"]),
    }


# ---------------------------------------------------------------------------
# Batch (course) gradebook
# ---------------------------------------------------------------------------
def _reports_book(course):
    from apps.reports.services import course_gradebook

    return course_gradebook(course)


def batch_gradebook(course, *, now=None):
    now = now or timezone.now()
    book = _reports_book(course)
    report_columns = [report_column(task) for task in book["tasks"]]
    exams = course_exams(course)
    exam_columns = []
    for exam in exams:
        from .scheduler import exam_totals

        exam_columns.append(exam_column(exam, exam_totals(exam)[1]))

    report_rows = {row["student"].pk: row for row in book["rows"]}
    results = {}
    participations = {}
    if exams:
        result_filter = Q(exam__in=exams) & (Q(batch_course=course) | Q(user_id__in=list(report_rows)))
        for result in CtfExamResult.objects.filter(result_filter):
            results[(result.exam_id, result.user_id)] = result
        for item in CtfParticipation.objects.filter(
            exam__in=exams, is_staff_preview=False
        ).filter(Q(batch_course=course) | Q(user_id__in=list(report_rows))):
            participations[(item.exam_id, item.user_id)] = item

    student_ids = set(report_rows) | {user_id for _exam, user_id in results} | {
        user_id for _exam, user_id in participations
    }
    students = list(get_user_model().objects.filter(pk__in=student_ids).order_by("full_name", "email", "id"))
    from apps.users import identity

    blocks = identity.identity_blocks([(student, None) for student in students], course_id=course.pk)
    rows = []
    for student, block in zip(students, blocks, strict=True):
        cells = []
        report_row = report_rows.get(student.pk)
        for index, column in enumerate(report_columns):
            raw = report_row["cells"][index] if report_row and index < len(report_row["cells"]) else {}
            if not raw:
                raw = {"status": "not_submitted", "final_marks": None, "is_missing": False, "is_late": False}
            cells.append(report_cell(column, raw))
        for exam, column in zip(exams, exam_columns, strict=True):
            cells.append(
                exam_cell(column, exam, results.get((exam.pk, student.pk)), participations.get((exam.pk, student.pk)))
            )
        rows.append({"identity": block, "student": person(student), "cells": cells, "totals": totals(cells)})
    return {
        "course": course_dict(course),
        "columns": report_columns + exam_columns,
        "rows": rows,
        "generated_at": now,
    }


# ---------------------------------------------------------------------------
# One student
# ---------------------------------------------------------------------------
def _student_course_ids(student):
    enrolled = set(Enrollment.objects.filter(user=student).values_list("course_id", flat=True))
    from apps.reports.models import ReportSubmission

    submitted = set(ReportSubmission.objects.filter(student=student).values_list("task__course_id", flat=True))
    exam_courses = set(
        CtfExamResult.objects.filter(user=student, batch_course__isnull=False).values_list("batch_course_id", flat=True)
    )
    return enrolled | submitted | exam_courses


def _exam_section(student, course, exams):
    columns, cells = [], []
    results = {item.exam_id: item for item in CtfExamResult.objects.filter(user=student, exam__in=exams)}
    participations = {
        item.exam_id: item for item in CtfParticipation.objects.filter(user=student, exam__in=exams, is_staff_preview=False)
    }
    from .scheduler import exam_totals

    for exam in exams:
        column = exam_column(exam, exam_totals(exam)[1])
        columns.append(column)
        cells.append(exam_cell(column, exam, results.get(exam.pk), participations.get(exam.pk)))
    return columns, cells


def student_gradebook(student, *, viewer, now=None):
    """Staff/instructor view of one student, across the batches the viewer may see."""
    now = now or timezone.now()
    course_ids = _student_course_ids(student)
    courses = viewable_courses(viewer).filter(pk__in=course_ids).order_by("title", "id")
    sections = []
    for course in courses:
        book = _reports_book(course)
        report_columns = [report_column(task) for task in book["tasks"]]
        row = next((item for item in book["rows"] if item["student"].pk == student.pk), None)
        cells = []
        for index, column in enumerate(report_columns):
            raw = row["cells"][index] if row and index < len(row["cells"]) else {}
            cells.append(report_cell(column, raw or {"status": "not_submitted", "final_marks": None}))
        exam_columns, exam_cells = _exam_section(student, course, course_exams(course))
        all_cells = cells + exam_cells
        sections.append(
            {
                "course": course_dict(course),
                "columns": report_columns + exam_columns,
                "cells": all_cells,
                "totals": totals(all_cells),
            }
        )
    from apps.users import identity

    return {
        "identity": identity.block_for_user(student),
        "student": person(student),
        "courses": sections,
        "generated_at": now,
    }


def my_gradebook(user, *, now=None):
    """The student's own view: released report marks and finalized exam results."""
    from apps.reports.services import student_marks

    now = now or timezone.now()
    sections = {}
    for entry in student_marks(user, now=now):
        course = entry["course"]
        report_columns = [report_column(task) for task in entry["tasks"]]
        cells = [report_cell(column, cell) for column, cell in zip(report_columns, entry["cells"], strict=False)]
        sections[course.pk] = {"course": course, "columns": report_columns, "cells": cells}

    exam_ids = set(
        CtfExamResult.objects.filter(user=user).values_list("exam_id", flat=True)
    ) | set(CtfParticipation.objects.filter(user=user, is_staff_preview=False).values_list("exam_id", flat=True))
    exams = list(CtfExam.objects.filter(pk__in=exam_ids).order_by("opens_at", "id"))
    results = {item.exam_id: item for item in CtfExamResult.objects.filter(user=user, exam__in=exams)}
    participations = {
        item.exam_id: item for item in CtfParticipation.objects.filter(user=user, exam__in=exams)
    }
    from .scheduler import exam_totals

    for exam in exams:
        result = results.get(exam.pk)
        participation = participations.get(exam.pk)
        course = (result.batch_course if result else None) or (participation.batch_course if participation else None)
        course = course or exam.eligible_courses.order_by("title").first()
        if course is None:
            continue
        section = sections.setdefault(course.pk, {"course": course, "columns": [], "cells": []})
        column = exam_column(exam, exam_totals(exam)[1])
        section["columns"].append(column)
        section["cells"].append(exam_cell(column, exam, result, participation))

    ordered = sorted(sections.values(), key=lambda item: item["course"].title.lower())
    from apps.users import identity

    return {
        # The student's own header: only marks they can already see count.
        "identity": identity.block_for_user(user, include_unreleased=False),
        "student": person(user),
        "courses": [
            {
                "course": course_dict(item["course"]),
                "columns": item["columns"],
                "cells": item["cells"],
                "totals": totals(item["cells"]),
            }
            for item in ordered
        ],
        "generated_at": now,
    }


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------
def batch_csv_rows(book):
    from apps.users import identity

    # Owner rule: the student block (roll number, real name, handle, stats) comes first.
    header = [*identity.IDENTITY_HEADER, "Student email"]
    for column in book["columns"]:
        label = "Report" if column["kind"] == KIND_REPORT else "Exam"
        maximum = f" /{column['max']:g}" if isinstance(column["max"], (int, float)) else ""
        header.append(f"{label}: {column['title']}{maximum}")
    header += ["Reports %", "Exams %", "Overall %", "Missing", "Late"]
    yield header
    course_id = (book.get("course") or {}).get("id") if isinstance(book.get("course"), dict) else None
    blocks = identity.identity_blocks([(row["student"], None) for row in book["rows"]], course_id=course_id)
    for row, block in zip(book["rows"], blocks, strict=True):
        values = [*identity.identity_cells(block), row["student"]["email"]]
        for cell in row["cells"]:
            if cell["value"] is not None:
                values.append(f"{cell['value']:g}")
            else:
                values.append(cell["status"].replace("_", " "))
        row_totals = row["totals"]
        values += [
            "" if row_totals["reports"]["percentage"] is None else row_totals["reports"]["percentage"],
            "" if row_totals["exams"]["percentage"] is None else row_totals["exams"]["percentage"],
            "" if row_totals["overall_percentage"] is None else row_totals["overall_percentage"],
            row_totals["missing_count"],
            row_totals["late_count"],
        ]
        yield values
