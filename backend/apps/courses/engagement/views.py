"""HTTP mapping for lecture likes and comments (logic lives in services.py)."""

from django.core.exceptions import ValidationError as DjangoValidationError
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import generics, permissions, status
from rest_framework.views import APIView

from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle

from ..models import Lecture
from . import services
from .models import LectureComment
from .serializers import (
    LectureCommentDeleteResponseSerializer,
    LectureCommentPageResponseSerializer,
    LectureCommentResponseSerializer,
    LectureCommentSerializer,
    LectureCommentWriteSerializer,
    LectureEngagementSummaryResponseSerializer,
)

TAGS = ("Lecture engagement",)
COMMENT_PAGE_SIZE_DEFAULT = 20
COMMENT_PAGE_SIZE_MAX = 50


def _validation_errors(exc):
    return getattr(exc, "message_dict", None) or {"body": list(getattr(exc, "messages", [str(exc)]))}


def _forbidden():
    return api_response(
        success=False,
        message="Access denied.",
        errors={"detail": "You do not have access to this lecture."},
        status_code=status.HTTP_403_FORBIDDEN,
    )


def _not_found():
    return api_response(
        success=False,
        message="Not found.",
        errors={"detail": "Not found."},
        status_code=status.HTTP_404_NOT_FOUND,
    )


def _page_number(raw_value, default):
    try:
        return int(raw_value)
    except (TypeError, ValueError):
        return default


class _LectureEngagementView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ClientIpScopedRateThrottle]
    read_scope = "lecture_engagement_read"
    write_scope = "lecture_engagement_read"

    @property
    def throttle_scope(self):
        method = str(getattr(getattr(self, "request", None), "method", "GET")).upper()
        return self.read_scope if method in {"GET", "HEAD", "OPTIONS"} else self.write_scope

    def load_lecture(self, pk):
        return generics.get_object_or_404(
            Lecture.objects.select_related("section__course"),
            pk=pk,
        )


class LectureEngagementView(_LectureEngagementView):
    @extend_schema(
        operation_id="lecture_engagement_retrieve",
        tags=TAGS,
        responses={200: LectureEngagementSummaryResponseSerializer, 403: LectureEngagementSummaryResponseSerializer},
    )
    def get(self, request, pk):
        lecture = self.load_lecture(pk)
        if not services.can_engage(lecture, request.user):
            return _forbidden()
        return api_response(message="Lecture engagement fetched.", data=services.like_summary(lecture, request.user))


class LectureLikeView(_LectureEngagementView):
    write_scope = "lecture_like"

    def _apply(self, request, pk, action):
        lecture = self.load_lecture(pk)
        if not services.can_engage(lecture, request.user):
            return _forbidden()
        if action == "toggle":
            data = services.toggle_like(lecture, request.user)
        else:
            data = services.set_like(lecture, request.user, liked=(action == "like"))
        return api_response(message="Lecture like updated.", data=data)

    @extend_schema(
        operation_id="lecture_like_toggle",
        tags=TAGS,
        request=None,
        responses={200: LectureEngagementSummaryResponseSerializer, 403: LectureEngagementSummaryResponseSerializer},
        description="Toggle the caller's like on the lecture.",
    )
    def post(self, request, pk):
        return self._apply(request, pk, "toggle")

    @extend_schema(
        operation_id="lecture_like_set",
        tags=TAGS,
        request=None,
        responses={200: LectureEngagementSummaryResponseSerializer, 403: LectureEngagementSummaryResponseSerializer},
        description="Idempotently like the lecture.",
    )
    def put(self, request, pk):
        return self._apply(request, pk, "like")

    @extend_schema(
        operation_id="lecture_like_remove",
        tags=TAGS,
        request=None,
        responses={200: LectureEngagementSummaryResponseSerializer, 403: LectureEngagementSummaryResponseSerializer},
        description="Idempotently remove the caller's like.",
    )
    def delete(self, request, pk):
        return self._apply(request, pk, "unlike")


