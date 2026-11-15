"""Django admin -> "Examination": every exam record the Console staff views
show, with the FULL student identity (owner rule).

The Console identifies students by @handle only. Here, for staff, every
student row carries the full identity in the owner's order: roll number,
REAL NAME, handle (with the most recent handle), stats; then the record.

The section (sidebar group "examination" in ``enterprise_admin.JOB_GROUPS``):

* Exams (``CtfExamAdmin``): list, detail, schedule, eligible batches, status,
  publish / take off the schedule / close, results links and CSVs.
* Questions (``CtfQuestionAdmin``, here): read-only; answers are stored only
  as peppered hashes and are never shown, not even to superusers.
* Results (``CtfParticipationAdmin``): score, solved / wrong counts, started /
  deadline / submitted times, staff-preview flag, batch and the Console rank.
* Attempts (``CtfAttemptAdmin``): every answer, filterable by exam, question,
  batch and status, searchable by roll number, name, handle or e-mail.
* Final results (``CtfExamResultAdmin``), evidence files (``CtfMaterialAdmin``).
* Certification policies and decisions (``apps.certification.admin``).
* Gradebook (``ExamGradebookAdmin``, here): the combined reports + exams
  gradebook of one batch, as in Console -> Gradebook, plus a CSV.

Results CSVs with the full identity (real name, e-mail) are for admins only:
superusers, or staff holding the matching view permission.
"""

from __future__ import annotations

import csv

from django.contrib import admin
from django.db.models import Count, Q
from django.http import Http404
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.html import format_html

from apps.users import identity
from apps.users.identity_admin import stats_text

from . import exports, gradebook
from .models import CtfQuestion, ExamGradebook


# --- Questions --------------------------------------------------------------------------------
@admin.register(CtfQuestion)
class CtfQuestionAdmin(admin.ModelAdmin):
    """Read-only. Answer hashes and normalisation rules are never shown."""

    list_display = (
        "exam",
        "order",
        "key",
        "title_en",
        "category",
        "difficulty",
        "points",
        "max_attempts",
        "is_active",
        "answered",
        "solved",
        "solve_rate",
    )
    list_display_links = ("order", "key")
    list_filter = ("exam", "category", "difficulty", "is_active")
    search_fields = ("key", "exam__slug", "exam__title")
    list_select_related = ("exam",)
    ordering = ("exam", "order")
    fields = (
        "exam",
        "order",
        "key",
        "title_en",
        "prompt_en",
        "category",
        "difficulty",
        "points",
        "max_attempts",
        "materials",
        "is_active",
        "answered",
        "solved",
        "solve_rate",
        "answer_key",
        "created_at",
        "updated_at",
    )
    readonly_fields = fields

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .annotate(
                _answered=Count("attempts__participation", filter=Q(attempts__participation__is_staff_preview=False), distinct=True),
                _solved=Count(
                    "attempts",
                    filter=Q(attempts__is_correct=True, attempts__participation__is_staff_preview=False),
                    distinct=True,
                ),
            )
        )

    @admin.display(description="Title")
    def title_en(self, obj):
        return obj.title_en

    @admin.display(description="Prompt (English)")
    def prompt_en(self, obj):
        value = (obj.prompt or {}).get("en") if isinstance(obj.prompt, dict) else obj.prompt
        if isinstance(value, list):
            value = "\n".join(str(item) for item in value)
        return value or "-"

    @admin.display(description="Students answered", ordering="_answered")
    def answered(self, obj):
        return getattr(obj, "_answered", 0)

    @admin.display(description="Solved", ordering="_solved")
    def solved(self, obj):
        return getattr(obj, "_solved", 0)

    @admin.display(description="Solve rate")
    def solve_rate(self, obj):
        answered = getattr(obj, "_answered", 0)
        if not answered:
            return "-"
        return f"{getattr(obj, '_solved', 0) * 100 / answered:.0f}%"

    @admin.display(description="Answers")
    def answer_key(self, obj):
        return "Hidden. Answers are stored only as peppered hashes and are never shown."


# --- Gradebook (reports + exams, full identity) -----------------------------------------------
def _cell_text(cell) -> str:
    if cell["value"] is not None:
        text = f"{cell['value']:g}"
        if cell.get("max"):
            text += f" / {cell['max']:g}"
        if cell.get("rank"):
            text += f" (#{cell['rank']})"
        if cell.get("is_late"):
            text += " late"
        return text
    return str(cell["status"] or "-").replace("_", " ")


