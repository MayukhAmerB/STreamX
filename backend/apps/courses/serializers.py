import re

from rest_framework import serializers
from django.urls import reverse

from config.request_security import contains_active_content, is_safe_public_http_url
from config.upload_validators import validate_profile_image_upload, validate_video_upload
from config.url_utils import build_public_url, get_media_public_url

from .services import ProtectedMediaError, build_protected_lecture_playback_url, resolve_lecture_playback_expires_in
from .models import (
    Course,
    Enrollment,
    GuideVideo,
    Lecture,
    LectureNote,
    LectureQuestion,
    LectureResource,
    LectureProgress,
    LiveClass,
    LiveClassEnrollment,
    PublicEnrollmentLead,
    Section,
)


def _normalize_text_list(value):
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise serializers.ValidationError("Enter a valid list of text values.")

    normalized = []
    for item in value:
        text = str(item or "").strip()
        if not text:
            continue
        if contains_active_content(text):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        normalized.append(text)
    return normalized


class LectureSerializer(serializers.ModelSerializer):
    video_file_url = serializers.SerializerMethodField(read_only=True)
    resources = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = Lecture
        fields = (
            "id",
            "title",
            "description",
            "video_key",
            "video_file",
            "video_file_url",
            "stream_status",
            "stream_manifest_key",
            "stream_duration_seconds",
            "stream_error",
            "order",
            "is_preview",
            "resources",
            "section",
            "created_at",
            "updated_at",
        )
        extra_kwargs = {
            "video_key": {"write_only": True, "required": False, "allow_blank": True},
            "video_file": {"write_only": True, "required": False, "allow_null": True},
            "stream_manifest_key": {"read_only": True},
            "stream_status": {"read_only": True},
            "stream_duration_seconds": {"read_only": True},
            "stream_error": {"read_only": True},
            "section": {"write_only": True},
        }

    def validate(self, attrs):
        video_key = attrs.get("video_key")
        video_file = attrs.get("video_file")
        instance = getattr(self, "instance", None)
        title = attrs.get("title", getattr(instance, "title", ""))
        description = attrs.get("description", getattr(instance, "description", ""))

        if contains_active_content(title):
            raise serializers.ValidationError({"title": "Suspicious script or active-content payload detected."})
        if contains_active_content(description):
            raise serializers.ValidationError(
                {"description": "Suspicious script or active-content payload detected."}
            )
        if video_file is not None:
            try:
                validate_video_upload(video_file, "video_file")
            except Exception as exc:
                # normalize django ValidationError into DRF validation errors
                detail = getattr(exc, "message_dict", None) or getattr(exc, "message", None) or exc
                raise serializers.ValidationError(detail)

        has_video_key = bool(video_key if video_key is not None else getattr(instance, "video_key", ""))
        has_video_file = bool(video_file if video_file is not None else getattr(instance, "video_file", None))
        if not (has_video_key or has_video_file):
            raise serializers.ValidationError(
                {"video_file": "Upload a video file or provide a video key."}
            )
        effective_video_key = video_key if video_key is not None else getattr(instance, "video_key", "")
        if effective_video_key and str(effective_video_key).startswith(("http://", "https://")):
            if not is_safe_public_http_url(effective_video_key):
                raise serializers.ValidationError(
                    {"video_key": "Only public http/https video URLs are allowed."}
                )
        return attrs

    def get_video_file_url(self, obj):
        request = self.context.get("request")
        if not getattr(obj, "video_file", None):
            return None
        try:
            url, _ = build_protected_lecture_playback_url(
                request,
                obj,
                obj.video_file.name,
                expires_in=resolve_lecture_playback_expires_in(obj),
                asset_type="file",
            )
            return url
        except ProtectedMediaError:
            return None

    def get_resources(self, obj):
        resources = getattr(obj, "resources", None)
        resource_items = resources.all() if resources is not None else []
        return LectureResourceSerializer(resource_items, many=True, context=self.context).data


