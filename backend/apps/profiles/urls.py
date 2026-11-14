from django.urls import path

from . import views

urlpatterns = [
    path("me/", views.MyProfileView.as_view(), name="profiles-me"),
    path("me/draft/", views.MyDraftView.as_view(), name="profiles-me-draft"),
    path("me/publish/", views.MyPublishView.as_view(), name="profiles-me-publish"),
    path("me/unpublish/", views.MyUnpublishView.as_view(), name="profiles-me-unpublish"),
    path("me/settings/", views.MySettingsView.as_view(), name="profiles-me-settings"),
    path("me/handle/", views.MyHandleView.as_view(), name="profiles-me-handle"),
    path("me/handle/prompt/dismiss/", views.MyHandlePromptDismissView.as_view(), name="profiles-me-handle-prompt-dismiss"),
    path("me/preview/", views.MyPreviewView.as_view(), name="profiles-me-preview"),
    path("me/images/", views.MyImagesView.as_view(), name="profiles-me-images"),
    path("me/images/<uuid:image_id>/", views.MyImageDetailView.as_view(), name="profiles-me-image-detail"),
    path("u/<str:handle>/", views.PublicProfileView.as_view(), name="profiles-public"),
    path("u/<str:handle>/report/", views.ReportProfileView.as_view(), name="profiles-report"),
    path("media/<uuid:image_id>/", views.ProfileMediaView.as_view(), name="profiles-media"),
    path("moderation/reports/", views.ModerationReportsView.as_view(), name="profiles-moderation-reports"),
    path("moderation/reports/<int:report_id>/dismiss/", views.ModerationDismissView.as_view(), name="profiles-moderation-dismiss"),
    path("moderation/profiles/<str:handle>/hide/", views.ModerationHideView.as_view(), name="profiles-moderation-hide"),
    path("moderation/profiles/<str:handle>/restore/", views.ModerationRestoreView.as_view(), name="profiles-moderation-restore"),
]
