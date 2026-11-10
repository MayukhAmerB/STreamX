from django.apps import AppConfig


class CoreConfig(AppConfig):
    """Shared reliability building blocks (errors, HTTP, idempotency, outbox, health).

    ``apps.core`` must never import another ``apps.*`` package; apps depend on
    core, not the other way round (enforced by tests/test_architecture.py).
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.core"
    label = "core"
    verbose_name = "Platform reliability"

    def ready(self):
        from django.utils.module_loading import autodiscover_modules

        from . import checks  # noqa: F401  (registers system checks)

        # Each app may declare ``outbox_handlers.py`` with @outbox_handler(...)
        # functions; importing them here fills the registry in every process
        # (web workers publish, the async worker drains).
        autodiscover_modules("outbox_handlers")