class LectureResourceSerializer(serializers.ModelSerializer):
    title = serializers.SerializerMethodField()
    filename = serializers.SerializerMethodField()
    file_extension = serializers.SerializerMethodField()
    file_size = serializers.SerializerMethodField()
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = LectureResource
        fields = (
            "id",
            "title",
            "filename",
            "file_extension",
            "file_size",
            "download_url",
            "order",
            "created_at",
            "updated_at",
        )

    def get_title(self, obj):
        return obj.display_title

    def get_filename(self, obj):
        resource_file = getattr(obj, "resource_file", None)
        if not resource_file:
            return ""
        return str(getattr(resource_file, "name", "") or "").replace("\\", "/").split("/")[-1]

    def get_file_extension(self, obj):
        filename = self.get_filename(obj)
        if "." not in filename:
            return ""
        return filename.rsplit(".", 1)[-1].lower()

    def get_file_size(self, obj):
        resource_file = getattr(obj, "resource_file", None)
        return int(getattr(resource_file, "size", 0) or 0)

    def get_download_url(self, obj):
        request = self.context.get("request")
        path = reverse(
            "lecture-resource-download",
            kwargs={"lecture_pk": obj.lecture_id, "pk": obj.pk},
        )
        return build_public_url(path, request=request)


class LectureNestedSerializer(serializers.ModelSerializer):
    progress = serializers.SerializerMethodField()
    resources = serializers.SerializerMethodField()

    class Meta:
        model = Lecture
        fields = (
            "id",
            "title",
            "description",
            "order",
            "is_preview",
            "stream_status",
            "stream_duration_seconds",
            "progress",
            "resources",
            "created_at",
            "updated_at",
        )

    def get_progress(self, obj):
        progress_map = self.context.get("lecture_progress_map") or {}
        progress = progress_map.get(obj.id)
        if not progress:
            return None
        return LectureProgressStateSerializer(progress).data

    def get_resources(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return []

        course = getattr(getattr(obj, "section", None), "course", None)
        if course is None:
            return []

        user = request.user
        if getattr(user, "id", None) == getattr(course, "instructor_id", None):
            can_access = True
        elif obj.is_preview:
            can_access = True
        else:
            course_enrollment_status = self.context.get("course_detail_enrollment_status")
            if course_enrollment_status is None:
                enrollment = (
                    Enrollment.objects.filter(
                        user=user,
                        course=course,
                        payment_status=Enrollment.STATUS_PAID,
                    )
                    .only("id")
                    .first()
                )
                course_enrollment_status = "approved" if enrollment else "none"
            can_access = course_enrollment_status == "approved"

        if not can_access:
            return []

        resources = getattr(obj, "resources", None)
        resource_items = resources.all() if resources is not None else []
        return LectureResourceSerializer(resource_items, many=True, context=self.context).data


class LectureProgressStateSerializer(serializers.ModelSerializer):
    percent_complete = serializers.SerializerMethodField()
    resume_position_seconds = serializers.SerializerMethodField()

    class Meta:
        model = LectureProgress
        fields = (
            "last_position_seconds",
            "max_position_seconds",
            "duration_seconds",
            "completed",
            "completed_at",
            "percent_complete",
            "resume_position_seconds",
            "updated_at",
        )

    def get_percent_complete(self, obj):
        return obj.completion_percent()

    def get_resume_position_seconds(self, obj):
        return obj.resume_position_seconds()


class SectionSerializer(serializers.ModelSerializer):
    def validate_title(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_description(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    class Meta:
        model = Section
        fields = ("id", "course", "title", "description", "order", "created_at")


class SectionNestedSerializer(serializers.ModelSerializer):
    lectures = LectureNestedSerializer(many=True, read_only=True)

    class Meta:
        model = Section
        fields = ("id", "title", "description", "order", "created_at", "lectures")


class CourseEnrollmentStatusMixin:
    def _normalize_enrollment_status(self, enrollment):
        if not enrollment:
            return "none"
        if enrollment.payment_status == Enrollment.STATUS_PAID:
            return "approved"
        if enrollment.payment_status == Enrollment.STATUS_PENDING:
            return "pending"
        return "none"

    def _get_cached_enrollment(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return None
        if request.user.id == obj.instructor_id:
            return None

        enrollment_cache = self.context.setdefault("course_enrollment_cache", {})
        cache_key = (request.user.id, obj.id)
        if cache_key in enrollment_cache:
            return enrollment_cache[cache_key]

        enrollment = (
            Enrollment.objects.filter(user=request.user, course=obj)
            .only("payment_status", "enrolled_at")
            .order_by("-enrolled_at")
            .first()
        )
        enrollment_cache[cache_key] = enrollment
        return enrollment

    def get_enrollment_status(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return "none"
        if request.user.id == obj.instructor_id:
            return "approved"

        status_map = self.context.get("course_enrollment_statuses")
        if status_map is not None:
            return status_map.get(obj.id, "none")

        enrollment = self._get_cached_enrollment(obj)
        return self._normalize_enrollment_status(enrollment)

    def get_is_enrolled(self, obj):
        return self.get_enrollment_status(obj) == "approved"


class CourseListSerializer(CourseEnrollmentStatusMixin, serializers.ModelSerializer):
    thumbnail = serializers.SerializerMethodField()
    instructor = serializers.SerializerMethodField()
    section_count = serializers.IntegerField(read_only=True)
    is_enrolled = serializers.SerializerMethodField()
    enrollment_status = serializers.SerializerMethodField()

    class Meta:
        model = Course
        fields = (
            "id",
            "title",
            "slug",
            "description",
            "thumbnail",
            "price",
            "category",
            "level",
            "launch_status",
            "is_published",
            "section_count",
            "is_enrolled",
            "enrollment_status",
            "instructor",
            "created_at",
            "updated_at",
        )

    def get_instructor(self, obj):
        if not getattr(obj, "instructor_id", None) or not getattr(obj, "instructor", None):
            return None
        return {
            "id": obj.instructor_id,
            "full_name": obj.instructor.full_name,
            "email": obj.instructor.email,
        }

    def get_thumbnail(self, obj):
        request = self.context.get("request")
        return obj.get_thumbnail_url(request=request)


class CourseDetailSerializer(CourseEnrollmentStatusMixin, serializers.ModelSerializer):
    thumbnail = serializers.SerializerMethodField()
    instructor = serializers.SerializerMethodField()
    sections = SectionNestedSerializer(many=True, read_only=True)
    is_enrolled = serializers.SerializerMethodField()
    enrollment_status = serializers.SerializerMethodField()

    class Meta:
        model = Course
        fields = (
            "id",
            "title",
            "slug",
            "description",
            "about_the_course",
            "course_overview",
            "what_you_will_learn",
            "expected_outcomes",
            "enrollment_message",
            "snapshot_category",
            "snapshot_level",
            "snapshot_instructor",
            "thumbnail",
            "price",
            "category",
            "level",
            "launch_status",
            "is_published",
            "instructor",
            "sections",
            "is_enrolled",
            "enrollment_status",
            "created_at",
            "updated_at",
        )

    def get_instructor(self, obj):
        if not getattr(obj, "instructor_id", None) or not getattr(obj, "instructor", None):
            return None
        return {
            "id": obj.instructor_id,
            "full_name": obj.instructor.full_name,
            "email": obj.instructor.email,
        }

    def get_thumbnail(self, obj):
        request = self.context.get("request")
        return obj.get_thumbnail_url(request=request)


class GuideVideoListSerializer(serializers.ModelSerializer):
    class Meta:
        model = GuideVideo
        fields = (
            "id",
            "title",
            "description",
            "order",
            "updated_at",
        )


class CourseWriteSerializer(serializers.ModelSerializer):
    thumbnail_file = serializers.ImageField(required=False, allow_null=True)

    def validate_title(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_description(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_about_the_course(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_course_overview(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_enrollment_message(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_snapshot_category(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_snapshot_level(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_snapshot_instructor(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value

    def validate_what_you_will_learn(self, value):
        return _normalize_text_list(value)

    def validate_expected_outcomes(self, value):
        return _normalize_text_list(value)

    def validate_thumbnail(self, value):
        if value and not is_safe_public_http_url(value):
            raise serializers.ValidationError(
                "Only public http/https URLs are allowed. Private/local/internal URLs are blocked."
            )
        return value

    def validate_thumbnail_file(self, value):
        try:
            validate_profile_image_upload(value, "thumbnail_file")
        except Exception as exc:
            detail = getattr(exc, "message_dict", None) or getattr(exc, "message", None) or exc
            raise serializers.ValidationError(detail)
        return value

    class Meta:
        model = Course
        fields = (
            "id",
            "title",
            "description",
            "about_the_course",
            "course_overview",
            "what_you_will_learn",
            "expected_outcomes",
            "enrollment_message",
            "snapshot_category",
            "snapshot_level",
            "snapshot_instructor",
            "thumbnail",
            "thumbnail_file",
            "price",
            "category",
            "level",
            "launch_status",
            "is_published",
        )


class LiveClassListSerializer(serializers.ModelSerializer):
    linked_course_title = serializers.CharField(source="linked_course.title", read_only=True)
    linked_course_id = serializers.IntegerField(read_only=True)
    enrollment_count = serializers.IntegerField(read_only=True)
    is_enrolled = serializers.SerializerMethodField()
    enrollment_status = serializers.SerializerMethodField()

    class Meta:
        model = LiveClass
        fields = (
            "id",
            "title",
            "slug",
            "description",
            "price",
            "level",
            "month_number",
            "schedule_days",
            "class_duration_minutes",
            "is_active",
            "linked_course_id",
            "linked_course_title",
            "enrollment_count",
            "is_enrolled",
            "enrollment_status",
        )

    def get_is_enrolled(self, obj):
        return self.get_enrollment_status(obj) == LiveClassEnrollment.STATUS_APPROVED

    def get_enrollment_status(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return "none"
        status_map = self.context.get("live_class_enrollment_statuses")
        if status_map is not None:
            return status_map.get(obj.id, "none")
        enrollment = (
            LiveClassEnrollment.objects.filter(user=request.user, live_class=obj)
            .order_by("-created_at")
            .first()
        )
        if not enrollment:
            return "none"
        return enrollment.status


class CourseEnrollSerializer(serializers.Serializer):
    course_id = serializers.IntegerField(min_value=1)


class LectureProgressUpdateSerializer(serializers.Serializer):
    position_seconds = serializers.IntegerField(min_value=0)
    duration_seconds = serializers.IntegerField(min_value=1, required=False)
    completed = serializers.BooleanField(required=False)


class LectureNoteSerializer(serializers.ModelSerializer):
    class Meta:
        model = LectureNote
        fields = ("id", "content", "created_at", "updated_at")
        read_only_fields = ("id", "created_at", "updated_at")

    def validate_content(self, value):
        normalized = str(value or "")
        if len(normalized) > 20000:
            raise serializers.ValidationError("Lecture notes must be 20,000 characters or fewer.")
        if contains_active_content(normalized):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return normalized


class LectureQuestionSerializer(serializers.ModelSerializer):
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = LectureQuestion
        fields = ("id", "question", "status", "status_label", "created_at", "updated_at")
        read_only_fields = ("id", "question", "status", "status_label", "created_at", "updated_at")


class LectureQuestionCreateSerializer(serializers.Serializer):
    question = serializers.CharField(min_length=3, max_length=3000, trim_whitespace=True)

    def validate_question(self, value):
        normalized = str(value or "").strip()
        if contains_active_content(normalized):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return normalized


class LiveClassEnrollSerializer(serializers.Serializer):
    live_class_id = serializers.IntegerField()


PHONE_PATTERN = re.compile(r"^\+?[0-9][0-9()\-\s]{6,22}$")


class PublicEnrollmentLeadCreateSerializer(serializers.Serializer):
    course_id = serializers.IntegerField(min_value=1, required=False)
    live_class_id = serializers.IntegerField(min_value=1, required=False)
    email = serializers.EmailField(max_length=254)
    whatsapp_number = serializers.CharField(max_length=24)
    phone_number = serializers.CharField(max_length=24)
    message = serializers.CharField(max_length=2000, min_length=3, trim_whitespace=True)
    source_path = serializers.CharField(max_length=255, allow_blank=True, required=False)

    @staticmethod
    def _normalize_phone_number(value):
        return re.sub(r"\s+", " ", str(value or "").strip())

    def _validate_phone_number(self, value):
        normalized = self._normalize_phone_number(value)
        if not PHONE_PATTERN.fullmatch(normalized):
            raise serializers.ValidationError(
                "Enter a valid phone number with digits, spaces, (), -, and optional + prefix."
            )
        return normalized

    def validate_phone_number(self, value):
        return self._validate_phone_number(value)

    def validate_whatsapp_number(self, value):
        return self._validate_phone_number(value)

    def validate_message(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return value.strip()

    def validate_source_path(self, value):
        text = str(value or "").strip()
        if contains_active_content(text):
            raise serializers.ValidationError("Suspicious script or active-content payload detected.")
        return text

    def validate(self, attrs):
        course_id = attrs.get("course_id")
        live_class_id = attrs.get("live_class_id")

        if bool(course_id) == bool(live_class_id):
            raise serializers.ValidationError(
                {"detail": "Provide exactly one target: either course_id or live_class_id."}
            )

        if course_id:
            course = Course.objects.filter(pk=course_id, is_published=True).first()
            if not course:
                raise serializers.ValidationError({"course_id": "Course not found or not published."})
            attrs["course"] = course

        if live_class_id:
            live_class = LiveClass.objects.filter(pk=live_class_id, is_active=True).first()
            if not live_class:
                raise serializers.ValidationError({"live_class_id": "Live class not found or inactive."})
            attrs["live_class"] = live_class

        return attrs

    def create(self, validated_data):
        validated_data.pop("course_id", None)
        validated_data.pop("live_class_id", None)
        return PublicEnrollmentLead.objects.create(**validated_data)


class EnrollmentCourseSerializer(serializers.ModelSerializer):
    thumbnail = serializers.SerializerMethodField()

    class Meta:
        model = Course
        fields = ("id", "title", "description", "thumbnail", "price", "slug")

    def get_thumbnail(self, obj):
        request = self.context.get("request")
        return obj.get_thumbnail_url(request=request)


class MyCourseLibrarySerializer(serializers.ModelSerializer):
    thumbnail = serializers.SerializerMethodField()
    instructor = serializers.SerializerMethodField()
    section_count = serializers.IntegerField(read_only=True)
    lecture_count = serializers.IntegerField(read_only=True)
    enrolled_at = serializers.DateTimeField(read_only=True)
    access_source = serializers.CharField(read_only=True)
    access_label = serializers.CharField(read_only=True)

    class Meta:
        model = Course
        fields = (
            "id",
            "title",
            "slug",
            "description",
            "thumbnail",
            "price",
            "category",
            "level",
            "launch_status",
            "section_count",
            "lecture_count",
            "instructor",
            "enrolled_at",
            "access_source",
            "access_label",
        )

    def get_instructor(self, obj):
        if not getattr(obj, "instructor_id", None) or not getattr(obj, "instructor", None):
            return None
        return {
            "id": obj.instructor_id,
            "full_name": obj.instructor.full_name,
            "email": obj.instructor.email,
        }

    def get_thumbnail(self, obj):
        request = self.context.get("request")
        return obj.get_thumbnail_url(request=request)
