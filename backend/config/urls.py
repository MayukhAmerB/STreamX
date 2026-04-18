from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

from config.health import liveness_view, metrics_view, readiness_view

admin.site.enable_nav_sidebar = False

urlpatterns = [
    path("admin/", admin.site.urls),
    path("health/live", liveness_view, name="health-live"),
    path("health/ready", readiness_view, name="health-ready"),
    path("health/metrics", metrics_view, name="health-metrics"),
    path("healthz", liveness_view, name="healthz"),
    path("readyz", readiness_view, name="readyz"),
    path("metrics", metrics_view, name="metrics"),
    path("api/auth/", include("apps.users.urls")),
    path("api/notifications/", include("apps.notifications.urls")),
    path("api/realtime/", include("apps.realtime.urls")),
    path("api/", include("apps.courses.urls")),
    path("api/payment/", include("apps.payments.urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
