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


class ConsoleStudentIdentitySerializer(serializers.Serializer):
    """The identity block on Console payloads: handles only (owner rule).

    No real name, e-mail or phone: the full identity lives in Django admin ->
    Examination. The roll number stays as the staff reference.
    """

    roll_number = serializers.CharField(help_text="AL-SYD-<user id, 5 digits>.")
    handle = serializers.CharField(allow_null=True, help_text="At submission time on a record; null = no handle.")
    handle_most_recent = serializers.CharField(allow_null=True)
    handle_changed = serializers.BooleanField()
    label = serializers.CharField(help_text="'@handle', or 'AL-SYD-00042 (no handle)'.")
    stats = StudentIdentityStatsSerializer(allow_null=True)
    snapshot = serializers.BooleanField(help_text="True when roll/handle come from the record's snapshot.")
    user_id = serializers.IntegerField()


class ConsoleOwnIdentitySerializer(ConsoleStudentIdentitySerializer):
    """The requesting student's own block on their own Console screens (e.g. ``/api/gradebook/me/``).

    The Console block plus ``real_name``, for the student about themselves only.
    Never use it on a staff or another student's payload: those stay handle-only.
    """

    real_name = serializers.CharField(allow_blank=True, help_text="The requesting student's own full name.")

    def get_fields(self):
        # Owner order: roll number, real name, handle, ...
        fields = super().get_fields()
        ordered = {"roll_number": fields.pop("roll_number"), "real_name": fields.pop("real_name")}
        ordered.update(fields)
        return ordered


class ConsoleStudentRefSerializer(serializers.Serializer):
    """A student reference on Console payloads: no real name, no e-mail."""

    id = serializers.IntegerField()
    roll_number = serializers.CharField(help_text="AL-SYD-<user id, 5 digits>.")
    handle = serializers.CharField(allow_null=True)
    label = serializers.CharField(help_text="'@handle', or 'AL-SYD-00042 (no handle)'.")
