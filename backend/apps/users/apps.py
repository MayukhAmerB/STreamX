from django.apps import AppConfig  # type: ignore


class UsersConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.users"
    label = "users"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import token_housekeeping

        # Cheap: publishes at most one deduplicated outbox event per day.
        register_periodic(
            "users.flush_expired_tokens",
            interval_seconds=token_housekeeping.FLUSH_INTERVAL_SECONDS,
            func=token_housekeeping.schedule_flush_expired_tokens,
        )
