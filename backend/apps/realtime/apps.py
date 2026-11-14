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

        # --- Phase 2: live-class lifecycle ---------------------------------
        from django.conf import settings

        from . import (
            lifecycle,  # noqa: F401 - registers the live.ended / go-live outbox handlers
            preflight,
            resource_profile,
            worker_heartbeat,
        )

        # Server-side authority for live state (LIVE_RECONCILER_MODE).
        register_periodic(
            "live.reconcile",
            interval_seconds=max(2, int(getattr(settings, "LIVE_RECONCILER_INTERVAL_SECONDS", 5) or 5)),
            func=periodic.live_reconcile,
        )
        register_periodic(
            "realtime.resource_profile",
            interval_seconds=60,
            func=resource_profile.apply_auto_resource_profile,
        )
        register_periodic(
            "realtime.preclass_probe",
            interval_seconds=60,
            func=preflight.schedule_preclass_probe,
        )
        # Per-process name: every worker process refreshes its own liveness file.
        register_periodic(
            worker_heartbeat.hook_name(),
            interval_seconds=worker_heartbeat.HEARTBEAT_INTERVAL_SECONDS,
            func=worker_heartbeat.touch_heartbeat,
        )
        # --- end Phase 2 ---------------------------------------------------

        # --- Phase 2: no-click recordings (apps/realtime/recording) --------
        from .recording import metrics as recording_metrics
        from .recording import reconcile as recording_reconcile

        # Meeting auto-egress, egress/browser publish, auto-retry, alerts.
        # Cheap EXISTS checks, then at most one deduplicated outbox event.
        register_periodic(
            "recording.reconcile",
            interval_seconds=int(getattr(settings, "RECORDING_RECONCILE_INTERVAL_SECONDS", 30) or 30),
            func=recording_reconcile.schedule_recording_reconcile,
        )
        recording_metrics.register_collector()
        # --- end Phase 2 recordings ----------------------------------------
