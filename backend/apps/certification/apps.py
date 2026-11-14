from django.apps import AppConfig


class CertificationConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.certification"
    label = "certification"
    verbose_name = "Certification, delivery and Hall of Fame"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import checks, signals  # noqa: F401  (participation hook and deploy checks)
        from .sweep import interval_seconds, schedule_sweep

        # Cheap hook: one EXISTS query, then at most one deduplicated outbox event.
        register_periodic("certification.sweep", interval_seconds=interval_seconds(), func=schedule_sweep)
