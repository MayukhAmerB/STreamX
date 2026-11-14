"""Unified gradebook API, mounted at ``/api/gradebook/``."""

from django.urls import path

from . import gradebook_views as views

urlpatterns = [
    path("me/", views.MyGradebookView.as_view(), name="gradebook-me"),
    path("courses/", views.GradebookCourseListView.as_view(), name="gradebook-courses"),
    path("courses/<int:course_id>/", views.BatchGradebookView.as_view(), name="gradebook-course"),
    path("courses/<int:course_id>/export.csv", views.BatchGradebookCsvView.as_view(), name="gradebook-course-csv"),
    path("students/<int:student_id>/", views.StudentGradebookView.as_view(), name="gradebook-student"),
]
