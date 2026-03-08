import mimetypes
from pathlib import Path

from django.conf import settings
from django.core.cache import cache
from django.db.models import Count, Prefetch, Q
from django.http import FileResponse, HttpResponse, HttpResponseNotFound
from rest_framework import generics, permissions, status
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from config.audit import log_security_event
from config.pagination import apply_optional_pagination
from config.request_security import find_disallowed_query_params
from config.response import api_response

from apps.payments.models import Payment

from .cache_utils import get_course_list_cache_version, get_live_class_list_cache_version
from .models import Course, Enrollment, Lecture, LectureProgress, LiveClass, LiveClassEnrollment, PublicEnrollmentLead, Section
from .permissions import IsCourseInstructor, IsEnrolledInCourse, IsInstructor
from .serializers import (
    CourseEnrollSerializer,
    CourseDetailSerializer,
    CourseListSerializer,
    CourseWriteSerializer,
    LectureSerializer,
    LectureProgressStateSerializer,
    LectureProgressUpdateSerializer,
    LiveClassEnrollSerializer,
    LiveClassListSerializer,
    MyCourseLibrarySerializer,
    PublicEnrollmentLeadCreateSerializer,
    SectionSerializer,
)
from .services import (
    ProtectedMediaError,
    S3VideoError,
    build_protected_lecture_playback_url,
    generate_playback_url,
    generate_signed_video_url,
    normalize_storage_key,
    resolve_lecture_playback_expires_in,
    validate_protected_lecture_playback_request,
)


def _local_media_path_exists(storage_key):
    try:
        normalized_key = normalize_storage_key(storage_key)
    except ProtectedMediaError:
        return False
    return (Path(settings.MEDIA_ROOT) / normalized_key).exists()


def _protected_media_content_type(asset_path):
    lowered_path = str(asset_path or "").lower()
    if lowered_path.endswith(".m3u8"):
        return "application/vnd.apple.mpegurl"
    if lowered_path.endswith(".ts"):
        return "video/mp2t"
    guessed_type, _ = mimetypes.guess_type(lowered_path)
    return guessed_type or "application/octet-stream"


def _build_protected_media_response(asset_path):
    normalized_path = normalize_storage_key(asset_path)
    media_path = Path(settings.MEDIA_ROOT) / normalized_path
    if not media_path.exists() or not media_path.is_file():
        return HttpResponseNotFound("Protected lecture asset not found.")

    if bool(getattr(settings, "COURSE_PROTECTED_MEDIA_USE_ACCEL_REDIRECT", not settings.DEBUG)):
        response = HttpResponse()
        response["X-Accel-Redirect"] = f"/_protected_media/{normalized_path}"
    else:
        response = FileResponse(
            media_path.open("rb"),
            content_type=_protected_media_content_type(normalized_path),
        )
        response["Content-Length"] = str(media_path.stat().st_size)

    response["Cache-Control"] = "private, max-age=300"
    response["X-Content-Type-Options"] = "nosniff"
    return response


def _course_prefetch_queryset():
    return Course.objects.select_related("instructor").prefetch_related(
        Prefetch(
            "sections",
            queryset=Section.objects.all().prefetch_related("lectures"),
        )
    )


def _get_lecture_access_context(lecture, user):
    course = lecture.section.course
    is_authenticated = bool(user and getattr(user, "is_authenticated", False))
    is_instructor_owner = bool(
        is_authenticated and user.role == "instructor" and getattr(user, "id", None) == course.instructor_id
    )
    is_enrolled = bool(
        is_authenticated
        and Enrollment.objects.filter(
            user=user,
            course=course,
            payment_status=Enrollment.STATUS_PAID,
        ).exists()
    )
    can_access = bool(lecture.is_preview and is_authenticated) or is_instructor_owner or is_enrolled
    return {
        "course": course,
        "is_authenticated": is_authenticated,
        "is_instructor_owner": is_instructor_owner,
        "is_enrolled": is_enrolled,
        "can_access": can_access,
    }


