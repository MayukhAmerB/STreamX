from django.urls import path

from . import views

urlpatterns = [
    path("reset/", views.reset_view, name="e2e-reset"),
    path("manifest/", views.manifest_view, name="e2e-manifest"),
    path("clock/", views.clock_view, name="e2e-clock"),
    path("tick/", views.tick_view, name="e2e-tick"),
    path("sessions/<int:session_id>/expire-host-heartbeat/", views.expire_host_heartbeat_view, name="e2e-expire-heartbeat"),
    path("sessions/<int:session_id>/state/", views.session_state_view, name="e2e-session-state"),
]
urlpatterns.append(path("fixture/<slug:name>/", views.fixture_view, name="e2e-fixture"))
