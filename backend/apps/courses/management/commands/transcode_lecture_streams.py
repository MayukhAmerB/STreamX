import time

from django.core.management.base import BaseCommand
from django.db.models import Q

from apps.courses.models import Lecture
from apps.courses.services import VideoTranscodeError, transcode_lecture_to_hls


class Command(BaseCommand):
    help = "Transcode uploaded lecture videos into local HLS streams (Phase 2)."

    def add_arguments(self, parser):
        parser.add_argument("--lecture-id", type=int, help="Transcode a single lecture by ID")
        parser.add_argument("--module-id", type=int, help="Transcode all lectures in a module (Section)")
        parser.add_argument("--course-id", type=int, help="Transcode all lectures in a course")
        parser.add_argument(
            "--all-uploaded",
            action="store_true",
            help="Transcode all lectures that have uploaded video files",
        )
        parser.add_argument(
            "--pending",
            action="store_true",
            help="Process lectures with uploaded files that still need HLS generation",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Re-transcode even if stream status is already ready",
        )
        parser.add_argument(
            "--watch",
            action="store_true",
            help="Keep polling for new pending lecture uploads to transcode.",
        )
        parser.add_argument(
            "--poll-seconds",
            type=int,
            default=30,
            help="Polling interval to use with --watch (default: 30 seconds).",
        )

    def handle(self, *args, **options):
        selector_count = sum(
            bool(options.get(name))
            for name in ("lecture_id", "module_id", "course_id", "all_uploaded", "pending")
        )
        if selector_count != 1:
            self.stderr.write(
                self.style.ERROR(
                    "Specify exactly one selector: --lecture-id, --module-id, --course-id, --all-uploaded, or --pending."
                )
            )
            return

        watch = bool(options.get("watch"))
        poll_seconds = max(5, int(options.get("poll_seconds") or 30))

        while True:
            processed, skipped, failed = self._run_batch(options)
            summary = f"Transcode complete. processed={processed}, skipped={skipped}, failed={failed}"
            if failed:
                self.stderr.write(self.style.ERROR(summary))
            else:
                self.stdout.write(self.style.SUCCESS(summary))

            if not watch:
                return

            self.stdout.write(f"Watching for pending uploads. Sleeping {poll_seconds}s...")
            time.sleep(poll_seconds)

    def _select_queryset(self, options):
        lecture_id = options.get("lecture_id")
        module_id = options.get("module_id")
        course_id = options.get("course_id")
        all_uploaded = options.get("all_uploaded")
        pending = options.get("pending")

        queryset = Lecture.objects.select_related("section__course").all()
        if lecture_id:
            return queryset.filter(pk=lecture_id)
        if module_id:
            return queryset.filter(section_id=module_id)
        if course_id:
            return queryset.filter(section__course_id=course_id)
        if all_uploaded:
            return queryset.filter(video_file__isnull=False).exclude(video_file="")
        if pending:
            return (
                queryset.filter(video_file__isnull=False)
                .exclude(video_file="")
                .filter(
                    Q(stream_status__in=[Lecture.STREAM_PENDING, Lecture.STREAM_UPLOADED, Lecture.STREAM_PROCESSING, Lecture.STREAM_FAILED])
                    | Q(stream_manifest_key="")
                )
            )
        return queryset.none()

    def _run_batch(self, options):
        force = bool(options.get("force"))
        queryset = self._select_queryset(options)
        lecture_ids = list(queryset.values_list("pk", flat=True))
        processed = 0
        skipped = 0
        failed = 0

        for lecture_id in lecture_ids:
            lecture = Lecture.objects.select_related("section__course").get(pk=lecture_id)
            if not lecture.video_file:
                skipped += 1
                self.stdout.write(f"SKIP lecture {lecture.pk}: no uploaded video file")
                continue

            if not force and lecture.stream_status == Lecture.STREAM_READY and lecture.stream_manifest_key:
                skipped += 1
                self.stdout.write(f"SKIP lecture {lecture.pk}: HLS stream already ready")
                continue

            try:
                transcode_lecture_to_hls(lecture)
                processed += 1
                self.stdout.write(
                    self.style.SUCCESS(
                        f"OK lecture {lecture.pk}: adaptive stream ready ({lecture.stream_manifest_key})"
                    )
                )
            except VideoTranscodeError as exc:
                failed += 1
                self.stderr.write(self.style.ERROR(f"FAIL lecture {lecture.pk}: {exc}"))

        return processed, skipped, failed
