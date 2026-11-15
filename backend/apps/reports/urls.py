from django.urls import path

from . import views

urlpatterns = [
    # Students
    path("tasks/", views.StudentTaskListView.as_view(), name="reports-tasks"),
    path("tasks/<int:task_id>/", views.StudentTaskDetailView.as_view(), name="reports-task-detail"),
    path("tasks/<int:task_id>/uploads/", views.StudentUploadView.as_view(), name="reports-task-uploads"),
    path(
        "tasks/<int:task_id>/uploads/<int:file_id>/",
        views.StudentUploadDeleteView.as_view(),
        name="reports-task-upload-delete",
    ),
    path("tasks/<int:task_id>/submit/", views.StudentSubmitView.as_view(), name="reports-task-submit"),
    path("marks/", views.MyMarksView.as_view(), name="reports-my-marks"),
    # Private file downloads (owner, course instructor, staff)
    path("files/<int:file_id>/download/", views.SubmissionFileDownloadView.as_view(), name="reports-file-download"),
    path(
        "attachments/<int:attachment_id>/download/",
        views.AttachmentDownloadView.as_view(),
        name="reports-attachment-download",
    ),
    path(
        "feedback-files/<int:submission_id>/download/",
        views.FeedbackFileDownloadView.as_view(),
        name="reports-feedback-file-download",
    ),
    # Graders (course instructor or admin)
    path("manage/courses/", views.GradableCoursesView.as_view(), name="reports-manage-courses"),
    path("manage/tasks/", views.ManageTaskListView.as_view(), name="reports-manage-tasks"),
    path("manage/tasks/<int:task_id>/", views.ManageTaskDetailView.as_view(), name="reports-manage-task-detail"),
    path("manage/tasks/<int:task_id>/publish/", views.PublishTaskView.as_view(), name="reports-manage-task-publish"),
    path("manage/tasks/<int:task_id>/close/", views.CloseTaskView.as_view(), name="reports-manage-task-close"),
    path("manage/tasks/<int:task_id>/reopen/", views.ReopenTaskView.as_view(), name="reports-manage-task-reopen"),
    path(
        "manage/tasks/<int:task_id>/release-marks/",
        views.ReleaseMarksView.as_view(),
        name="reports-manage-task-release-marks",
    ),
    path(
        "manage/tasks/<int:task_id>/duplicate/",
        views.DuplicateTaskView.as_view(),
        name="reports-manage-task-duplicate",
    ),
    path(
        "manage/tasks/<int:task_id>/attachments/",
        views.TaskAttachmentUploadView.as_view(),
        name="reports-manage-task-attachments",
    ),
    path(
        "manage/tasks/<int:task_id>/download.zip",
        views.TaskZipDownloadView.as_view(),
        name="reports-manage-task-zip",
    ),
    path(
        "manage/attachments/<int:attachment_id>/",
        views.TaskAttachmentDeleteView.as_view(),
        name="reports-manage-attachment-delete",
    ),
    path("manage/submissions/", views.SubmissionQueueView.as_view(), name="reports-manage-submissions"),
    path(
        "manage/submissions/<int:submission_id>/",
        views.SubmissionDetailView.as_view(),
        name="reports-manage-submission-detail",
    ),
    path(
        "manage/submissions/<int:submission_id>/grade/",
        views.GradeSubmissionView.as_view(),
        name="reports-manage-submission-grade",
    ),
    path("manage/gradebook/", views.GradebookView.as_view(), name="reports-manage-gradebook"),
    path("manage/export.csv", views.MarksExportView.as_view(), name="reports-manage-export"),
]