def _percent(value) -> str:
    return "-" if value is None else f"{value:g}%"


@admin.register(ExamGradebook)
class ExamGradebookAdmin(admin.ModelAdmin):
    """One row per batch; opening a batch shows its combined gradebook (reports +
    exams) with roll number, REAL NAME, handle, stats and e-mail, plus a CSV."""

    list_display = ("title", "batch", "exam_count", "report_task_count", "student_count", "open_gradebook")
    list_display_links = ("title",)
    search_fields = ("title", "slug", "batch")
    ordering = ("title", "id")
    gradebook_template = "admin/ctf/examgradebook/gradebook.html"

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .annotate(
                _exams=Count("ctf_exams", distinct=True),
                _tasks=Count("report_tasks", distinct=True),
                _students=Count("enrollments", distinct=True),
            )
            .filter(Q(_exams__gt=0) | Q(_tasks__gt=0))
        )

    @admin.display(description="Exams", ordering="_exams")
    def exam_count(self, obj):
        return getattr(obj, "_exams", 0)

    @admin.display(description="Report tasks", ordering="_tasks")
    def report_task_count(self, obj):
        return getattr(obj, "_tasks", 0)

    @admin.display(description="Enrolments", ordering="_students")
    def student_count(self, obj):
        return getattr(obj, "_students", 0)

    @admin.display(description="Gradebook")
    def open_gradebook(self, obj):
        return format_html(
            '<a href="{}">Open</a> · <a href="{}">CSV</a>',
            reverse("admin:ctf_examgradebook_change", args=[obj.pk]),
            reverse("admin:ctf_examgradebook_csv", args=[obj.pk]),
        )

    def get_urls(self):
        return [
            path(
                "<int:pk>/gradebook.csv",
                self.admin_site.admin_view(self.csv_view),
                name="ctf_examgradebook_csv",
            ),
            *super().get_urls(),
        ]

    def _course_or_404(self, request, pk):
        if not self.has_view_permission(request):
            raise Http404
        course = ExamGradebook.objects.filter(pk=pk).first()
        if course is None:
            raise Http404
        return course

    def change_view(self, request, object_id, form_url="", extra_context=None):
        try:
            pk = int(object_id)
        except (TypeError, ValueError):
            raise Http404 from None
        course = self._course_or_404(request, pk)
        book = gradebook.batch_gradebook(course, full_identity=True)
        rows = []
        for row in book["rows"]:
            block = row["identity"]
            handle = f"@{block['handle']}" if block.get("handle") else identity.EMPTY
            rows.append(
                {
                    "roll_number": block["roll_number"],
                    "real_name": block.get("real_name") or identity.EMPTY,
                    "handle": handle,
                    "email": row["student"].get("email", ""),
                    "stats": stats_text(block.get("stats")),
                    "cells": [_cell_text(cell) for cell in row["cells"]],
                    "reports": _percent(row["totals"]["reports"]["percentage"]),
                    "exams": _percent(row["totals"]["exams"]["percentage"]),
                    "overall": _percent(row["totals"]["overall_percentage"]),
                    "missing": row["totals"]["missing_count"],
                    "late": row["totals"]["late_count"],
                }
            )
        context = {
            **self.admin_site.each_context(request),
            "opts": self.model._meta,
            "title": f"Gradebook: {course.title}",
            "course": course,
            "columns": book["columns"],
            "rows": rows,
            "generated_at": book["generated_at"],
            "csv_url": reverse("admin:ctf_examgradebook_csv", args=[course.pk]),
            "changelist_url": reverse("admin:ctf_examgradebook_changelist"),
            **(extra_context or {}),
        }
        return TemplateResponse(request, self.gradebook_template, context)

    def csv_view(self, request, pk):
        course = self._course_or_404(request, pk)
        book = gradebook.batch_gradebook(course, full_identity=True)

        def chunks():
            writer = csv.writer(exports._Echo())
            yield "﻿"
            for row in gradebook.batch_csv_rows(book, full_identity=True):
                yield writer.writerow([exports.csv_cell(value) for value in row])

        return exports.csv_response(chunks(), exports.export_filename("gradebook-full", course.slug or str(course.pk)))
