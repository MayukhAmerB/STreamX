from django.apps import AppConfig


def _bucket(interval: int) -> int:
    from django.utils import timezone

    return int(timezone.now().timestamp()) // max(1, int(interval))


def _publish_flush():
    from apps.core.outbox import publish

    from . import conf
    from .signals import EVENT_FLUSH

    publish(EVENT_FLUSH, {}, dedupe_key=f"att-flush:{_bucket(conf.flush_interval_seconds())}")


def _publish_sweep():
    from apps.core.outbox import publish

    from . import access, conf
    from .signals import EVENT_SWEEP

    if not access.enabled():
        return
    publish(EVENT_SWEEP, {}, dedupe_key=f"att-sweep:{_bucket(conf.finalize_sweep_interval_seconds())}")


def _publish_materialize():
    from apps.core.outbox import publish

    from . import access, conf
    from .signals import EVENT_MATERIALIZE

    if not access.enabled():
        return
    publish(EVENT_MATERIALIZE, {}, dedupe_key=f"cal-materialize:{_bucket(conf.calendar_materialize_interval_seconds())}")


class AttendanceConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.attendance"
    label = "attendance"
    verbose_name = "Attendance & class calendar"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import conf, signals  # noqa: F401  (connects the session-end hook)

        # Cheap hooks: each only publishes one deduplicated outbox event.
        register_periodic("attendance.flush", interval_seconds=conf.flush_interval_seconds(), func=_publish_flush)
        register_periodic(
            "attendance.finalize_sweep", interval_seconds=conf.finalize_sweep_interval_seconds(), func=_publish_sweep
        )
        register_periodic(
            "calendar.materialize",
            interval_seconds=conf.calendar_materialize_interval_seconds(),
            func=_publish_materialize,
        )
