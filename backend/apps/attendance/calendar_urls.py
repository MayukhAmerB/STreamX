"""``/api/calendar/``"""

from django.urls import path

from . import calendar_views as views

urlpatterns = [
    path("me/events/", views.MyEventsView.as_view(), name="calendar-my-events"),
    path("me/feed/", views.MyFeedView.as_view(), name="calendar-my-feed"),
    path("feed/<str:token>.ics", views.FeedView.as_view(), name="calendar-feed"),
    path("public/upcoming/", views.PublicUpcomingView.as_view(), name="calendar-public-upcoming"),
    path("staff/events/", views.StaffEventsView.as_view(), name="calendar-staff-events"),
    path("staff/options/", views.StaffOptionsView.as_view(), name="calendar-staff-options"),
    path("staff/schedules/", views.StaffSchedulesView.as_view(), name="calendar-staff-schedules"),
    path("staff/schedules/preview/", views.StaffSchedulePreviewView.as_view(), name="calendar-staff-schedule-preview"),
    path("staff/schedules/<int:schedule_id>/", views.StaffScheduleDetailView.as_view(), name="calendar-staff-schedule"),
    path(
        "staff/schedules/<int:schedule_id>/exceptions/",
        views.StaffScheduleExceptionsView.as_view(),
        name="calendar-staff-schedule-exceptions",
    ),
    path("staff/exceptions/<int:exception_id>/", views.StaffExceptionDetailView.as_view(), name="calendar-staff-exception"),
]
