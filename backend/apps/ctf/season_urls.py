from django.urls import path

from . import season_views as views

urlpatterns = [
    path("current/", views.CurrentSeasonView.as_view(), name="ctf-season-current"),
    path("me/", views.MySeasonSummaryView.as_view(), name="ctf-season-me"),
    path("cosmetics/", views.CosmeticsView.as_view(), name="ctf-season-cosmetics"),
    path("hall-of-fame/", views.HallOfFameView.as_view(), name="ctf-season-hall-of-fame"),
    path("certificates/<str:slug>/", views.CertificateView.as_view(), name="ctf-season-certificate"),
    path("<slug:slug>/", views.SeasonDetailView.as_view(), name="ctf-season-detail"),
    path("<slug:slug>/leaderboard/", views.SeasonLeaderboardView.as_view(), name="ctf-season-leaderboard"),
    path("<slug:slug>/submit/", views.SeasonSubmitView.as_view(), name="ctf-season-submit"),
]
