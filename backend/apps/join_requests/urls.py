from django.urls import path

from .views import JoinApplicationCreateView, JoinLocationDirectoryView

urlpatterns = [
    path("locations/", JoinLocationDirectoryView.as_view(), name="join-location-directory"),
    path("applications/", JoinApplicationCreateView.as_view(), name="join-application-create"),
]
