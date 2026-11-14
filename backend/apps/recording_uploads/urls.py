from django.urls import path

from . import views

urlpatterns = [
    path("", views.UploadListCreateView.as_view(), name="recording-uploads"),
    path("targets/", views.UploadTargetsView.as_view(), name="recording-upload-targets"),
    path("tokens/", views.UploadTokenListCreateView.as_view(), name="recording-upload-tokens"),
    path("tokens/<int:token_id>/", views.UploadTokenRevokeView.as_view(), name="recording-upload-token-detail"),
    path("<uuid:upload_id>/", views.UploadDetailView.as_view(), name="recording-upload-detail"),
    path("<uuid:upload_id>/chunks/<int:index>/", views.UploadChunkView.as_view(), name="recording-upload-chunk"),
    path("<uuid:upload_id>/complete/", views.UploadCompleteView.as_view(), name="recording-upload-complete"),
    path("<uuid:upload_id>/switch-video/", views.UploadSwitchVideoView.as_view(), name="recording-upload-switch-video"),
]
