from django.apps import AppConfig


class BillingConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.billing"
    label = "billing"
    verbose_name = "Billing"

    def ready(self):
        from apps.payments.gateway import register_order_event_handler

        from .services import handle_gateway_event

        register_order_event_handler(handle_gateway_event)
