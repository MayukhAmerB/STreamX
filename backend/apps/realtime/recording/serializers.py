from django.core.exceptions import ValidationError as DjangoValidationError
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.courses.models import Section
from config.upload_validators import validate_obs_recording_upload

from . import services
from .models import ClassRecording


class ModuleRefSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()
    course_id = serializers.IntegerField()


class LectureRefSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()
    stream_status = serializers.CharField()
    is_published = serializers.BooleanField()


def module_ref(module):
    if module is None:
        return None
    return {"id": module.id, "title": module.title, "course_id": module.course_id}


class ClassRecordingSerializer(serializers.ModelSerializer):
    session_id = serializers.IntegerField(read_only=True, allow_null=True)
    module = serializers.SerializerMethodField()
    lecture = serializers.SerializerMethodField()
    can_retry = serializers.SerializerMethodField()
    can_replace = serializers.SerializerMethodField()

    class Meta:
        model = ClassRecording
        fields = (
            "id",
            "session_id",
            "source",
            "state",
            "module",
            "lecture",
            "error",
            "part_count",
            "captured_bytes",
            "file_size_bytes",
            "duration_seconds",
            "attempts",
            "recorder_heartbeat_at",
            "started_at",
            "stop_requested_at",
            "finalized_at",
            "published_at",
            "created_at",
            "updated_at",
            "can_retry",
            "can_replace",
        )
        read_only_fields = fields

    @extend_schema_field(ModuleRefSerializer(allow_null=True))
    def get_module(self, obj):
        return module_ref(obj.module)

    @extend_schema_field(LectureRefSerializer(allow_null=True))
    def get_lecture(self, obj):
        lecture = obj.lecture
        if lecture is None:
            return None
        return {
            "id": lecture.id,
            "title": lecture.title,
            "stream_status": lecture.stream_status,
            "is_published": lecture.is_published,
        }

    def get_can_retry(self, obj) -> bool:
        return services.can_retry(obj)

    def get_can_replace(self, obj) -> bool:
        return obj.state in {ClassRecording.STATE_PROCESSING, ClassRecording.STATE_PUBLISHED} and bool(
            obj.lecture_id
        )


class ObsUploadSerializer(serializers.Serializer):
    video_file = serializers.FileField(
        help_text=(
            "The recording OBS saved: MP4/MOV/M4V/WEBM, or OBS's MKV/FLV/TS, which the server remuxes to MP4 "
            "(stream copy) before swapping it in. Max MAX_VIDEO_UPLOAD_BYTES (5 GB)."
        )
    )

    def validate_video_file(self, value):
        try:
            validate_obs_recording_upload(value, "video_file")
        except DjangoValidationError as exc:
            detail = getattr(exc, "message_dict", {}).get("video_file") or ["Invalid video file."]
            raise serializers.ValidationError(detail[0] if isinstance(detail, list) else detail)
        return value


class SessionModuleUpdateSerializer(serializers.Serializer):
    target_module_id = serializers.PrimaryKeyRelatedField(
        source="target_module",
        queryset=Section.objects.select_related("course"),
        allow_null=True,
    )


class ModuleOptionSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()
    description = serializers.CharField()
    order = serializers.IntegerField()
    lecture_count = serializers.IntegerField()


class CourseRefSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    title = serializers.CharField()


class ModuleOptionsSerializer(serializers.Serializer):
    course = CourseRefSerializer()
    modules = ModuleOptionSerializer(many=True)


def _envelope(name, data_field):
    return type(
        name,
        (serializers.Serializer,),
        {
            "success": serializers.BooleanField(),
            "message": serializers.CharField(),
            "data": data_field,
            "errors": serializers.JSONField(allow_null=True),
        },
    )


ClassRecordingResponseSerializer = _envelope("ClassRecordingResponse", ClassRecordingSerializer(allow_null=True))
ClassRecordingListResponseSerializer = _envelope(
    "ClassRecordingListResponse", ClassRecordingSerializer(many=True, allow_null=True)
)
ModuleOptionsResponseSerializer = _envelope("ModuleOptionsResponse", ModuleOptionsSerializer(allow_null=True))
