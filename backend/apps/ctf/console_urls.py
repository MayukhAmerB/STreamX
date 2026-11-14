"""Console -> Exams API, mounted at ``/api/ctf-admin/`` (not ``/api/ctf/``,
which the labs origin may call; see ``console_views.py``)."""

from django.urls import path

from . import console_views as views

urlpatterns = [
    path("summary/", views.ConsoleSummaryView.as_view(), name="ctf-admin-summary"),
    path("batches/", views.ConsoleBatchListView.as_view(), name="ctf-admin-batches"),
    path("exams/", views.ConsoleExamListView.as_view(), name="ctf-admin-exams"),
    path("exams/preview/", views.ConsoleExamPreviewView.as_view(), name="ctf-admin-exam-preview"),
    path("exams/upload/", views.ConsoleExamUploadView.as_view(), name="ctf-admin-exam-upload"),
    path("exams/<slug:slug>/", views.ConsoleExamDetailView.as_view(), name="ctf-admin-exam-detail"),
    path("exams/<slug:slug>/publish/", views.ConsoleExamPublishView.as_view(), name="ctf-admin-exam-publish"),
    path("exams/<slug:slug>/unschedule/", views.ConsoleExamUnscheduleView.as_view(), name="ctf-admin-exam-unschedule"),
    path("exams/<slug:slug>/close/", views.ConsoleExamCloseView.as_view(), name="ctf-admin-exam-close"),
    path("exams/<slug:slug>/results/", views.ConsoleExamResultsView.as_view(), name="ctf-admin-exam-results"),
    path("exams/<slug:slug>/results.csv", views.ConsoleExamResultsCsvView.as_view(), name="ctf-admin-exam-results-csv"),
    path("exams/<slug:slug>/materials/", views.ConsoleMaterialUploadView.as_view(), name="ctf-admin-exam-materials"),
    path(
        "exams/<slug:slug>/materials/<int:material_id>/",
        views.ConsoleMaterialDeleteView.as_view(),
        name="ctf-admin-exam-material",
    ),
]
