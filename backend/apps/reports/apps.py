from django.apps import AppConfig


class ReportsConfig(AppConfig):
    """Weekly report tasks, student submissions and marking."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.reports"
    label = "reports"
    verbose_name = "Weekly reports"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import checks  # noqa: F401  (registers system checks)
        from .rescan import schedule_periodic_rescan

        # Cheap: publishes at most one deduplicated outbox event per interval.
        register_periodic("reports.rescan", interval_seconds=600, func=schedule_periodic_rescan)
