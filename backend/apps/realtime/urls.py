from django.urls import path

from .views import (
    RealtimeOwncastChatBridgeView,
    RealtimeSessionBrowserRecordingUploadView,
    RealtimeSessionDetailView,
    RealtimeSessionEndView,
    RealtimeSessionHostTokenView,
    RealtimeSessionJoinView,
    RealtimeSessionListCreateView,
    RealtimeSessionRecordingListView,
    RealtimeSessionRecordingDownloadView,
    RealtimeSessionRecordingDeleteView,
    RealtimeSessionRecordingStartView,
    RealtimeSessionRecordingStopView,
    RealtimeSessionPresenterPermissionView,
    RealtimeSessionSpeakerPermissionView,
    RealtimeSessionStreamStartView,
    RealtimeSessionStreamStopView,
    RealtimeSessionStreamRotateKeyView,
    RealtimeSessionOwncastChatLaunchView,
    RealtimeSessionOwncastChatModerationView,
)

urlpatterns = [
    path("sessions/", RealtimeSessionListCreateView.as_view(), name="realtime-session-list-create"),
    path("sessions/<int:pk>/", RealtimeSessionDetailView.as_view(), name="realtime-session-detail"),
    path("sessions/<int:pk>/join/", RealtimeSessionJoinView.as_view(), name="realtime-session-join"),
    path(
        "sessions/<int:pk>/broadcast-chat/launch/",
        RealtimeSessionOwncastChatLaunchView.as_view(),
        name="realtime-session-owncast-chat-launch",
    ),
    path(
        "sessions/<int:pk>/broadcast-chat/moderation/",
        RealtimeSessionOwncastChatModerationView.as_view(),
        name="realtime-session-owncast-chat-moderation",
    ),
    path("sessions/<int:pk>/host-token/", RealtimeSessionHostTokenView.as_view(), name="realtime-session-host-token"),
    path(
        "owncast/chat-bridge/",
        RealtimeOwncastChatBridgeView.as_view(),
        name="realtime-owncast-chat-bridge",
    ),
    path("sessions/<int:pk>/stream/start/", RealtimeSessionStreamStartView.as_view(), name="realtime-session-stream-start"),
    path("sessions/<int:pk>/stream/stop/", RealtimeSessionStreamStopView.as_view(), name="realtime-session-stream-stop"),
    path(
        "sessions/<int:pk>/stream/rotate-key/",
        RealtimeSessionStreamRotateKeyView.as_view(),
        name="realtime-session-stream-rotate-key",
    ),
    path(
        "sessions/<int:pk>/recordings/",
        RealtimeSessionRecordingListView.as_view(),
        name="realtime-session-recording-list",
    ),
    path(
        "recordings/<int:recording_id>/download/",
        RealtimeSessionRecordingDownloadView.as_view(),
        name="realtime-session-recording-download",
    ),
    path(
        "recordings/<int:recording_id>/",
        RealtimeSessionRecordingDeleteView.as_view(),
        name="realtime-session-recording-delete",
    ),
    path(
        "sessions/<int:pk>/recordings/start/",
        RealtimeSessionRecordingStartView.as_view(),
        name="realtime-session-recording-start",
    ),
    path(
        "sessions/<int:pk>/recordings/stop/",
        RealtimeSessionRecordingStopView.as_view(),
        name="realtime-session-recording-stop",
    ),
    path(
        "sessions/<int:pk>/recordings/browser-upload/",
        RealtimeSessionBrowserRecordingUploadView.as_view(),
        name="realtime-session-recording-browser-upload",
    ),
    path("sessions/<int:pk>/end/", RealtimeSessionEndView.as_view(), name="realtime-session-end"),
    path(
        "sessions/<int:pk>/presenters/<str:permission_action>/",
        RealtimeSessionPresenterPermissionView.as_view(),
        name="realtime-session-presenter-permission",
    ),
    path(
        "sessions/<int:pk>/speakers/<str:permission_action>/",
        RealtimeSessionSpeakerPermissionView.as_view(),
        name="realtime-session-speaker-permission",
    ),
]
