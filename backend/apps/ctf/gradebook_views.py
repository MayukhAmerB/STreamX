"""HTTP mapping for the unified gradebook (``/api/gradebook/``). Read-only."""

from __future__ import annotations

import csv

from config.audit import log_security_event
from config.response import api_response
from config.throttling import ClientIpScopedRateThrottle, ClientIpUserRateThrottle
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework.views import APIView

from . import exports, gradebook
from .gradebook_serializers import (
    UnifiedBatchGradebookSerializer,
    UnifiedGradebookCourseListSerializer,
    UnifiedStudentGradebookSerializer,
)


def _ok(serializer_class, payload):
    return api_response(data=serializer_class(payload).data)


class _GradebookView(APIView):
    throttle_classes = [ClientIpUserRateThrottle, ClientIpScopedRateThrottle]
    throttle_scope = "ctf_read"


class MyGradebookView(_GradebookView):
    @extend_schema(operation_id="gradebook_me_retrieve", responses={200: UnifiedStudentGradebookSerializer})
    def get(self, request):
        return _ok(UnifiedStudentGradebookSerializer, gradebook.my_gradebook(request.user))


class GradebookCourseListView(_GradebookView):
    @extend_schema(operation_id="gradebook_courses_list", responses={200: UnifiedGradebookCourseListSerializer})
    def get(self, request):
        gradebook.require_reader(request.user)
        courses = gradebook.viewable_courses(request.user).order_by("title", "id")
        return _ok(UnifiedGradebookCourseListSerializer, {"results": [gradebook.course_dict(item) for item in courses]})


class BatchGradebookView(_GradebookView):
    @extend_schema(operation_id="gradebook_courses_retrieve", responses={200: UnifiedBatchGradebookSerializer})
    def get(self, request, course_id):
        gradebook.require_reader(request.user)
        course = gradebook.viewable_course_or_404(request.user, course_id)
        return _ok(UnifiedBatchGradebookSerializer, gradebook.batch_gradebook(course))


class BatchGradebookCsvView(_GradebookView):
    throttle_scope = "report_export"

    @extend_schema(operation_id="gradebook_courses_export_retrieve", responses={(200, "text/csv"): OpenApiTypes.STR})
    def get(self, request, course_id):
        gradebook.require_reader(request.user)
        course = gradebook.viewable_course_or_404(request.user, course_id)
        book = gradebook.batch_gradebook(course)
        log_security_event("gradebook.exported", request=request, course_id=course.pk)

        def chunks():
            writer = csv.writer(exports._Echo())
            yield "﻿"
            for row in gradebook.batch_csv_rows(book):
                yield writer.writerow([exports.csv_cell(value) for value in row])

        return exports.csv_response(chunks(), exports.export_filename("gradebook", course.slug or str(course.pk)))


class StudentGradebookView(_GradebookView):
    @extend_schema(operation_id="gradebook_students_retrieve", responses={200: UnifiedStudentGradebookSerializer})
    def get(self, request, student_id):
        gradebook.require_reader(request.user)
        student = gradebook.viewable_student_or_404(request.user, student_id)
        return _ok(UnifiedStudentGradebookSerializer, gradebook.student_gradebook(student, viewer=request.user))
