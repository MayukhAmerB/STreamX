from django.urls import path

from .recording.views import (
    ClassRecordingObsUploadView,
    ClassRecordingRetryView,
    ModuleOptionsView,
    SessionClassRecordingListView,
    SessionObsUploadView,
)

from .views import (
    RealtimeOwncastChatBridgeView,
    RealtimeOwncastStreamAccessView,
    RealtimeOwncastStreamBridgeView,
    RealtimeSessionBrowserRecordingUploadView,
    RealtimeSessionBroadcastPlaybackIssueView,
    RealtimeSessionConnectionEventView,
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
    RealtimeSessionStreamHeartbeatView,
    RealtimeSessionStreamStartView,
    RealtimeSessionStreamStopView,
    RealtimeSessionStreamRotateKeyView,
    RealtimeSessionOwncastChatLaunchView,
    RealtimeSessionOwncastChatModerationView,
    RealtimeSessionOwncastStreamLaunchView,
)

urlpatterns = [
    path("sessions/", RealtimeSessionListCreateView.as_view(), name="realtime-session-list-create"),
    path("sessions/<int:pk>/", RealtimeSessionDetailView.as_view(), name="realtime-session-detail"),
    path("sessions/<int:pk>/join/", RealtimeSessionJoinView.as_view(), name="realtime-session-join"),
    path(
        "sessions/<int:pk>/connection-events/",
        RealtimeSessionConnectionEventView.as_view(),
        name="realtime-session-connection-event",
    ),
    path(
        "sessions/<int:pk>/broadcast-playback/issues/",
        RealtimeSessionBroadcastPlaybackIssueView.as_view(),
        name="realtime-session-broadcast-playback-issue",
    ),
    path(
        "sessions/<int:pk>/broadcast-chat/launch/",
        RealtimeSessionOwncastChatLaunchView.as_view(),
        name="realtime-session-owncast-chat-launch",
    ),
    path(
        "sessions/<int:pk>/broadcast-stream/launch/",
        RealtimeSessionOwncastStreamLaunchView.as_view(),
        name="realtime-session-owncast-stream-launch",
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
    path(
        "owncast/stream-bridge/",
        RealtimeOwncastStreamBridgeView.as_view(),
        name="realtime-owncast-stream-bridge",
    ),
    path(
        "owncast/stream-access/",
        RealtimeOwncastStreamAccessView.as_view(),
        name="realtime-owncast-stream-access",
    ),
    path("sessions/<int:pk>/stream/start/", RealtimeSessionStreamStartView.as_view(), name="realtime-session-stream-start"),
    path("sessions/<int:pk>/stream/stop/", RealtimeSessionStreamStopView.as_view(), name="realtime-session-stream-stop"),
    path(
        "sessions/<int:pk>/stream/heartbeat/",
        RealtimeSessionStreamHeartbeatView.as_view(),
        name="realtime-session-stream-heartbeat",
    ),
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
    path("module-options/", ModuleOptionsView.as_view(), name="realtime-module-options"),
    path(
        "sessions/<int:pk>/class-recordings/",
        SessionClassRecordingListView.as_view(),
        name="realtime-session-class-recordings",
    ),
    path(
        "sessions/<int:pk>/class-recordings/obs-upload/",
        SessionObsUploadView.as_view(),
        name="realtime-session-class-recording-obs-upload",
    ),
    path(
        "class-recordings/<int:recording_id>/obs-upload/",
        ClassRecordingObsUploadView.as_view(),
        name="realtime-class-recording-obs-upload",
    ),
    path(
        "class-recordings/<int:recording_id>/retry/",
        ClassRecordingRetryView.as_view(),
        name="realtime-class-recording-retry",
    ),
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
