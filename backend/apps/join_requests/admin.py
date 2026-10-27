import csv

from django.contrib import admin, messages
from django.http import HttpResponse
from django.utils import timezone

from .models import JoinApplication

CSV_FIELDS = (
    ("id", "ID"),
    ("get_role_display", "Role"),
    ("full_name", "Full name"),
    ("age", "Age"),
    ("phone_number", "Contact number"),
    ("address", "Location / address"),
    ("state", "State"),
    ("district", "District"),
    ("get_status_display", "Status"),
    ("notes", "Notes"),
    ("terms_accepted_at", "Terms accepted at"),
    ("created_at", "Submitted at"),
)


FREE_TEXT_FIELDS = {"full_name", "address", "district", "notes"}


def _csv_cell(attr, value):
    text = "" if value is None else str(value)
    # Neutralise spreadsheet formula injection in user-submitted free text.
    if attr in FREE_TEXT_FIELDS and text[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return f"'{text}"
    return text


def _status_action(status, label):
    def action(modeladmin, request, queryset):
        updated = queryset.update(status=status, updated_at=timezone.now())
        modeladmin.message_user(request, f"{updated} submission(s) marked as {label}.", messages.SUCCESS)

    action.__name__ = f"mark_{status}"
    action.short_description = f"Mark selected as {label}"
    return action


@admin.register(JoinApplication)
class JoinApplicationAdmin(admin.ModelAdmin):
    list_display = (
        "full_name",
        "role",
        "phone_number",
        "age",
        "state",
        "district",
        "status",
        "created_at",
    )
    list_filter = ("status", "role", "state", "created_at")
    search_fields = ("full_name", "phone_number", "address", "state", "district", "notes")
    date_hierarchy = "created_at"
    ordering = ("-created_at",)
    list_per_page = 50
    readonly_fields = (
        "role",
        "full_name",
        "age",
        "phone_number",
        "address",
        "state",
        "district",
        "terms_accepted_at",
        "source_ip",
        "user_agent",
        "created_at",
        "updated_at",
    )
    fieldsets = (
        ("Applicant", {"fields": ("role", "full_name", "age", "phone_number")}),
        ("Location", {"fields": ("address", "state", "district")}),
        ("Review", {"fields": ("status", "notes")}),
        (
            "Submission metadata",
            {
                "classes": ("collapse",),
                "fields": ("terms_accepted_at", "source_ip", "user_agent", "created_at", "updated_at"),
            },
        ),
    )
    actions = (
        "export_as_csv",
        _status_action(JoinApplication.STATUS_REVIEWED, "Reviewed"),
        _status_action(JoinApplication.STATUS_CONTACTED, "Contacted"),
        _status_action(JoinApplication.STATUS_APPROVED, "Approved"),
        _status_action(JoinApplication.STATUS_REJECTED, "Rejected"),
    )

    def has_add_permission(self, request):
        return False

    @admin.action(description="Export selected as CSV")
    def export_as_csv(self, request, queryset):
        response = HttpResponse(content_type="text/csv")
        stamp = timezone.localtime().strftime("%Y%m%d-%H%M")
        response["Content-Disposition"] = f'attachment; filename="join-alsyed-submissions-{stamp}.csv"'
        writer = csv.writer(response)
        writer.writerow([label for _, label in CSV_FIELDS])
        for application in queryset.order_by("-created_at"):
            row = []
            for attr, _ in CSV_FIELDS:
                value = getattr(application, attr)
                row.append(_csv_cell(attr, value() if callable(value) else value))
            writer.writerow(row)
        return response
