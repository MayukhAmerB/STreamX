"""Response shape of the student identity block (``apps.users.identity``).

Field order is the owner's order: roll number, real name, handle (with the most
recent handle next to it), stats; record fields follow in the parent shape.
"""

from __future__ import annotations

from rest_framework import serializers


class StudentIdentityStatsSerializer(serializers.Serializer):
    xp = serializers.IntegerField(allow_null=True, help_text="Null while the engagement switch is off.")
    rank = serializers.CharField(allow_null=True, help_text="Engagement level title (null while engagement is off).")
    attendance_percent = serializers.FloatField(allow_null=True, help_text="Attended = 40+ minutes live.")
    attendance_attended = serializers.IntegerField()
    attendance_total = serializers.IntegerField()
    reports_submitted = serializers.IntegerField()
    reports_graded = serializers.IntegerField()
    reports_graded_average = serializers.FloatField(allow_null=True)
    exam_score = serializers.FloatField(allow_null=True, help_text="Average % of finalized exam results.")
    exams_taken = serializers.IntegerField()


class StudentIdentitySerializer(serializers.Serializer):
    roll_number = serializers.CharField(help_text="AL-SYD-<user id, 5 digits>.")
    real_name = serializers.CharField(allow_blank=True)
    handle = serializers.CharField(allow_null=True, help_text="At submission time on a record; null = no handle.")
    handle_most_recent = serializers.CharField(allow_null=True)
    handle_changed = serializers.BooleanField()
    stats = StudentIdentityStatsSerializer(allow_null=True)
    snapshot = serializers.BooleanField(help_text="True when roll/name/handle come from the record's snapshot.")
    user_id = serializers.IntegerField()
