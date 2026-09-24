from django.urls import path

from .views import SocialAccountDirectoryView

urlpatterns = [
    path("", SocialAccountDirectoryView.as_view(), name="social-account-directory"),
]
