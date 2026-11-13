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
        from .housekeeping import HOUSEKEEPING_INTERVAL_SECONDS, schedule_housekeeping
        from .rescan import schedule_periodic_rescan

        # Cheap: publishes at most one deduplicated outbox event per interval.
        register_periodic("reports.rescan", interval_seconds=600, func=schedule_periodic_rescan)
        # Due-reminder backstop and staged-upload prune (hourly).
        register_periodic(
            "reports.housekeeping",
            interval_seconds=HOUSEKEEPING_INTERVAL_SECONDS,
            func=schedule_housekeeping,
        )
