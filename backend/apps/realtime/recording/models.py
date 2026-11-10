"""Lifecycle record for a live class recording that becomes a module lecture.

States: recording -> finalizing -> processing -> published, with failed as the
error sink (retryable). Recordings found on disk by the "scan for existing
recordings" import start as imported (no module yet) and join the same path at
finalizing once an admin picks the module. Transitions live in
recording/state.py.
"""

from django.conf import settings
from django.db import models
from django.db.models import Q


class ClassRecording(models.Model):
    SOURCE_SERVER = "server"
    SOURCE_OBS_UPLOAD = "obs_upload"
    SOURCE_LIVEKIT_EGRESS = "livekit_egress"
    SOURCE_IMPORTED = "imported"
    SOURCE_CHOICES = [
        (SOURCE_SERVER, "Server recording (OBS stream)"),
        (SOURCE_OBS_UPLOAD, "OBS file upload (replacement)"),
        (SOURCE_LIVEKIT_EGRESS, "LiveKit egress (Host Studio)"),
        (SOURCE_IMPORTED, "Imported (found on the server)"),
    ]

    STATE_RECORDING = "recording"
    STATE_FINALIZING = "finalizing"
    STATE_PROCESSING = "processing"
    STATE_PUBLISHED = "published"
    STATE_FAILED = "failed"
    STATE_IMPORTED = "imported"
    STATE_CHOICES = [
        (STATE_RECORDING, "Recording"),
        (STATE_FINALIZING, "Finalizing"),
        (STATE_PROCESSING, "Processing"),
        (STATE_PUBLISHED, "Published"),
        (STATE_FAILED, "Failed"),
        (STATE_IMPORTED, "Imported (unassigned)"),
    ]
    ACTIVE_STATES = (STATE_RECORDING, STATE_FINALIZING)

    session = models.ForeignKey(
        "realtime.RealtimeSession",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="class_recordings",
    )
    module = models.ForeignKey(
        "courses.Section",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="class_recordings",
        verbose_name="Module",
    )
    lecture = models.ForeignKey(
        "courses.Lecture",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="class_recordings",
    )
    livekit_recording = models.OneToOneField(
        "realtime.RealtimeSessionRecording",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="class_recording",
        help_text="Host Studio egress recording this class recording was built from.",
    )
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="class_recordings_started",
    )
    source = models.CharField(max_length=20, choices=SOURCE_CHOICES)
    state = models.CharField(max_length=20, choices=STATE_CHOICES, default=STATE_RECORDING)
    error = models.TextField(blank=True, default="")
    # Server recordings: directory holding the MPEG-TS parts (one per OBS connection).
    work_dir = models.CharField(max_length=1024, blank=True, default="")
    # Egress recordings: the LiveKit output file to publish. Imported
    # recordings: the absolute path of the file found on the server.
    source_path = models.CharField(max_length=1024, blank=True, default="")
    # Imported recordings: what the file looked like when it was scanned, so a
    # re-scan recognises it (path + size + mtime) instead of importing it twice.
    source_size_bytes = models.BigIntegerField(null=True, blank=True)
    source_mtime = models.FloatField(null=True, blank=True)
    files_deleted_at = models.DateTimeField(
        null=True, blank=True, help_text="When an admin deleted this recording's files."
    )
    # Files the web tier cannot delete itself (the /recordings volume is
    # read-only there) are queued here for the stream recorder.
    delete_requested_kinds = models.CharField(max_length=64, blank=True, default="")
    delete_requested_at = models.DateTimeField(null=True, blank=True)
    part_count = models.PositiveIntegerField(default=0)
    captured_bytes = models.BigIntegerField(default=0, help_text="Bytes captured into parts (server recordings).")
    file_size_bytes = models.BigIntegerField(null=True, blank=True, help_text="Size of the published source file.")
    duration_seconds = models.PositiveIntegerField(null=True, blank=True)
    attempts = models.PositiveIntegerField(default=0)
    recorder_heartbeat_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    stop_requested_at = models.DateTimeField(null=True, blank=True)
    finalized_at = models.DateTimeField(null=True, blank=True)
    published_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        verbose_name = "Class recording"
        verbose_name_plural = "Class recordings"
        constraints = [
            # One live capture per session at a time: double-clicks and
            # concurrent stream/start calls can never fork the recording. A new
            # take may start while the previous one is still finalizing.
            models.UniqueConstraint(
                fields=["session"],
                condition=Q(source="server", state="recording"),
                name="uniq_capturing_server_class_recording_per_session",
            ),
        ]
        indexes = [
            models.Index(fields=["state", "source"]),
            models.Index(fields=["session", "-created_at"]),
        ]

    @property
    def is_active(self):
        return self.state in self.ACTIVE_STATES

    def __str__(self):
        session_title = getattr(self.session, "title", "") or "session"
        return f"Class recording #{self.pk} ({self.get_source_display()}) - {session_title}"
