from django.urls import path

from .views import YouTubeChannelView

urlpatterns = [
    path("youtube/", YouTubeChannelView.as_view(), name="site-youtube"),
]
