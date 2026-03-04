from django.urls import path

from .views import (
    RealtimeSessionDetailView,
    RealtimeSessionEndView,
    RealtimeSessionHostTokenView,
    RealtimeSessionJoinView,
    RealtimeSessionListCreateView,
    RealtimeSessionPresenterPermissionView,
    RealtimeSessionStreamStartView,
    RealtimeSessionStreamStopView,
)

urlpatterns = [
    path("sessions/", RealtimeSessionListCreateView.as_view(), name="realtime-session-list-create"),
    path("sessions/<int:pk>/", RealtimeSessionDetailView.as_view(), name="realtime-session-detail"),
    path("sessions/<int:pk>/join/", RealtimeSessionJoinView.as_view(), name="realtime-session-join"),
    path("sessions/<int:pk>/host-token/", RealtimeSessionHostTokenView.as_view(), name="realtime-session-host-token"),
    path("sessions/<int:pk>/stream/start/", RealtimeSessionStreamStartView.as_view(), name="realtime-session-stream-start"),
    path("sessions/<int:pk>/stream/stop/", RealtimeSessionStreamStopView.as_view(), name="realtime-session-stream-stop"),
    path("sessions/<int:pk>/end/", RealtimeSessionEndView.as_view(), name="realtime-session-end"),
    path(
        "sessions/<int:pk>/presenters/<str:permission_action>/",
        RealtimeSessionPresenterPermissionView.as_view(),
        name="realtime-session-presenter-permission",
    ),
]
