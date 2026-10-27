from django.urls import path

from .views import JoinApplicationCreateView, JoinFormSettingsView, JoinLocationDirectoryView

urlpatterns = [
    path("locations/", JoinLocationDirectoryView.as_view(), name="join-location-directory"),
    path("settings/", JoinFormSettingsView.as_view(), name="join-form-settings"),
    path("applications/", JoinApplicationCreateView.as_view(), name="join-application-create"),
]
