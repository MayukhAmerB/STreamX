from django.apps import AppConfig


class OsintLabsConfig(AppConfig):
    """Free OSINT challenge directory (link-out catalogue) and labs access.

    * ``OsintChallenge``: metadata for free, server-less OSINT challenges on
      other platforms (we link out, never copy their text, images or answers);
      openly licensed challenges we may host, with the licence and attribution.
    * Labs entitlement endpoints the labs site (OSINTCTF/server.js) uses to
      admit members: ``/api/labs/policy/``, ``/entitlement/``, ``/pass/``.
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.osint_labs"
    label = "osint_labs"
    verbose_name = "Labs and free OSINT challenges"

    def ready(self):
        from django.db.models.signals import post_delete, post_save

        from apps.courses.catalog_api import bump_catalog_version

        from .models import OsintChallenge, OsintPath

        for model in (OsintChallenge, OsintPath):
            post_save.connect(bump_catalog_version, sender=model, dispatch_uid=f"catalog-bump-save-{model.__name__}")
            post_delete.connect(bump_catalog_version, sender=model, dispatch_uid=f"catalog-bump-del-{model.__name__}")
