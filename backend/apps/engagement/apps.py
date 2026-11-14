from django.apps import AppConfig


def _publish_flush():
    from django.utils import timezone

    from apps.core.outbox import publish

    from .rules import FLUSH_INTERVAL_SECONDS
    from .signals import EVENT_FLUSH

    bucket = int(timezone.now().timestamp()) // FLUSH_INTERVAL_SECONDS
    publish(EVENT_FLUSH, {}, dedupe_key=f"eng-flush:{bucket}")


def _publish_rebuild():
    from django.utils import timezone

    from apps.core.outbox import publish

    from .rules import LEADERBOARD_REBUILD_INTERVAL_SECONDS
    from .signals import EVENT_REBUILD

    bucket = int(timezone.now().timestamp()) // LEADERBOARD_REBUILD_INTERVAL_SECONDS
    publish(EVENT_REBUILD, {}, dedupe_key=f"eng-lb-rebuild:{bucket}")


def _publish_standings():
    from .standings import publish_due

    publish_due()


class EngagementConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.engagement"
    label = "engagement"
    verbose_name = "Engagement (XP, streaks, badges)"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import certificate_signals, checks, signals  # noqa: F401  (connects the model hooks and deploy checks)
        from .rules import FLUSH_INTERVAL_SECONDS, LEADERBOARD_REBUILD_INTERVAL_SECONDS

        # Cheap hooks: each only publishes one deduplicated outbox event.
        register_periodic("engagement.flush", interval_seconds=FLUSH_INTERVAL_SECONDS, func=_publish_flush)
        register_periodic(
            "engagement.leaderboard_rebuild",
            interval_seconds=LEADERBOARD_REBUILD_INTERVAL_SECONDS,
            func=_publish_rebuild,
        )
        # Weekly / monthly leaderboard standing XP (apps.engagement.standings).
        register_periodic("engagement.standings", interval_seconds=3600, func=_publish_standings)
