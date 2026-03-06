import os
from django.core.wsgi import get_wsgi_application

default_settings_module = "config.settings.prod" if os.getenv("APP_ENV", "").lower() in {"prod", "production"} else "config.settings.dev"
os.environ.setdefault("DJANGO_SETTINGS_MODULE", default_settings_module)
application = get_wsgi_application()
