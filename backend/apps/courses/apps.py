from django.apps import AppConfig


class CoursesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.courses"
    label = "courses"

    def ready(self):
        # Register cache invalidation for catalog data derived from related models.
        from . import signals  # noqa: F401
