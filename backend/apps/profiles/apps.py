from django.apps import AppConfig


class ProfilesConfig(AppConfig):
    """Public student profiles (``/u/<handle>``) with a server-side PII guard."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.profiles"
    label = "profiles"
    verbose_name = "Student profiles"

    def ready(self):
        from . import signals  # noqa: F401  (new students get an automatic handle)
