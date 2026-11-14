import time

from django.core.management.base import BaseCommand

from apps.courses import transcode_queue
from apps.courses.models import Lecture
from apps.courses.services import VideoTranscodeError, transcode_lecture_to_hls

GC_INTERVAL_SECONDS = 3600


class Command(BaseCommand):
    help = (
        "Transcode uploaded lecture videos into local HLS streams. --pending works the queue: class recordings "
        "first, claims with SELECT ... SKIP LOCKED (several transcoders may run), retries failures with backoff "
        "and swaps each finished stream in blue/green."
    )

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
            help="Work the transcode queue (new uploads, class recordings, due retries)",
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
        if options.get("pending"):
            self._work_queue(watch=watch, poll_seconds=poll_seconds)
            return

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

    # ------------------------------------------------------------- queue
    def _work_queue(self, *, watch, poll_seconds):
        worker = transcode_queue.worker_identity()
        transcode_queue.release_own_stale_claims()
        next_gc = 0.0
        while True:
            transcode_queue.touch_heartbeat()
            counts = {"ready": 0, "failed": 0, "superseded": 0}
            while True:
                result = transcode_queue.process_next(worker=worker)
                transcode_queue.touch_heartbeat()
                if result is None:
                    break
                outcome, lecture_id = result
                counts[outcome] = counts.get(outcome, 0) + 1
                line = f"{outcome.upper()} lecture {lecture_id}"
                if outcome == "failed":
                    self.stderr.write(self.style.ERROR(line))
                else:
                    self.stdout.write(self.style.SUCCESS(line))
            if time.monotonic() >= next_gc:
                next_gc = time.monotonic() + GC_INTERVAL_SECONDS
                transcode_queue.gc_stale_stream_revisions()
            summary = (
                f"Transcode queue drained. ready={counts['ready']}, failed={counts['failed']}, "
                f"superseded={counts['superseded']}"
            )
            if counts["failed"]:
                self.stderr.write(self.style.ERROR(summary))
            else:
                self.stdout.write(self.style.SUCCESS(summary))
            if not watch:
                return
            time.sleep(poll_seconds)

    # ---------------------------------------------------- manual selectors
    def _select_queryset(self, options):
        lecture_id = options.get("lecture_id")
        module_id = options.get("module_id")
        course_id = options.get("course_id")
        all_uploaded = options.get("all_uploaded")

        queryset = Lecture.objects.select_related("section__course").all()
        if lecture_id:
            return queryset.filter(pk=lecture_id)
        if module_id:
            return queryset.filter(section_id=module_id)
        if course_id:
            return queryset.filter(section__course_id=course_id)
        if all_uploaded:
            return queryset.filter(video_file__isnull=False).exclude(video_file="")
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
