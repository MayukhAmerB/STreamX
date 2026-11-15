from django.urls import path

from . import certificate_views, journey, views

urlpatterns = [
    path("me/", views.MeView.as_view(), name="engagement-me"),
    path("me/history/", views.RewardHistoryView.as_view(), name="engagement-me-history"),
    path("me/highlights/", views.RewardHighlightsView.as_view(), name="engagement-me-highlights"),
    path("me/level-seen/", views.LevelSeenView.as_view(), name="engagement-level-seen"),
    # The level-up celebration's "seen" marker (same idempotent acknowledgement).
    path("me/promotion-seen/", views.PromotionSeenView.as_view(), name="engagement-promotion-seen"),
    path("levels/", views.LevelChartView.as_view(), name="engagement-levels"),
    path("journey/", journey.JourneyView.as_view(), name="engagement-journey"),
    path("journey/dismiss/", journey.JourneyDismissView.as_view(), name="engagement-journey-dismiss"),
    path("leaderboard/", views.LeaderboardView.as_view(), name="engagement-leaderboard"),
    path("settings/", views.SettingsView.as_view(), name="engagement-settings"),
    path("badges/", views.BadgeCatalogueView.as_view(), name="engagement-badges"),
    path("achievements/", views.MyAchievementsView.as_view(), name="engagement-achievements"),
    path("achievements/<str:slug>/", views.AchievementVerifyView.as_view(), name="engagement-achievement-verify"),
    path("achievements/<str:slug>/card.png", views.AchievementCardView.as_view(), name="engagement-achievement-card"),
    path(
        "achievements/<str:slug>/certificate.pdf",
        views.AchievementCertificateView.as_view(),
        name="engagement-achievement-certificate",
    ),
    path("live/<int:session_id>/presence/", views.LivePresenceView.as_view(), name="engagement-live-presence"),
    path("staff/leaderboard/", views.StaffLeaderboardView.as_view(), name="engagement-staff-leaderboard"),
    path("staff/xp/", views.StaffXpAwardView.as_view(), name="engagement-staff-xp-award"),
    path("staff/xp/<int:event_id>/revoke/", views.StaffXpRevokeView.as_view(), name="engagement-staff-xp-revoke"),
    path("staff/badges/", views.StaffBadgeView.as_view(), name="engagement-staff-badges"),
]

# Verifiable certificates (certificate_views.py). Public routes work whatever the switch says.

urlpatterns += [
    path("certificates/<str:ref>/", certificate_views.CertificateView.as_view(), name="engagement-certificate"),
    path("certificates/<str:ref>/certificate.pdf", certificate_views.CertificatePdfView.as_view(), name="engagement-certificate-pdf"),
    path("certificates/<str:ref>/certificate.png", certificate_views.CertificatePngView.as_view(), name="engagement-certificate-png"),
    path("certificates/<str:ref>/preview.png", certificate_views.CertificateOgView.as_view(), name="engagement-certificate-og"),
    path("certificates/<str:ref>/share/", certificate_views.CertificateShareView.as_view(), name="engagement-certificate-share"),
    path("staff/certificates/<str:ref>/", certificate_views.StaffCertificateView.as_view(), name="engagement-staff-certificate"),
    path(
        "staff/certificates/<str:ref>/correct-name/",
        certificate_views.StaffCertificateNameView.as_view(),
        name="engagement-staff-certificate-name",
    ),
    path(
        "staff/certificates/<str:ref>/revoke/",
        certificate_views.StaffCertificateRevokeView.as_view(),
        name="engagement-staff-certificate-revoke",
    ),
    path(
        "staff/certificates/<str:ref>/reinstate/",
        certificate_views.StaffCertificateReinstateView.as_view(),
        name="engagement-staff-certificate-reinstate",
    ),
]