def _build_lecture_progress_map(*, course, user):
    if not user or not getattr(user, "is_authenticated", False):
        return {}
    queryset = LectureProgress.objects.filter(
        user=user,
        lecture__section__course=course,
    ).select_related("lecture")
    return {item.lecture_id: item for item in queryset}


class CourseListCreateView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        disallowed_query_params = find_disallowed_query_params(
            request,
            {"search", "paginate", "page", "page_size"},
        )
        if disallowed_query_params:
            log_security_event(
                "request.query_params_blocked",
                request=request,
                endpoint="course_list",
                blocked_keys=disallowed_query_params[:20],
            )
            return api_response(
                success=False,
                message="Invalid request query.",
                errors={"detail": "Unsupported query parameters."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        search = (request.query_params.get("search") or "").strip()
        cache_key = None
        if not request.user.is_authenticated:
            cache_version = get_course_list_cache_version()
            cache_key = (
                "course-list:"
                f"v={cache_version}:"
                f"search={search.lower()}:"
                f"paginate={request.query_params.get('paginate','')}:"
                f"page={request.query_params.get('page','')}:"
                f"page_size={request.query_params.get('page_size','')}"
            )
            cached = cache.get(cache_key)
            if cached is not None:
                return api_response(success=True, message="Courses fetched.", data=cached)

        queryset = (
            Course.objects.filter(is_published=True)
            .select_related("instructor")
            .annotate(section_count=Count("sections"))
        )
        if search:
            queryset = queryset.filter(
                Q(title__icontains=search) | Q(description__icontains=search)
            )
        queryset = queryset.order_by("-created_at")
        paged_queryset, page_meta = apply_optional_pagination(request, queryset)
        serializer = CourseListSerializer(
            paged_queryset,
            many=True,
            context={"request": request},
        )
        payload = (
            {"results": serializer.data, "pagination": page_meta}
            if page_meta is not None
            else serializer.data
        )
        if cache_key:
            cache.set(
                cache_key,
                payload,
                timeout=getattr(settings, "COURSE_LIST_CACHE_TTL_SECONDS", 60),
            )
        return api_response(success=True, message="Courses fetched.", data=payload)

    def post(self, request):
        if not request.user or not request.user.is_authenticated:
            return api_response(
                success=False,
                message="Authentication required.",
                errors={"detail": "Authentication credentials were not provided."},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        if request.user.role != "instructor":
            return api_response(
                success=False,
                message="Instructor role required.",
                errors={"detail": "Only instructors can create courses."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        serializer = CourseWriteSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Course creation failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        course = serializer.save(instructor=request.user)
        data = CourseDetailSerializer(course, context={"request": request}).data
        return api_response(
            success=True,
            message="Course created.",
            data=data,
            status_code=status.HTTP_201_CREATED,
        )


class CourseDetailView(APIView):
    permission_classes = [permissions.AllowAny]

    @staticmethod
    def _build_public_cache_key(course_id, updated_at):
        updated_ts = int(updated_at.timestamp()) if updated_at else 0
        return f"course-detail:{course_id}:v={updated_ts}"

    def get_object(self, request, pk):
        queryset = _course_prefetch_queryset()
        course = generics.get_object_or_404(queryset, pk=pk)
        if course.is_published:
            return course
        if not request.user.is_authenticated:
            raise permissions.PermissionDenied("Course is not published.")
        if request.user.role == "instructor" and request.user.id == course.instructor_id:
            return course
        raise permissions.PermissionDenied("Course is not published.")

    def get(self, request, pk):
        cache_key = None
        if not request.user.is_authenticated:
            public_cache_row = (
                Course.objects.filter(pk=pk, is_published=True)
                .values("id", "updated_at")
                .first()
            )
            if public_cache_row:
                cache_key = self._build_public_cache_key(
                    public_cache_row["id"],
                    public_cache_row["updated_at"],
                )
                cached = cache.get(cache_key)
                if cached is not None:
                    return api_response(success=True, message="Course fetched.", data=cached)

        try:
            course = self.get_object(request, pk)
        except permissions.PermissionDenied as exc:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        if not cache_key and not request.user.is_authenticated and course.is_published:
            cache_key = self._build_public_cache_key(course.pk, course.updated_at)
        serializer_context = {"request": request}
        if request.user.is_authenticated:
            can_view_progress = bool(
                request.user.id == course.instructor_id
                or Enrollment.objects.filter(
                    user=request.user,
                    course=course,
                    payment_status=Enrollment.STATUS_PAID,
                ).exists()
            )
            if can_view_progress:
                serializer_context["lecture_progress_map"] = _build_lecture_progress_map(
                    course=course,
                    user=request.user,
                )

        serializer = CourseDetailSerializer(course, context=serializer_context)
        payload = serializer.data
        if cache_key:
            cache.set(
                cache_key,
                payload,
                timeout=getattr(settings, "COURSE_DETAIL_CACHE_TTL_SECONDS", 60),
            )
        return api_response(success=True, message="Course fetched.", data=payload)

    def patch(self, request, pk):
        return self._update(request, pk, partial=True)

    def put(self, request, pk):
        return self._update(request, pk, partial=False)

    def _update(self, request, pk, partial):
        course = generics.get_object_or_404(Course, pk=pk)
        if not request.user.is_authenticated:
            return api_response(
                success=False,
                message="Authentication required.",
                errors={"detail": "Authentication credentials were not provided."},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        if request.user.role != "instructor" or course.instructor_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only the course instructor can edit this course."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        serializer = CourseWriteSerializer(course, data=request.data, partial=partial)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Course update failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        serializer.save()
        data = CourseDetailSerializer(course, context={"request": request}).data
        return api_response(success=True, message="Course updated.", data=data)

    def delete(self, request, pk):
        course = generics.get_object_or_404(Course, pk=pk)
        if not request.user.is_authenticated:
            return api_response(
                success=False,
                message="Authentication required.",
                errors={"detail": "Authentication credentials were not provided."},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        if request.user.role != "instructor" or course.instructor_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "Only the course instructor can delete this course."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        course.delete()
        return api_response(success=True, message="Course deleted.", data=None)


class SectionCreateView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsInstructor]

    def post(self, request):
        serializer = SectionSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Section creation failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        course = serializer.validated_data["course"]
        if course.instructor_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You can only create sections for your own courses."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        section = serializer.save()
        return api_response(
            success=True,
            message="Section created.",
            data=SectionSerializer(section).data,
            status_code=status.HTTP_201_CREATED,
        )


class SectionDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsInstructor]

    def put(self, request, pk):
        section = generics.get_object_or_404(Section.objects.select_related("course"), pk=pk)
        if section.course.instructor_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You can only edit sections for your own courses."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        serializer = SectionSerializer(section, data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Section update failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        serializer.save()
        return api_response(success=True, message="Section updated.", data=serializer.data)

    def delete(self, request, pk):
        section = generics.get_object_or_404(Section.objects.select_related("course"), pk=pk)
        if section.course.instructor_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You can only delete sections for your own courses."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        section.delete()
        return api_response(success=True, message="Section deleted.", data=None)


class LectureCreateView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsInstructor]

    def post(self, request):
        serializer = LectureSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Lecture creation failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        section = serializer.validated_data["section"]
        if section.course.instructor_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You can only create lectures for your own courses."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        lecture = serializer.save()
        return api_response(
            success=True,
            message="Lecture created.",
            data=LectureSerializer(lecture, context={"request": request}).data,
            status_code=status.HTTP_201_CREATED,
        )


class LectureDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsInstructor]

    def put(self, request, pk):
        lecture = generics.get_object_or_404(Lecture.objects.select_related("section__course"), pk=pk)
        if lecture.section.course.instructor_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You can only edit lectures for your own courses."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        serializer = LectureSerializer(lecture, data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Lecture update failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        serializer.save()
        return api_response(
            success=True,
            message="Lecture updated.",
            data=LectureSerializer(lecture, context={"request": request}).data,
        )

    def delete(self, request, pk):
        lecture = generics.get_object_or_404(Lecture.objects.select_related("section__course"), pk=pk)
        if lecture.section.course.instructor_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You can only delete lectures for your own courses."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        lecture.delete()
        return api_response(success=True, message="Lecture deleted.", data=None)


class LectureVideoView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "lecture_playback"

    def get(self, request, pk):
        lecture = generics.get_object_or_404(
            Lecture.objects.select_related("section__course", "section__course__instructor"),
            pk=pk,
        )
        access_context = _get_lecture_access_context(lecture, request.user)
        course = access_context["course"]
        expires_in = resolve_lecture_playback_expires_in(lecture)
        if not lecture.is_preview:
            if not access_context["is_authenticated"]:
                log_security_event("course.lecture_playback_denied_unauthenticated", request=request, lecture_id=lecture.id)
                return api_response(
                    success=False,
                    message="Authentication required.",
                    errors={"detail": "Authentication credentials were not provided."},
                    status_code=status.HTTP_401_UNAUTHORIZED,
                )
            if not access_context["can_access"]:
                log_security_event(
                    "course.lecture_playback_denied_not_enrolled",
                    request=request,
                    lecture_id=lecture.id,
                    course_id=course.id,
                )
                return api_response(
                    success=False,
                    message="Enrollment required.",
                    errors={"detail": "You are not enrolled in this course."},
                    status_code=status.HTTP_403_FORBIDDEN,
                )

        if lecture.stream_status == Lecture.STREAM_READY and lecture.stream_manifest_key:
            try:
                if _local_media_path_exists(lecture.stream_manifest_key):
                    playback_url, expires_in = build_protected_lecture_playback_url(
                        request,
                        lecture,
                        lecture.stream_manifest_key,
                        expires_in=expires_in,
                        asset_type="hls",
                    )
                else:
                    playback_url, expires_in = generate_playback_url(
                        request,
                        lecture.stream_manifest_key,
                        expires_in=expires_in,
                        signer=generate_signed_video_url,
                    )
            except S3VideoError as exc:
                log_security_event(
                    "course.lecture_playback_hls_url_failed",
                    request=request,
                    lecture_id=lecture.id,
                    course_id=course.id,
                )
                return api_response(
                    success=False,
                    message="Stream URL generation failed.",
                    errors={"detail": str(exc)},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            except ProtectedMediaError as exc:
                return api_response(
                    success=False,
                    message="Stream URL generation failed.",
                    errors={"detail": str(exc)},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            log_security_event(
                "course.lecture_playback_hls_url_issued",
                request=request,
                lecture_id=lecture.id,
                course_id=course.id,
            )
            return api_response(
                success=True,
                message="Lecture stream URL generated.",
                data={
                    "signed_url": playback_url,
                    "playback_url": playback_url,
                    "playback_type": "hls",
                    "stream_status": lecture.stream_status,
                    "expires_in": expires_in,
                },
            )

        if lecture.video_file:
            try:
                media_url, expires_in = build_protected_lecture_playback_url(
                    request,
                    lecture,
                    lecture.video_file.name,
                    expires_in=expires_in,
                    asset_type="file",
                )
            except ProtectedMediaError as exc:
                return api_response(
                    success=False,
                    message="Video URL generation failed.",
                    errors={"detail": str(exc)},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            log_security_event(
                "course.lecture_playback_file_url_issued",
                request=request,
                lecture_id=lecture.id,
                course_id=course.id,
            )
            return api_response(
                success=True,
                message="Lecture video URL generated.",
                data={
                    "signed_url": media_url,
                    "playback_url": media_url,
                    "playback_type": "file",
                    "stream_status": lecture.stream_status,
                    "expires_in": expires_in,
                },
            )

        if not lecture.video_key:
            return api_response(
                success=False,
                message="Video not configured.",
                errors={"detail": "No uploaded video file or video key is configured for this lecture."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        try:
            signed_url, expires_in = generate_playback_url(
                request, lecture.video_key, expires_in=expires_in, signer=generate_signed_video_url
            )
        except S3VideoError as exc:
            log_security_event(
                "course.lecture_playback_signed_url_failed",
                request=request,
                lecture_id=lecture.id,
                course_id=course.id,
            )
            return api_response(
                success=False,
                message="Video URL generation failed.",
                errors={"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        log_security_event(
            "course.lecture_playback_signed_url_issued",
            request=request,
            lecture_id=lecture.id,
            course_id=course.id,
        )
        return api_response(
            success=True,
            message="Signed video URL generated.",
            data={
                "signed_url": signed_url,
                "playback_url": signed_url,
                "playback_type": "file",
                "stream_status": lecture.stream_status,
                "expires_in": expires_in,
            },
        )


class LectureProtectedMediaView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "lecture_playback"

    def get(self, request, pk, token, asset_path):
        try:
            normalized_path = validate_protected_lecture_playback_request(
                token,
                pk,
                asset_path,
                max_age=resolve_lecture_playback_expires_in(None),
            )
        except ProtectedMediaError:
            return HttpResponseNotFound("Protected lecture asset not found.")
        return _build_protected_media_response(normalized_path)


class LectureProgressView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        lecture = generics.get_object_or_404(
            Lecture.objects.select_related("section__course", "section__course__instructor"),
            pk=pk,
        )
        access_context = _get_lecture_access_context(lecture, request.user)
        if not access_context["can_access"]:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You do not have access to this lecture."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        progress = LectureProgress.objects.filter(user=request.user, lecture=lecture).first()
        return api_response(
            success=True,
            message="Lecture progress fetched.",
            data=LectureProgressStateSerializer(progress).data if progress else None,
        )

    def put(self, request, pk):
        return self._save(request, pk)

    def patch(self, request, pk):
        return self._save(request, pk)

    def _save(self, request, pk):
        lecture = generics.get_object_or_404(
            Lecture.objects.select_related("section__course", "section__course__instructor"),
            pk=pk,
        )
        access_context = _get_lecture_access_context(lecture, request.user)
        if not access_context["can_access"]:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You do not have access to this lecture."},
                status_code=status.HTTP_403_FORBIDDEN,
            )

        serializer = LectureProgressUpdateSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Lecture progress update failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        progress, _ = LectureProgress.objects.get_or_create(user=request.user, lecture=lecture)
        progress.mark_progress(
            position_seconds=serializer.validated_data["position_seconds"],
            duration_seconds=serializer.validated_data.get("duration_seconds") or lecture.stream_duration_seconds,
            completed=serializer.validated_data.get("completed"),
        )
        progress.save()
        return api_response(
            success=True,
            message="Lecture progress updated.",
            data=LectureProgressStateSerializer(progress).data,
        )


class MyCoursesView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        enrollments = list(
            Enrollment.objects.filter(user=request.user, payment_status=Enrollment.STATUS_PAID)
            .order_by("-enrolled_at")
            .values("course_id", "enrolled_at")
        )
        if not enrollments:
            return api_response(success=True, message="Your courses fetched.", data=[])

        course_ids = [row["course_id"] for row in enrollments]
        purchased_course_ids = set(
            Payment.objects.filter(
                user=request.user,
                course_id__in=course_ids,
                status=Payment.STATUS_PAID,
            ).values_list("course_id", flat=True)
        )
        course_map = {
            course.id: course
            for course in Course.objects.filter(id__in=course_ids)
            .select_related("instructor")
            .annotate(
                section_count=Count("sections", distinct=True),
                lecture_count=Count("sections__lectures", distinct=True),
            )
        }

        courses = []
        for row in enrollments:
            course = course_map.get(row["course_id"])
            if course is None:
                continue
            course.enrolled_at = row["enrolled_at"]
            course.access_source = "purchased" if course.id in purchased_course_ids else "granted"
            course.access_label = "Purchased" if course.id in purchased_course_ids else "Granted Access"
            courses.append(course)

        serializer = MyCourseLibrarySerializer(courses, many=True, context={"request": request})
        return api_response(success=True, message="Your courses fetched.", data=serializer.data)


class InstructorCoursesView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsInstructor]

    def get(self, request):
        queryset = (
            Course.objects.filter(instructor=request.user)
            .select_related("instructor")
            .annotate(section_count=Count("sections"))
        )
        serializer = CourseListSerializer(
            queryset,
            many=True,
            context={"request": request},
        )
        return api_response(success=True, message="Instructor courses fetched.", data=serializer.data)


class CourseEnrollView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "course_enroll"

    def post(self, request):
        serializer = CourseEnrollSerializer(data=request.data)
        if not serializer.is_valid():
            log_security_event("course.enroll_invalid", request=request, errors=serializer.errors)
            return api_response(
                success=False,
                message="Course enrollment request failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        course = Course.objects.filter(
            pk=serializer.validated_data["course_id"],
            is_published=True,
        ).first()
        if not course:
            log_security_event("course.enroll_not_found_or_unpublished", request=request)
            return api_response(
                success=False,
                message="Course unavailable.",
                errors={"detail": "Course not found or not published."},
                status_code=status.HTTP_404_NOT_FOUND,
            )

        if request.user.id == course.instructor_id:
            log_security_event("course.enroll_instructor_self_blocked", request=request, course_id=course.id)
            return api_response(
                success=False,
                message="Enrollment request failed.",
                errors={"detail": "Instructors cannot enroll in their own courses."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        enrollment, created = Enrollment.objects.get_or_create(
            user=request.user,
            course=course,
            defaults={"payment_status": Enrollment.STATUS_PENDING},
        )

        if created:
            message = "Enrollment request submitted for admin approval."
        elif enrollment.payment_status == Enrollment.STATUS_PAID:
            message = "You are already enrolled in this course."
        elif enrollment.payment_status == Enrollment.STATUS_PENDING:
            message = "Enrollment request already pending admin approval."
        else:
            enrollment.payment_status = Enrollment.STATUS_PENDING
            enrollment.save(update_fields=["payment_status"])
            message = "Enrollment request re-submitted for admin approval."

        log_security_event(
            "course.enroll_requested" if enrollment.payment_status == Enrollment.STATUS_PENDING else "course.enroll_already_paid",
            request=request,
            course_id=course.id,
        )

        enrollment_status = (
            "approved" if enrollment.payment_status == Enrollment.STATUS_PAID else enrollment.payment_status
        )
        return api_response(
            success=True,
            message=message,
            data={
                "course_id": course.id,
                "enrollment_status": enrollment_status,
                "is_enrolled": enrollment.payment_status == Enrollment.STATUS_PAID,
            },
        )


class LiveClassListView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        disallowed_query_params = find_disallowed_query_params(
            request,
            {"paginate", "page", "page_size"},
        )
        if disallowed_query_params:
            log_security_event(
                "request.query_params_blocked",
                request=request,
                endpoint="live_class_list",
                blocked_keys=disallowed_query_params[:20],
            )
            return api_response(
                success=False,
                message="Invalid request query.",
                errors={"detail": "Unsupported query parameters."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        cache_key = None
        if not request.user.is_authenticated:
            cache_version = get_live_class_list_cache_version()
            cache_key = (
                "live-class-list:"
                f"v={cache_version}:"
                f"paginate={request.query_params.get('paginate','')}:"
                f"page={request.query_params.get('page','')}:"
                f"page_size={request.query_params.get('page_size','')}"
            )
            cached = cache.get(cache_key)
            if cached is not None:
                return api_response(success=True, message="Live classes fetched.", data=cached)

        queryset = (
            LiveClass.objects.filter(is_active=True)
            .select_related("linked_course")
            .annotate(
                enrollment_count=Count(
                    "enrollments",
                    filter=Q(enrollments__status=LiveClassEnrollment.STATUS_APPROVED),
                )
            )
            .order_by("month_number", "id")
        )
        paged_queryset, page_meta = apply_optional_pagination(request, queryset, default_page_size=12, max_page_size=50)
        serializer_context = {"request": request}
        if request.user.is_authenticated:
            live_class_ids = [item.id for item in paged_queryset]
            enrollment_statuses = {
                live_class_id: status_value
                for live_class_id, status_value in LiveClassEnrollment.objects.filter(
                    user=request.user,
                    live_class_id__in=live_class_ids,
                ).values_list("live_class_id", "status")
            }
            serializer_context["live_class_enrollment_statuses"] = enrollment_statuses
        serializer = LiveClassListSerializer(paged_queryset, many=True, context=serializer_context)
        payload = (
            {"results": serializer.data, "pagination": page_meta}
            if page_meta is not None
            else serializer.data
        )
        if cache_key:
            cache.set(
                cache_key,
                payload,
                timeout=getattr(settings, "LIVE_CLASS_LIST_CACHE_TTL_SECONDS", 30),
            )
        return api_response(success=True, message="Live classes fetched.", data=payload)


class LiveClassEnrollView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "live_class_enroll"

    def post(self, request):
        serializer = LiveClassEnrollSerializer(data=request.data)
        if not serializer.is_valid():
            log_security_event("live_class.enroll_invalid", request=request, errors=serializer.errors)
            return api_response(
                success=False,
                message="Live class enrollment failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        live_class = (
            LiveClass.objects.filter(pk=serializer.validated_data["live_class_id"], is_active=True)
            .select_related("linked_course")
            .first()
        )
        if not live_class:
            log_security_event("live_class.enroll_not_found_or_inactive", request=request)
            return api_response(
                success=False,
                message="Live class unavailable.",
                errors={"detail": "Live class not found or inactive."},
                status_code=status.HTTP_404_NOT_FOUND,
            )

        enrollment, created = LiveClassEnrollment.objects.get_or_create(
            user=request.user,
            live_class=live_class,
            defaults={"status": LiveClassEnrollment.STATUS_PENDING},
        )
        if created:
            response_message = "Enrollment request submitted for admin approval."
        elif enrollment.status == LiveClassEnrollment.STATUS_APPROVED:
            response_message = "Already enrolled in live class."
        elif enrollment.status == LiveClassEnrollment.STATUS_PENDING:
            response_message = "Enrollment request already pending admin approval."
        else:
            enrollment.status = LiveClassEnrollment.STATUS_PENDING
            enrollment.save(update_fields=["status"])
            response_message = "Enrollment request re-submitted for admin approval."

        log_security_event(
            "live_class.enroll_requested"
            if enrollment.status == LiveClassEnrollment.STATUS_PENDING
            else "live_class.enroll_already_approved",
            request=request,
            live_class_id=live_class.id,
        )

        return api_response(
            success=True,
            message=response_message,
            data={
                "live_class_id": live_class.id,
                "enrolled": enrollment.status == LiveClassEnrollment.STATUS_APPROVED,
                "enrollment_status": enrollment.status,
                "already_pending": enrollment.status == LiveClassEnrollment.STATUS_PENDING and not created,
                "email": request.user.email,
                "full_name": request.user.full_name,
            },
        )


class PublicEnrollmentLeadCreateView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "public_enrollment_lead"

    def post(self, request):
        serializer = PublicEnrollmentLeadCreateSerializer(data=request.data)
        if not serializer.is_valid():
            log_security_event("public_enrollment_lead.invalid", request=request, errors=serializer.errors)
            return api_response(
                success=False,
                message="Enrollment request submission failed.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )

        lead = serializer.save()
        target_id = lead.course_id or lead.live_class_id
        target_type = "course" if lead.course_id else "live_class"
        log_security_event(
            "public_enrollment_lead.created",
            request=request,
            lead_id=lead.id,
            target_type=target_type,
            target_id=target_id,
            email=lead.email,
        )
        return api_response(
            success=True,
            message="Enrollment request received. Our team will contact you.",
            data={
                "lead_id": lead.id,
                "status": PublicEnrollmentLead.STATUS_NEW,
                "target_type": target_type,
                "target_id": target_id,
            },
            status_code=status.HTTP_201_CREATED,
        )
