"""Worker side of resumable recording uploads (autodiscovered by apps.core)."""

import time

from apps.core.outbox import outbox_handler, publish

from . import config, services


@outbox_handler(services.ASSEMBLE_EVENT, max_attempts=12)
def assemble_upload(event):
    """Assemble, verify, remux and publish one finished upload (idempotent)."""
    services.process_upload(event.payload["upload_id"])


@outbox_handler(services.CLEANUP_EVENT, max_attempts=3)
def cleanup_uploads(event):
    services.cleanup()


def schedule_cleanup():
    """Periodic hook: at most one cleanup event per interval (dedupe key per time bucket)."""
    interval = config.cleanup_interval_seconds()
    bucket = int(time.time() // interval)
    publish(services.CLEANUP_EVENT, {}, dedupe_key=f"recording-uploads-cleanup:{bucket}")
