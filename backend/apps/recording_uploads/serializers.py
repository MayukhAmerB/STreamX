from rest_framework import serializers


class UploadCreateSerializer(serializers.Serializer):
    session_id = serializers.IntegerField(
        required=False,
        allow_null=True,
        min_value=1,
        help_text="The class. Omitted: the uploader's live class, else the one that ended last.",
    )
    filename = serializers.CharField(max_length=255)
    size = serializers.IntegerField(min_value=1, help_text="File size in bytes.")
    sha256 = serializers.CharField(required=False, allow_blank=True, max_length=64, help_text="Optional whole-file SHA-256 (hex).")
    content_type = serializers.CharField(required=False, allow_blank=True, max_length=100)


class TokenCreateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=80)
    expires_in_days = serializers.IntegerField(required=False, allow_null=True, min_value=1, max_value=730)


class RevertSerializer(serializers.Serializer):
    restore_upload = serializers.BooleanField(
        required=False,
        default=False,
        help_text="false: put the replaced video back. true: switch to the uploaded video again.",
    )


class UploadResultSerializer(serializers.Serializer):
    action = serializers.CharField(help_text='"replaced" (the class recording lecture video) or "created".')
    lecture_id = serializers.IntegerField(allow_null=True)
    lecture_title = serializers.CharField()
    course_id = serializers.IntegerField(allow_null=True)
    recording_id = serializers.IntegerField(allow_null=True)
    learn_url = serializers.CharField()
    reverted = serializers.BooleanField()
    can_switch_back = serializers.BooleanField()


class UploadSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    status = serializers.ChoiceField(
        choices=["uploading", "queued", "assembling", "completed", "failed", "aborted", "expired"]
    )
    status_label = serializers.CharField()
    session_id = serializers.IntegerField(allow_null=True)
    session_title = serializers.CharField()
    filename = serializers.CharField()
    total_bytes = serializers.IntegerField()
    chunk_bytes = serializers.IntegerField()
    chunk_count = serializers.IntegerField()
    received_count = serializers.IntegerField()
    received_bytes = serializers.IntegerField()
    received_chunks = serializers.ListField(child=serializers.IntegerField())
    sha256 = serializers.CharField()
    error = serializers.CharField()
    waiting_for_auto_recording = serializers.BooleanField()
    expires_at = serializers.DateTimeField()
    created_at = serializers.DateTimeField()
    completed_at = serializers.DateTimeField(allow_null=True)
    via_token = serializers.BooleanField()
    result = UploadResultSerializer(allow_null=True)


class UploadTargetSerializer(serializers.Serializer):
    session_id = serializers.IntegerField()
    title = serializers.CharField()
    session_type = serializers.CharField()
    status = serializers.CharField()
    started_at = serializers.DateTimeField(allow_null=True)
    ended_at = serializers.DateTimeField(allow_null=True)
    course_id = serializers.IntegerField(allow_null=True)
    course_title = serializers.CharField()
    has_course = serializers.BooleanField()
    auto_recording_pending = serializers.BooleanField()
    action = serializers.CharField(help_text='What an upload would do: "replaced" or "created".')
    lecture_id = serializers.IntegerField(allow_null=True)
    lecture_title = serializers.CharField()
    module_title = serializers.CharField()


class ChunkAckSerializer(serializers.Serializer):
    index = serializers.IntegerField()
    duplicate = serializers.BooleanField()
    received_count = serializers.IntegerField()
    received_bytes = serializers.IntegerField()
    chunk_count = serializers.IntegerField()
    complete = serializers.BooleanField(help_text="Every chunk is on the server; call complete.")


class UploadTokenSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    name = serializers.CharField()
    prefix = serializers.CharField()
    created_at = serializers.DateTimeField()
    last_used_at = serializers.DateTimeField(allow_null=True)
    expires_at = serializers.DateTimeField(allow_null=True)
    revoked_at = serializers.DateTimeField(allow_null=True)
    active = serializers.BooleanField()


class CreatedUploadTokenSerializer(UploadTokenSerializer):
    token = serializers.CharField(help_text="Shown once. Only its hash is stored.")


def _envelope(name, data_serializer):
    return type(
        name,
        (serializers.Serializer,),
        {
            "success": serializers.BooleanField(),
            "message": serializers.CharField(),
            "data": data_serializer,
            "errors": serializers.JSONField(allow_null=True),
        },
    )


UploadResponseSerializer = _envelope("RecordingUploadResponse", UploadSerializer())
UploadListResponseSerializer = _envelope("RecordingUploadListResponse", UploadSerializer(many=True))
UploadTargetListResponseSerializer = _envelope("RecordingUploadTargetListResponse", UploadTargetSerializer(many=True))
ChunkAckResponseSerializer = _envelope("RecordingUploadChunkResponse", ChunkAckSerializer())
UploadTokenListResponseSerializer = _envelope("RecordingUploadTokenListResponse", UploadTokenSerializer(many=True))
CreatedUploadTokenResponseSerializer = _envelope("RecordingUploadTokenCreatedResponse", CreatedUploadTokenSerializer())
UploadTokenResponseSerializer = _envelope("RecordingUploadTokenResponse", UploadTokenSerializer())