class LectureCommentListCreateView(_LectureEngagementView):
    write_scope = "lecture_comment_write"

    @extend_schema(
        operation_id="lecture_comments_list",
        tags=TAGS,
        parameters=[
            OpenApiParameter("page", int, required=False),
            OpenApiParameter("page_size", int, required=False, description=f"1-{COMMENT_PAGE_SIZE_MAX}"),
        ],
        responses={200: LectureCommentPageResponseSerializer, 403: LectureCommentPageResponseSerializer},
        description="Visible comments, newest first. Always paginated.",
    )
    def get(self, request, pk):
        lecture = self.load_lecture(pk)
        if not services.can_engage(lecture, request.user):
            return _forbidden()
        page = max(1, _page_number(request.query_params.get("page"), 1))
        page_size = _page_number(request.query_params.get("page_size"), COMMENT_PAGE_SIZE_DEFAULT)
        page_size = max(1, min(page_size, COMMENT_PAGE_SIZE_MAX))
        queryset = services.visible_comments(lecture)
        total = queryset.count()
        offset = (page - 1) * page_size
        items = list(queryset[offset : offset + page_size])
        context = {
            "request": request,
            "course_instructor_id": lecture.section.course.instructor_id,
            "can_moderate": services.can_moderate(lecture, request.user),
        }
        return api_response(
            message="Lecture comments fetched.",
            data={
                "results": LectureCommentSerializer(items, many=True, context=context).data,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "pages": (total + page_size - 1) // page_size if total else 0,
                    "has_next": offset + page_size < total,
                    "has_previous": page > 1,
                },
            },
        )

    @extend_schema(
        operation_id="lecture_comments_create",
        tags=TAGS,
        request=LectureCommentWriteSerializer,
        responses={
            201: LectureCommentResponseSerializer,
            400: LectureCommentResponseSerializer,
            403: LectureCommentResponseSerializer,
        },
        description="Post a plain-text comment (HTML is stripped).",
    )
    def post(self, request, pk):
        lecture = self.load_lecture(pk)
        if not services.can_engage(lecture, request.user):
            return _forbidden()
        serializer = LectureCommentWriteSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Comment could not be posted.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        try:
            comment = services.create_comment(
                lecture, request.user, serializer.validated_data["body"], request=request
            )
        except DjangoValidationError as exc:
            return api_response(
                success=False,
                message="Comment could not be posted.",
                errors=_validation_errors(exc),
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        context = {"request": request, "course_instructor_id": lecture.section.course.instructor_id}
        return api_response(
            message="Comment posted.",
            data=LectureCommentSerializer(comment, context=context).data,
            status_code=status.HTTP_201_CREATED,
        )


class LectureCommentDetailView(_LectureEngagementView):
    write_scope = "lecture_comment_write"

    def _load_comment(self, request, comment_id):
        comment = (
            LectureComment.objects.select_related("lecture__section__course", "user")
            .filter(pk=comment_id, is_hidden=False)
            .first()
        )
        if comment is None or not services.can_engage(comment.lecture, request.user):
            return None
        return comment

    @extend_schema(
        operation_id="lecture_comment_update",
        tags=TAGS,
        request=LectureCommentWriteSerializer,
        responses={
            200: LectureCommentResponseSerializer,
            400: LectureCommentResponseSerializer,
            403: LectureCommentResponseSerializer,
            404: LectureCommentResponseSerializer,
        },
        description="Edit your own comment.",
    )
    def patch(self, request, comment_id):
        comment = self._load_comment(request, comment_id)
        if comment is None:
            return _not_found()
        if comment.user_id != request.user.id:
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You can only edit your own comments."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        serializer = LectureCommentWriteSerializer(data=request.data)
        if not serializer.is_valid():
            return api_response(
                success=False,
                message="Comment could not be updated.",
                errors=serializer.errors,
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        try:
            services.update_comment(comment, serializer.validated_data["body"], request=request)
        except DjangoValidationError as exc:
            return api_response(
                success=False,
                message="Comment could not be updated.",
                errors=_validation_errors(exc),
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        context = {"request": request, "course_instructor_id": comment.lecture.section.course.instructor_id}
        return api_response(message="Comment updated.", data=LectureCommentSerializer(comment, context=context).data)

    @extend_schema(
        operation_id="lecture_comment_delete",
        tags=TAGS,
        request=None,
        responses={
            200: LectureCommentDeleteResponseSerializer,
            403: LectureCommentDeleteResponseSerializer,
            404: LectureCommentDeleteResponseSerializer,
        },
        description="Delete your own comment (staff and the course instructor may delete any).",
    )
    def delete(self, request, comment_id):
        comment = self._load_comment(request, comment_id)
        if comment is None:
            return _not_found()
        if comment.user_id != request.user.id and not services.can_moderate(comment.lecture, request.user):
            return api_response(
                success=False,
                message="Access denied.",
                errors={"detail": "You can only delete your own comments."},
                status_code=status.HTTP_403_FORBIDDEN,
            )
        comment_id_value = comment.id
        services.delete_comment(comment, actor=request.user, request=request)
        return api_response(message="Comment deleted.", data={"id": comment_id_value})
