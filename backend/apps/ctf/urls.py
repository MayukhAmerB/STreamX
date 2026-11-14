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
    path(
        "exams/<slug:slug>/materials/<int:material_id>/",
        views.MaterialUrlView.as_view(),
        name="ctf-exam-material-url",
    ),
    path("eligibility/", views.EligibilityView.as_view(), name="ctf-eligibility"),
    path("materials/<str:token>/", views.MaterialFileView.as_view(), name="ctf-material-file"),
]
