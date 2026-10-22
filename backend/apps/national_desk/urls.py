from django.urls import path

from .views import NationalDeskView

urlpatterns = [
    path("", NationalDeskView.as_view(), name="national-desk-content"),
]
