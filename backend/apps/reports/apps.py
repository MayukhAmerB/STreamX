from django.apps import AppConfig


class ReportsConfig(AppConfig):
    """Weekly report tasks, student submissions and marking."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.reports"
    label = "reports"
    verbose_name = "Weekly reports"
