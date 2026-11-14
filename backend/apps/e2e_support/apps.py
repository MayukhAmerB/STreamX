import os

from django.apps import AppConfig
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured


def e2e_allowed() -> bool:
    """The only switch every e2e_support entry point checks."""
    return bool(getattr(settings, "E2E_ENABLED", False)) and os.environ.get("E2E", "").strip() == "1"


class E2ESupportConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.e2e_support"
    label = "e2e_support"
    verbose_name = "End-to-end test support"

    def ready(self):
        if not e2e_allowed():
            raise ImproperlyConfigured("apps.e2e_support is only for config.settings.e2e with E2E=1.")
        from . import fakes

        fakes.install_youtube_fixture()
