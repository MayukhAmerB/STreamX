"""Admin list columns for the student identity block (owner order).

``StudentIdentityAdminMixin`` adds four leading columns: Roll number, Real
name, Handle (snapshot, with the most recent handle when it changed) and
Stats. Blocks for the whole page are loaded once per changelist
(``identity_blocks``: a fixed number of queries), never per row. Searching
for a roll number (``AL-SYD-00042``) finds that student's rows.
"""

from __future__ import annotations

import re

from django.contrib import admin
from django.utils.html import format_html

from . import identity

ROLL_RE = re.compile(r"^\s*AL-?SYD-?0*(\d{1,9})\s*$", re.IGNORECASE)
IDENTITY_LIST_DISPLAY = ("identity_roll_number", "identity_real_name", "identity_handle", "identity_stats")


def stats_text(stats) -> str:
    if not stats:
        return identity.EMPTY
    parts = []
    if stats.get("xp") is not None:
        parts.append(f"{stats['xp']} XP · {stats.get('rank') or identity.EMPTY}")
    if stats.get("attendance_percent") is not None:
        parts.append(f"Attendance {stats['attendance_percent']:g}%")
    reports = f"Reports {stats.get('reports_submitted', 0)}"
    if stats.get("reports_graded_average") is not None:
        reports += f" · avg {stats['reports_graded_average']:g}%"
    parts.append(reports)
    if stats.get("exam_score") is not None:
        parts.append(f"Exam {stats['exam_score']:g}%")
    return " | ".join(parts)


class StudentIdentityAdminMixin:
    """Mix into a ModelAdmin; set ``identity_user_attr`` and ``identity_record_attr``."""

    identity_user_attr = "user"
    identity_record_attr: str | None = ""  # "" = the row itself; None = no snapshot
    identity_user_id_field = "user_id"

    def _identity_record(self, obj):
        if self.identity_record_attr is None:
            return None
        if not self.identity_record_attr:
            return obj
        return getattr(obj, self.identity_record_attr, None)

    def get_changelist_instance(self, request):
        changelist = super().get_changelist_instance(request)
        rows = list(changelist.result_list)
        blocks = identity.identity_blocks(
            [(getattr(row, self.identity_user_attr), self._identity_record(row)) for row in rows]
        )
        for row, block in zip(rows, blocks, strict=True):
            row._identity_block = block
        return changelist

    def _block(self, obj):
        block = getattr(obj, "_identity_block", None)
        if block is None:
            block = identity.block_for_user(getattr(obj, self.identity_user_attr), record=self._identity_record(obj))
            obj._identity_block = block
        return block

    @admin.display(description="Roll number")
    def identity_roll_number(self, obj):
        return self._block(obj)["roll_number"]

    @admin.display(description="Real name")
    def identity_real_name(self, obj):
        return self._block(obj)["real_name"] or identity.EMPTY

    @admin.display(description="Handle")
    def identity_handle(self, obj):
        block = self._block(obj)
        handle = block.get("handle")
        shown = f"@{handle}" if handle else identity.EMPTY
        if block.get("handle_changed"):
            recent = block.get("handle_most_recent")
            return format_html(
                '{} <span class="identity-recent">(most recent: {})</span>',
                shown,
                f"@{recent}" if recent else identity.EMPTY,
            )
        return shown

    @admin.display(description="Stats")
    def identity_stats(self, obj):
        return stats_text(self._block(obj).get("stats"))

    def get_search_results(self, request, queryset, search_term):
        match = ROLL_RE.match(search_term or "")
        if match:
            return queryset.filter(**{self.identity_user_id_field: int(match.group(1))}), False
        return super().get_search_results(request, queryset, search_term)
