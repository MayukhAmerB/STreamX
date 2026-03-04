from rest_framework import serializers

from config.request_security import contains_active_content, is_safe_public_http_url
from config.upload_validators import validate_profile_image_upload, validate_video_upload
from config.url_utils import get_media_public_url

from .models import Course, Enrollment, Lecture, LiveClass, LiveClassEnrollment, Section


class LectureSerializer(serializers.ModelSerializer):
    video_file_url = serializers.SerializerMethodField(read_only=True)

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
        return get_media_public_url(obj.video_file.url, request=request)


class LectureNestedSerializer(serializers.ModelSerializer):
    video_file_url = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = Lecture
        fields = (
            "id",
            "title",
            "description",
            "order",
            "is_preview",
            "video_file",
            "video_file_url",
            "stream_status",
            "stream_duration_seconds",
            "created_at",
            "updated_at",
        )

    def get_video_file_url(self, obj):
        request = self.context.get("request")
        if not getattr(obj, "video_file", None):
            return None
        return get_media_public_url(obj.video_file.url, request=request)


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


class CourseListSerializer(serializers.ModelSerializer):
    thumbnail = serializers.SerializerMethodField()
    instructor = serializers.SerializerMethodField()
    section_count = serializers.IntegerField(read_only=True)

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
            "instructor",
            "created_at",
            "updated_at",
        )

    def get_instructor(self, obj):
        return {
            "id": obj.instructor_id,
            "full_name": obj.instructor.full_name,
            "email": obj.instructor.email,
        }

    def get_thumbnail(self, obj):
        request = self.context.get("request")
        return obj.get_thumbnail_url(request=request)


class CourseDetailSerializer(serializers.ModelSerializer):
    thumbnail = serializers.SerializerMethodField()
    instructor = serializers.SerializerMethodField()
    sections = SectionNestedSerializer(many=True, read_only=True)
    is_enrolled = serializers.SerializerMethodField()

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
            "instructor",
            "sections",
            "is_enrolled",
            "created_at",
            "updated_at",
        )

    def get_instructor(self, obj):
        return {
            "id": obj.instructor_id,
            "full_name": obj.instructor.full_name,
            "email": obj.instructor.email,
        }

    def get_thumbnail(self, obj):
        request = self.context.get("request")
        return obj.get_thumbnail_url(request=request)

    def get_is_enrolled(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        if request.user.id == obj.instructor_id:
            return True
        return Enrollment.objects.filter(
            user=request.user,
            course=obj,
            payment_status=Enrollment.STATUS_PAID,
        ).exists()


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

    class Meta:
        model = LiveClass
        fields = (
            "id",
            "title",
            "slug",
            "description",
            "level",
            "month_number",
            "schedule_days",
            "class_duration_minutes",
            "is_active",
            "linked_course_id",
            "linked_course_title",
            "enrollment_count",
            "is_enrolled",
        )

    def get_is_enrolled(self, obj):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        enrolled_ids = self.context.get("enrolled_live_class_ids")
        if enrolled_ids is not None:
            return obj.id in enrolled_ids
        return LiveClassEnrollment.objects.filter(user=request.user, live_class=obj).exists()


class LiveClassEnrollSerializer(serializers.Serializer):
    live_class_id = serializers.IntegerField()


class EnrollmentCourseSerializer(serializers.ModelSerializer):
    thumbnail = serializers.SerializerMethodField()

    class Meta:
        model = Course
        fields = ("id", "title", "description", "thumbnail", "price", "slug")

    def get_thumbnail(self, obj):
        request = self.context.get("request")
        return obj.get_thumbnail_url(request=request)
