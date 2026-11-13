from django.apps import AppConfig


class RealtimeConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.realtime"
    verbose_name = "Realtime Sessions"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import periodic

        # Cheap: an EXISTS query, then at most one deduplicated outbox event.
        register_periodic(
            "realtime.chat_timeouts",
            interval_seconds=periodic.CHAT_TIMEOUTS_INTERVAL_SECONDS,
            func=periodic.schedule_chat_timeout_release,
        )
        # The single writer of OBS stream_status (GETs only read it).
        register_periodic(
            "realtime.obs_stream_health",
            interval_seconds=periodic.obs_stream_health_interval_seconds(),
            func=periodic.persist_obs_stream_health,
        )
