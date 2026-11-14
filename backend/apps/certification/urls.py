from django.urls import path

from . import views

urlpatterns = [
    path("hall-of-fame/", views.HallOfFameView.as_view(), name="certification-hall-of-fame"),
    path("me/", views.MyCertificationsView.as_view(), name="certification-me"),
    path("me/preferences/", views.MyPreferencesView.as_view(), name="certification-preferences"),
    path("me/letters/<str:ref>/", views.MyLetterView.as_view(), name="certification-letter"),
    path("staff/decisions/<int:pk>/", views.StaffDecisionView.as_view(), name="certification-staff-decision"),
    path(
        "staff/decisions/<int:pk>/confirm-revocation/",
        views.StaffConfirmRevocationView.as_view(),
        name="certification-staff-confirm-revocation",
    ),
    path(
        "staff/decisions/<int:pk>/dismiss-revocation/",
        views.StaffDismissRevocationView.as_view(),
        name="certification-staff-dismiss-revocation",
    ),
    path("staff/deliveries/<int:pk>/resend/", views.StaffResendView.as_view(), name="certification-staff-resend"),
    path("staff/exams/<slug:slug>/regrade/", views.StaffRegradeView.as_view(), name="certification-staff-regrade"),
    path("staff/hall-of-fame/<int:pk>/hide/", views.StaffHallOfFameHideView.as_view(), name="certification-staff-hof-hide"),
    path(
        "staff/hall-of-fame/<int:pk>/restore/",
        views.StaffHallOfFameRestoreView.as_view(),
        name="certification-staff-hof-restore",
    ),
    path(
        "staff/hall-of-fame/<int:pk>/handle/",
        views.StaffHallOfFameHandleView.as_view(),
        name="certification-staff-hof-handle",
    ),
]
