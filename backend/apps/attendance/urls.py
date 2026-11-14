"""``/api/attendance/``"""

from django.urls import path

from . import views

urlpatterns = [
    path("sessions/<int:session_id>/presence/", views.PresenceView.as_view(), name="attendance-presence"),
    path("sessions/<int:session_id>/leave/", views.LeaveView.as_view(), name="attendance-leave"),
    path("me/summary/", views.MySummaryView.as_view(), name="attendance-my-summary"),
    path("me/classes/", views.MyClassesView.as_view(), name="attendance-my-classes"),
    path("staff/courses/", views.StaffCoursesView.as_view(), name="attendance-staff-courses"),
    path("staff/sessions/", views.StaffSessionsView.as_view(), name="attendance-staff-sessions"),
    path("staff/sessions/<int:session_id>/roster/", views.StaffRosterView.as_view(), name="attendance-staff-roster"),
    path("staff/sessions/<int:session_id>/override/", views.StaffOverrideView.as_view(), name="attendance-staff-override"),
    path("staff/matrix/", views.StaffMatrixView.as_view(), name="attendance-staff-matrix"),
    path("staff/low-attendance/", views.StaffLowAttendanceView.as_view(), name="attendance-staff-low"),
    path("staff/policy/", views.StaffPolicyView.as_view(), name="attendance-staff-policy"),
]
