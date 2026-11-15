from django.urls import path

from . import views

urlpatterns = [
    path("exams/", views.ExamListView.as_view(), name="ctf-exams"),
    path("exams/<slug:slug>/", views.ExamDetailView.as_view(), name="ctf-exam-detail"),
    path("exams/<slug:slug>/start/", views.ExamStartView.as_view(), name="ctf-exam-start"),
    path(
        "exams/<slug:slug>/questions/<slug:key>/attempts/",
        views.AttemptCreateView.as_view(),
        name="ctf-question-attempts",
    ),
    path("exams/<slug:slug>/submit/", views.ExamSubmitView.as_view(), name="ctf-exam-submit"),
]
