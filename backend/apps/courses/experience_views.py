from config.request_security import contains_active_content
from config.response import api_response
from django.db import IntegrityError, transaction
from django.db.models import Avg, Count
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions, serializers
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.throttling import AnonRateThrottle, UserRateThrottle
from rest_framework.views import APIView

from .models import Course, CourseReview, Enrollment, PentestingApplication
from .review_queries import (
    active_review_course_for_user,
    confirmed_reviews_for_course,
    student_review_for_course_track,
)


def confirmed_reviews(course):
    return confirmed_reviews_for_course(course)


def review_roll_number(review):
    return f"AL-SYD-{review.student_id:05d}"


def course_statistics(course):
    stats = confirmed_reviews(course).aggregate(average=Avg("rating"), count=Count("pk"))
    return {
        "enrolled_students": course.enrollments.filter(payment_status=Enrollment.STATUS_PAID).count(),
        "count_scope": "Confirmed students for this course; reviews shared across its training track",
        "average_rating": round(stats["average"], 1) if stats["average"] is not None else None,
        "review_count": stats["count"],
    }


class ExperienceReadThrottle(AnonRateThrottle):
    scope = "course_experience_read"
    rate = "120/min"


class ExperienceWriteThrottle(UserRateThrottle):
    scope = "course_experience_write"
    rate = "10/min"


class ReviewInput(serializers.Serializer):
    rating = serializers.IntegerField(min_value=1, max_value=5)
    text = serializers.CharField(min_length=10, max_length=3000)

    def validate_text(self, value):
        if contains_active_content(value):
            raise serializers.ValidationError("Use plain text for your review.")
        return value


class CourseExperienceView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ExperienceReadThrottle]

    def get(self, request, pk):
        course = get_object_or_404(Course, pk=pk, is_published=True)
        page_input = serializers.IntegerField(min_value=1, max_value=100000)
        page = page_input.run_validation(request.query_params.get("page", 1))
        reviews = confirmed_reviews(course)
        own = None
        eligible = False
        if request.user.is_authenticated:
            eligible = active_review_course_for_user(request.user, course) is not None
            review = student_review_for_course_track(request.user, course)
            if review:
                own = {
                    "rating": review.rating,
                    "text": review.text,
                    "status": review.status,
                    "edit_allowed": review.edit_allowed,
                }
        public_curriculum = course.public_curriculum or []
        if public_curriculum:
            modules = [
                {
                    "id": f"public-{index}",
                    "title": module["title"],
                    "description": module.get("description", ""),
                    "topics": module.get("topics", []),
                    "lessons": [],
                }
                for index, module in enumerate(public_curriculum, start=1)
            ]
        else:
            modules = [
                {
                    "id": section.pk,
                    "title": section.title,
                    "description": section.description,
                    "topics": section.topics,
                    "lessons": list(section.lectures.values("title", "description")),
                }
                for section in course.sections.prefetch_related("lectures").all()
            ]

        data = {
            **course_statistics(course),
            "facts": {
                key: getattr(course, key)
                for key in (
                    "batch",
                    "duration",
                    "schedule",
                    "class_length",
                    "total_classes",
                    "total_hours",
                    "batch_size", "batch_size_label", "total_hours_label", "start_date",
                )
            },
            "modules": modules,
            "reviews": [
                {
                    "rating": review.rating,
                    "text": review.text,
                    "author": review_roll_number(review),
                    "verified": True,
                    "date": review.created_at,
                }
                for review in reviews[(page - 1) * 10 : page * 10]
            ],
            "has_more": reviews.count() > page * 10,
            "can_review": eligible,
            "own_review": own,
        }
        response = api_response(data=data)
        response["Cache-Control"] = "private, no-store"
        return response


class CourseReviewView(APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_classes = [ExperienceWriteThrottle]

    def post(self, request, pk):
        course = get_object_or_404(Course, pk=pk, is_published=True)
        serializer = ReviewInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                review_course = active_review_course_for_user(request.user, course, for_update=True)
                if not review_course:
                    raise PermissionDenied(
                        "Only students with active access to this training track may review it."
                    )
                review = student_review_for_course_track(request.user, course, for_update=True)
                if review and not review.edit_allowed:
                    raise ValidationError(
                        "You have already reviewed this training track. Contact support to request an edit."
                    )
                if review:
                    review.rating = serializer.validated_data["rating"]
                    review.text = serializer.validated_data["text"]
                    review.status = CourseReview.STATUS_APPROVED
                    review.edit_allowed = False
                    review.save()
                else:
                    CourseReview.objects.create(
                        course=review_course,
                        student=request.user,
                        status=CourseReview.STATUS_APPROVED,
                        **serializer.validated_data,
                    )
        except IntegrityError as exc:
            raise ValidationError("You have already reviewed this course.") from exc
        return api_response(message="Your review has been published.", status_code=201)


class ApplicationInput(serializers.ModelSerializer):
    consent = serializers.BooleanField(write_only=True)
    phone = serializers.RegexField(r"^\+?[0-9][0-9 ()-]{7,22}$", max_length=24)

    class Meta:
        model = PentestingApplication
        fields = (
            "full_name",
            "email",
            "phone",
            "is_student",
            "institution",
            "education",
            "skill_level",
            "experience",
            "motivation",
            "consent",
        )

    def validate(self, attrs):
        if not attrs.pop("consent", False):
            raise serializers.ValidationError({"consent": "Consent is required."})
        if attrs["is_student"] and not attrs.get("institution", "").strip():
            raise serializers.ValidationError({"institution": "Institution is required for students."})
        if not attrs["is_student"]:
            attrs["institution"] = ""
        if not 8 <= sum(char.isdigit() for char in attrs["phone"]) <= 15:
            raise serializers.ValidationError({"phone": "Enter 8 to 15 digits."})
        for value in attrs.values():
            if isinstance(value, str) and contains_active_content(value):
                raise serializers.ValidationError("Use plain text in application fields.")
        attrs["email"] = attrs["email"].lower()
        return attrs


class PentestingApplicationView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ExperienceWriteThrottle]

    def post(self, request, pk):
        course = get_object_or_404(Course, pk=pk, is_published=True, category=Course.CATEGORY_WEB_PENTESTING)
        if course.registration_closed or course.launch_status != Course.STATUS_LIVE:
            raise ValidationError("Registration is not currently open.")
        serializer = ApplicationInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        application = serializer.save(
            course=course,
            consent_at=timezone.now(),
            student=request.user if request.user.is_authenticated else None,
        )
        response = api_response(
            data={"reference": str(application.reference), "status": application.status}, status_code=201
        )
        response["Cache-Control"] = "no-store"
        return response


class ApplicationCheckoutView(APIView):
    permission_classes = [permissions.AllowAny]
    throttle_classes = [ExperienceWriteThrottle]

    def post(self, request, pk):
        reference = serializers.UUIDField().run_validation(request.data.get("reference"))
        application = get_object_or_404(PentestingApplication, reference=reference, course_id=pk)
        if application.status == "cancelled":
            raise ValidationError("Application cancelled. Contact support.")
        if application.student_id and (not request.user.is_authenticated or request.user.pk != application.student_id):
            raise PermissionDenied("Sign in with the applicant account.")
        response = api_response(data={"status": application.status, "payment_status": application.payment_status})
        response["Cache-Control"] = "no-store"
        return response
