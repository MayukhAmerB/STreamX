from django.core.management.base import BaseCommand

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
            "--force",
            action="store_true",
            help="Re-transcode even if stream status is already ready",
        )

    def handle(self, *args, **options):
        lecture_id = options.get("lecture_id")
        module_id = options.get("module_id")
        course_id = options.get("course_id")
        all_uploaded = options.get("all_uploaded")
        force = options.get("force")

        selected_flags = [bool(lecture_id), bool(module_id), bool(course_id), bool(all_uploaded)]
        if sum(selected_flags) != 1:
            self.stderr.write(
                self.style.ERROR(
                    "Specify exactly one selector: --lecture-id, --module-id, --course-id, or --all-uploaded."
                )
            )
            return

        queryset = Lecture.objects.select_related("section__course").all()
        if lecture_id:
            queryset = queryset.filter(pk=lecture_id)
        elif module_id:
            queryset = queryset.filter(section_id=module_id)
        elif course_id:
            queryset = queryset.filter(section__course_id=course_id)
        elif all_uploaded:
            queryset = queryset.filter(video_file__isnull=False).exclude(video_file="")

        processed = 0
        skipped = 0
        failed = 0

        for lecture in queryset.iterator():
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
                        f"OK lecture {lecture.pk}: stream ready ({lecture.stream_manifest_key})"
                    )
                )
            except VideoTranscodeError as exc:
                failed += 1
                self.stderr.write(self.style.ERROR(f"FAIL lecture {lecture.pk}: {exc}"))

        summary = f"Transcode complete. processed={processed}, skipped={skipped}, failed={failed}"
        if failed:
            self.stderr.write(self.style.ERROR(summary))
        else:
            self.stdout.write(self.style.SUCCESS(summary))
