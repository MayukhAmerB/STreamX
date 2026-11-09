import os

from django.conf import settings
from django.contrib.staticfiles.storage import staticfiles_storage
from django.core.management.base import BaseCommand, CommandError
from django.test import Client

REQUIRED_ASSETS = (
    "admin/css/base.css",
    "admin/css/login.css",
    "admin/css/enterprise.css",
    "admin/js/theme.js",
)


class Command(BaseCommand):
    help = (
        "Fail unless the admin's static assets are listed in the manifest, present on disk, "
        "and served with HTTP 200 by this process's middleware."
    )

    def handle(self, *args, **options):
        errors = []
        if not settings.DEBUG and not any("whitenoise" in item for item in settings.MIDDLEWARE):
            errors.append("WhiteNoise middleware is not enabled.")
        host = next(
            (h for h in settings.ALLOWED_HOSTS if h and "*" not in h and not h.startswith(".")),
            "localhost",
        )
        client = Client(HTTP_HOST=host)
        for name in REQUIRED_ASSETS:
            try:
                url = staticfiles_storage.url(name)
                path = staticfiles_storage.path(staticfiles_storage.stored_name(name))
            except Exception as exc:
                errors.append(f"{name}: not in the manifest ({exc})")
                continue
            if not os.path.isfile(path):
                errors.append(f"{name}: {path} is missing on disk")
                continue
            response = client.get(url, secure=True)
            if response.status_code != 200:
                errors.append(f"{name}: {url} returned HTTP {response.status_code}")

        if errors:
            raise CommandError("Static files are not servable:\n- " + "\n- ".join(errors))
        self.stdout.write("Static files verified.")
