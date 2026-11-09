"""Admin analytics dashboard: an HTML shell plus the JSON it renders.

Both views go through admin.site.admin_view, so anonymous visitors are sent to
the admin login and CSRF/session handling matches the rest of the admin. Only
superusers may open them because the payload includes revenue. Prometheus is
queried server-side; the browser only ever talks to these views.
"""

from django.contrib import admin
from django.core.exceptions import PermissionDenied
from django.http import JsonResponse
from django.template.response import TemplateResponse
from django.urls import reverse
from django.views.decorators.http import require_GET

from .dashboard import get_dashboard
from .metrics import DEFAULT_RANGE, RANGE_CHOICES, RANGES

TEMPLATE_NAME = "admin/insights/dashboard.html"


def _require_superuser(request):
    if not request.user.is_superuser:
        raise PermissionDenied


@require_GET
def dashboard_page(request):
    _require_superuser(request)
    context = {
        **admin.site.each_context(request),
        "title": "Dashboard",
        "data_url": reverse("insights-dashboard-data"),
        "default_range": DEFAULT_RANGE,
        "ranges": RANGE_CHOICES,
    }
    return TemplateResponse(request, TEMPLATE_NAME, context)


@require_GET
def dashboard_data(request):
    _require_superuser(request)
    range_key = request.GET.get("range", DEFAULT_RANGE)
    if range_key not in RANGES:
        response = JsonResponse(
            {"error": f"Unsupported range. Use one of: {', '.join(RANGES)}."},
            status=400,
        )
    else:
        response = JsonResponse(get_dashboard(range_key))
    response["Cache-Control"] = "no-store, private"
    return response


dashboard_page_view = admin.site.admin_view(dashboard_page)
# cacheable=True only skips admin_view's never_cache wrapper so the exact
# Cache-Control header set above is preserved; the response is still no-store.
dashboard_data_view = admin.site.admin_view(dashboard_data, cacheable=True)
