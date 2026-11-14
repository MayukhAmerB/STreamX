from django.urls import path

from .views import SiteStatsView, YouTubeChannelView

urlpatterns = [
    path("youtube/", YouTubeChannelView.as_view(), name="site-youtube"),
    path("stats/", SiteStatsView.as_view(), name="site-stats"),
]
