from django.apps import AppConfig


class PaymentsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.payments"
    label = "payments"

    def ready(self):
        from apps.core.worker import register_periodic

        from . import signals  # noqa: F401
        from .reconciliation import interval_seconds, schedule_reconcile

        # Stuck-payment reconciliation. The hook is always registered but does
        # nothing unless PAYMENT_RECONCILE_ENABLED (one EXISTS query, then at
        # most one deduplicated outbox event per interval).
        register_periodic("payments.reconcile", interval_seconds=interval_seconds(), func=schedule_reconcile)
