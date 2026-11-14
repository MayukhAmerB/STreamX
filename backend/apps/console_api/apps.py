from django.apps import AppConfig


class ConsoleApiConfig(AppConfig):
    """Read-mostly endpoints for the Console Learn/Teach/Admin workspaces.

    UI overhaul plan §3-§4. ``/api/console/`` (urls.py: Home "today") and
    ``/api/admin/`` (admin_urls.py: attention, search, features, requests,
    recordings, health). No models: every endpoint composes services owned by
    the domain apps. Files are pre-split by owner (plan §7.2):

    - ``today.py``, ``views_today.py``                      → WS-C
    - ``attention.py``, ``search.py``, ``views_admin.py``,
      ``requests.py``, ``recordings.py``, ``health.py``,
      ``admin_urls.py``                                     → WS-G
    - ``views_features.py``                                 → WS-F
    - ``urls.py``, ``permissions.py``, ``contract_fixtures.py`` → frozen (WS-0)
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.console_api"
    label = "console_api"
    verbose_name = "Console API"
