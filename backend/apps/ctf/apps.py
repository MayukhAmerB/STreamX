from django.apps import AppConfig


class CtfConfig(AppConfig):
    """OSINT CTF examinations taken on labs.alsyedinitiative.com.

    Postgres is the system of record: every evaluated answer is stored
    (append-only), the first correct answer per question scores once, and the
    admin shows every student's attempts and score.
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.ctf"
    label = "ctf"
    verbose_name = "OSINT CTF examinations"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import (
            checks,  # noqa: F401  (registers system checks)
            scheduler,
            signals,  # noqa: F401  (path-scoped CORS for the labs origin)
        )

        # ctf.scheduler: a few EXISTS queries, then at most one deduplicated
        # outbox event per interval (publish, close, expire, results).
        register_periodic(
            "ctf.scheduler",
            interval_seconds=scheduler.interval_seconds(),
            func=scheduler.schedule_tick,
        )
