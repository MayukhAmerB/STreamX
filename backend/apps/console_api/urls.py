"""``/api/console/``: Console workspace data. FROZEN after WS-0 (plan §7.2)."""

from django.urls import path

from . import views_today

urlpatterns = [
    path("today/", views_today.TodayView.as_view(), name="console-today"),
]
