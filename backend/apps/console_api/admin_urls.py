"""``/api/admin/``: Console Admin workspace API. OWNER: WS-G (after WS-0).

``features/`` routes point at WS-F's ``views_features``; keep their names.
"""

from django.urls import path

from . import views_admin, views_features

urlpatterns = [
    path("attention/", views_admin.AttentionView.as_view(), name="admin-attention"),
    path("search/", views_admin.SearchView.as_view(), name="admin-search"),
    path("features/", views_features.FeatureListView.as_view(), name="admin-features"),
    path("features/<slug:key>/", views_features.FeatureUpdateView.as_view(), name="admin-feature-update"),
    path("requests/", views_admin.RequestsView.as_view(), name="admin-requests"),
    path("requests/actions/", views_admin.RequestActionsView.as_view(), name="admin-requests-actions"),
    path("recordings/", views_admin.RecordingsView.as_view(), name="admin-recordings"),
    path("recordings/<str:item_id>/", views_admin.RecordingDetailView.as_view(), name="admin-recording-detail"),
    path("recordings/<str:item_id>/actions/", views_admin.RecordingActionView.as_view(), name="admin-recording-actions"),
    path("system/health/", views_admin.HealthView.as_view(), name="admin-health"),
    path("system/health/retry/", views_admin.HealthRetryView.as_view(), name="admin-health-retry"),
    path("activity/", views_admin.ActivityView.as_view(), name="admin-activity"),
]
