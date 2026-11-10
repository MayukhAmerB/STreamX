"""Admin moderation for lecture comments plus admin-only engagement metrics."""

from django.contrib import admin, messages
from django.db.models import Count, IntegerField, OuterRef, Subquery, Value
from django.db.models.functions import Coalesce
from django.utils.translation import ngettext

from . import services
from .models import LectureComment, LectureLike, LectureView


def _count_subquery(model):
    return Coalesce(
        Subquery(
            model.objects.filter(lecture=OuterRef("pk"))
            .order_by()
            .values("lecture")
            .annotate(total=Count("id"))
            .values("total")[:1],
            output_field=IntegerField(),
        ),
        Value(0),
    )


def annotate_engagement_counts(queryset):
    """Correlated subqueries keep the counts independent of other joins."""
    return queryset.annotate(
        _view_count=_count_subquery(LectureView),
        _like_count=_count_subquery(LectureLike),
        _comment_count=_count_subquery(LectureComment),
    )


class LectureEngagementAdminMixin:
    """Columns for LectureAdmin. View counts are visible ONLY here (admin)."""

    @admin.display(ordering="_view_count", description="Views")
    def view_count(self, obj):
        value = getattr(obj, "_view_count", None)
        return value if value is not None else LectureView.objects.filter(lecture=obj).count()

    @admin.display(ordering="_like_count", description="Likes")
    def like_count(self, obj):
        value = getattr(obj, "_like_count", None)
        return value if value is not None else LectureLike.objects.filter(lecture=obj).count()

    @admin.display(ordering="_comment_count", description="Comments")
    def comment_count(self, obj):
        value = getattr(obj, "_comment_count", None)
        return value if value is not None else LectureComment.objects.filter(lecture=obj).count()


@admin.register(LectureComment)
class LectureCommentAdmin(admin.ModelAdmin):
    list_display = ("id", "body_preview", "lecture", "user", "is_hidden", "edited_at", "created_at")
    list_display_links = ("id", "body_preview")
    list_filter = (
        "is_hidden",
        "created_at",
        ("lecture", admin.RelatedOnlyFieldListFilter),
        ("user", admin.RelatedOnlyFieldListFilter),
    )
    search_fields = ("body", "user__email", "user__full_name", "lecture__title", "lecture__section__course__title")
    raw_id_fields = ("lecture", "user")
    readonly_fields = ("lecture", "user", "body", "edited_at", "created_at", "updated_at")
    fields = ("lecture", "user", "body", "is_hidden", "hidden_reason", "edited_at", "created_at", "updated_at")
    actions = ("hide_selected_comments", "unhide_selected_comments", "delete_selected")
    list_per_page = 50

    def has_add_permission(self, request):
        return False

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("lecture", "user")

    @admin.display(description="Comment")
    def body_preview(self, obj):
        body = obj.body or ""
        return body if len(body) <= 80 else f"{body[:77]}..."

    @admin.action(description="Hide selected comments from students", permissions=("change",))
    def hide_selected_comments(self, request, queryset):
        updated = services.hide_comments(queryset, reason=f"Hidden by {request.user.email}", request=request)
        self.message_user(
            request,
            ngettext("%d comment hidden.", "%d comments hidden.", updated) % updated,
            messages.SUCCESS,
        )

    @admin.action(description="Unhide selected comments", permissions=("change",))
    def unhide_selected_comments(self, request, queryset):
        updated = services.unhide_comments(queryset, request=request)
        self.message_user(
            request,
            ngettext("%d comment restored.", "%d comments restored.", updated) % updated,
            messages.SUCCESS,
        )


@admin.register(LectureLike)
class LectureLikeAdmin(admin.ModelAdmin):
    list_display = ("id", "lecture", "user", "created_at")
    list_filter = (("lecture", admin.RelatedOnlyFieldListFilter),)
    search_fields = ("user__email", "user__full_name", "lecture__title")
    raw_id_fields = ("lecture", "user")
    readonly_fields = ("lecture", "user", "created_at")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
