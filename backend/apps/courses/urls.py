from django.urls import path

from .views import (
    CourseDetailView,
    CourseEnrollView,
    CourseListCreateView,
    CourseThumbnailView,
    InstructorCoursesView,
    LectureCreateView,
    LectureDetailView,
    LectureProgressView,
    LectureProtectedMediaView,
    LectureVideoView,
    LiveClassEnrollView,
    LiveClassListView,
    MyCoursesView,
    PublicEnrollmentLeadCreateView,
    SectionCreateView,
    SectionDetailView,
)

urlpatterns = [
    path("courses/", CourseListCreateView.as_view(), name="course-list-create"),
    path("courses/<int:pk>/", CourseDetailView.as_view(), name="course-detail"),
    path("courses/<int:pk>/thumbnail/", CourseThumbnailView.as_view(), name="course-thumbnail"),
    path("courses/enroll/", CourseEnrollView.as_view(), name="course-enroll"),
    path("sections/", SectionCreateView.as_view(), name="section-create"),
    path("sections/<int:pk>/", SectionDetailView.as_view(), name="section-detail"),
    path("lectures/", LectureCreateView.as_view(), name="lecture-create"),
    path("lectures/<int:pk>/", LectureDetailView.as_view(), name="lecture-detail"),
    path("lectures/<int:pk>/video/", LectureVideoView.as_view(), name="lecture-video"),
    path("lectures/<int:pk>/progress/", LectureProgressView.as_view(), name="lecture-progress"),
    path(
        "lectures/<int:pk>/playback/<str:token>/<path:asset_path>",
        LectureProtectedMediaView.as_view(),
        name="lecture-playback-asset",
    ),
    path("live-classes/", LiveClassListView.as_view(), name="live-class-list"),
    path("live-classes/enroll/", LiveClassEnrollView.as_view(), name="live-class-enroll"),
    path("enrollment-leads/", PublicEnrollmentLeadCreateView.as_view(), name="public-enrollment-lead-create"),
    path("my-courses/", MyCoursesView.as_view(), name="my-courses"),
    path("instructor/courses/", InstructorCoursesView.as_view(), name="instructor-courses"),
]
