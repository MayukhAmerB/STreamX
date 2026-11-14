from django.apps import AppConfig


class RecordingUploadsConfig(AppConfig):
    """Resumable (chunked) upload of the file OBS saved on the host's laptop.

    The browser (Console -> Upload class recording) and the desktop uploader
    (tools/obs-uploader) send the recording in 32 MiB chunks, each one far
    below Cloudflare's 100 MB request-body limit, so the API stays behind the
    orange cloud. The async worker assembles the chunks, checks and remuxes the
    file and swaps it into the class's lecture (see services.py).
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.recording_uploads"
    label = "recording_uploads"
    verbose_name = "Class recording uploads"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import checks  # noqa: F401  (registers system checks)
        from . import metrics, outbox_handlers  # noqa: F401  (registers the outbox handlers)
        from . import openapi  # noqa: F401  (X-Upload-Token in the API schema)
        from .config import cleanup_interval_seconds

        # Cheap: publishes at most one deduplicated outbox event per interval.
        register_periodic(
            "recording_uploads.cleanup",
            interval_seconds=cleanup_interval_seconds(),
            func=outbox_handlers.schedule_cleanup,
        )
        metrics.register_collector()
