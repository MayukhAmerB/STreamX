from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from .models import COMMENT_MAX_LENGTH, LectureComment


class LectureCommentWriteSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=COMMENT_MAX_LENGTH, trim_whitespace=True)


class CommentAuthorSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    display_name = serializers.CharField()
    is_instructor = serializers.BooleanField()


class LectureCommentSerializer(serializers.ModelSerializer):
    """Student-facing comment. Never exposes emails or moderation metadata."""

    lecture_id = serializers.IntegerField(read_only=True)
    author = serializers.SerializerMethodField()
    is_mine = serializers.SerializerMethodField()
    is_edited = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()

    class Meta:
        model = LectureComment
        fields = (
            "id",
            "lecture_id",
            "body",
            "author",
            "is_mine",
            "is_edited",
            "can_delete",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields

    def _viewer(self):
        request = self.context.get("request")
        return getattr(request, "user", None)

    @extend_schema_field(CommentAuthorSerializer)
    def get_author(self, obj):
        user = obj.user
        instructor_id = self.context.get("course_instructor_id")
        return {
            "id": user.id,
            "display_name": (user.full_name or "").strip() or "Learner",
            "is_instructor": bool(instructor_id and instructor_id == user.id),
        }

    def get_is_mine(self, obj) -> bool:
        viewer = self._viewer()
        return bool(viewer and getattr(viewer, "id", None) == obj.user_id)

    def get_is_edited(self, obj) -> bool:
        return obj.edited_at is not None

    def get_can_delete(self, obj) -> bool:
        return bool(self.get_is_mine(obj) or self.context.get("can_moderate"))


class PaginationMetaSerializer(serializers.Serializer):
    page = serializers.IntegerField()
    page_size = serializers.IntegerField()
    total = serializers.IntegerField()
    pages = serializers.IntegerField()
    has_next = serializers.BooleanField()
    has_previous = serializers.BooleanField()


class LectureCommentPageSerializer(serializers.Serializer):
    results = LectureCommentSerializer(many=True)
    pagination = PaginationMetaSerializer()


class LectureEngagementSummarySerializer(serializers.Serializer):
    lecture_id = serializers.IntegerField()
    like_count = serializers.IntegerField()
    liked = serializers.BooleanField()
    comment_count = serializers.IntegerField()


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


LectureEngagementSummaryResponseSerializer = _envelope(
    "LectureEngagementSummaryResponse", LectureEngagementSummarySerializer(allow_null=True)
)
LectureCommentResponseSerializer = _envelope("LectureCommentResponse", LectureCommentSerializer(allow_null=True))
LectureCommentPageResponseSerializer = _envelope(
    "LectureCommentPageResponse", LectureCommentPageSerializer(allow_null=True)
)
LectureCommentDeleteResponseSerializer = _envelope(
    "LectureCommentDeleteResponse", serializers.JSONField(allow_null=True)
)
