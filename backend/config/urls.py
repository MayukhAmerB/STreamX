from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

from config.health import liveness_view, metrics_view, readiness_view
from config.schema import AdminOpenAPISchemaView
from apps.campaigns.views import CampaignAdminPageView, CampaignPublicPageView
from apps.console_api.views_features import features_admin_redirect
from apps.insights.views import dashboard_data_view, dashboard_page_view
from apps.realtime.ops_views import ResourceProfileDesiredView, ResourceProfileReportView

admin.site.enable_nav_sidebar = True

urlpatterns = [
    path("admin/admin", CampaignAdminPageView.as_view(), name="campaign-admin-page"),
    path("campaigns/", CampaignPublicPageView.as_view(), name="campaign-public-page"),
    path("admin/dashboard/", dashboard_page_view, name="insights-dashboard"),
    path("admin/dashboard/data/", dashboard_data_view, name="insights-dashboard-data"),
    # UI overhaul: Settings › Features alias (the FeatureFlag changelist).
    path("admin/settings/features/", features_admin_redirect, name="admin-settings-features"),
    path("admin/", admin.site.urls),
    path("health/live", liveness_view, name="health-live"),
    path("health/ready", readiness_view, name="health-ready"),
    path("health/metrics", metrics_view, name="health-metrics"),
    path("healthz", liveness_view, name="healthz"),
    path("readyz", readiness_view, name="readyz"),
    path("metrics", metrics_view, name="metrics"),
    path("api/schema/", AdminOpenAPISchemaView.as_view(), name="openapi-schema"),
    path("api/auth/", include("apps.users.urls")),
    path("api/notifications/", include("apps.notifications.urls")),
    path(
        "api/internal/ops/resource-profile/",
        ResourceProfileDesiredView.as_view(),
        name="ops-resource-profile-desired",
    ),
    path(
        "api/internal/ops/resource-profile/report/",
        ResourceProfileReportView.as_view(),
        name="ops-resource-profile-report",
    ),
    path("api/realtime/", include("apps.realtime.urls")),
    path("api/campaigns/", include("apps.campaigns.urls")),
    path("api/as-accounts/", include("apps.social_accounts.urls")),
    path("api/national-desk/", include("apps.national_desk.urls")),
    path("api/join/", include("apps.join_requests.urls")),
    path("api/reports/", include("apps.reports.urls")),
    path("api/site/", include("apps.site_media.urls")),
    # Free OSINT directory + labs access (apps.osint_labs). Also under /api/ctf/labs/:
    # the labs origin may only call /api/ctf/* cross-origin (config/labs_origin.py).
    path("api/labs/", include("apps.osint_labs.urls")),
    path("api/ctf/labs/", include(("apps.osint_labs.urls", "osint_labs_ctf"), namespace="osint_labs_ctf")),
    path("api/ctf/", include("apps.ctf.urls")),
    # >>> Phase 3: Console exams (staff) and the unified gradebook >>>
    path("api/ctf-admin/", include("apps.ctf.console_urls")),
    path("api/gradebook/", include("apps.ctf.gradebook_urls")),
    # <<< Phase 3 <<<
    # Resumable class recording uploads (Console + desktop OBS uploader).
    path("api/recording-uploads/", include("apps.recording_uploads.urls")),
    # >>> UI overhaul (frozen after WS-0) >>>
    path("api/me/", include("apps.users.me_urls")),
    path("api/console/", include("apps.console_api.urls")),
    path("api/admin/", include("apps.console_api.admin_urls")),
    # <<< UI overhaul <<<
    path("api/", include("apps.courses.urls")),
    path("api/payment/", include("apps.payments.urls")),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# Engagement: XP, streaks, badges, leaderboards, achievements (apps.engagement).
urlpatterns += [path("api/engagement/", include("apps.engagement.urls"))]

# Student profiles: /u/<handle> pages, editor, PII guard, moderation (apps.profiles).
urlpatterns += [path("api/profiles/", include("apps.profiles.urls"))]

# Attendance (live-class presence, rosters, reports) and the class calendar (apps.attendance).
urlpatterns += [
    path("api/attendance/", include("apps.attendance.urls")),
    path("api/calendar/", include("apps.attendance.calendar_urls")),
]

# Automatic certification, certificate delivery and the Hall of Fame (apps.certification).
urlpatterns += [path("api/certification/", include("apps.certification.urls"))]
