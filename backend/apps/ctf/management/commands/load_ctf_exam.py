"""Load (or update) an OSINT CTF exam from its private JSON file.

Production (the file never enters an image)::

    docker compose -f docker-compose.hostinger.yml exec -T backend \\
        python manage.py load_ctf_exam --file - < OSINTCTF/private/exams/<slug>.json

Only counts are printed: never answers, hashes or instructor notes.
"""

from __future__ import annotations

import sys

from django.core.management.base import BaseCommand, CommandError

from apps.ctf.answers import CtfNotConfigured
from apps.ctf.loader import MAX_FILE_BYTES, ExamFileError, load_exam


class Command(BaseCommand):
    help = "Validate an exam JSON file, hash its answers and load it (exam + questions) in one transaction."
    stealth_options = ("stdin",)

    def add_arguments(self, parser):
        parser.add_argument("--file", required=True, help="Path to the exam JSON file, or - to read standard input.")
        parser.add_argument("--dry-run", action="store_true", help="Validate and report, but save nothing.")
        parser.add_argument(
            "--allow-content-change",
            action="store_true",
            help="Allow changing or removing questions students have already answered.",
        )
        parser.add_argument(
            "--materials-root",
            default="",
            help="Optional: the OSINTCTF folder, to confirm every evidence file exists.",
        )

    def _read(self, source, stdin):
        if source == "-":
            stream = stdin or sys.stdin
            stream = getattr(stream, "buffer", stream)
            data = stream.read(MAX_FILE_BYTES + 1)
        else:
            try:
                with open(source, "rb") as handle:
                    data = handle.read(MAX_FILE_BYTES + 1)
            except OSError as exc:
                raise CommandError(f"Cannot read {source}: {exc.strerror or exc}") from None
        return data.encode("utf-8") if isinstance(data, str) else data

    def handle(self, *args, **options):
        raw = self._read(options["file"], options.get("stdin"))
        try:
            report = load_exam(
                raw,
                dry_run=options["dry_run"],
                allow_content_change=options["allow_content_change"],
                materials_root=options["materials_root"] or None,
            )
        except ExamFileError as exc:
            raise CommandError("The exam file was not loaded:\n- " + "\n- ".join(exc.problems)) from None
        except CtfNotConfigured:
            raise CommandError("CTF_ANSWER_PEPPER is not configured; set it before loading an exam.") from None

        prefix = "[dry run, nothing saved] " if report.dry_run else ""
        action = "created" if report.exam_created else "updated"
        self.stdout.write(f"{prefix}Exam {report.slug}: {action}.")
        self.stdout.write(
            f"{prefix}Questions: {report.question_count} in file, {report.created} new, {report.updated} changed, "
            f"{report.unchanged} unchanged, {report.deactivated} deactivated, {report.removed} removed."
        )
        self.stdout.write(f"{prefix}Total points: {report.total_points}.")
        if report.eligible_courses is not None:
            self.stdout.write(f"{prefix}Eligible batches set: {report.eligible_courses}.")
        if report.changed_with_attempts:
            self.stdout.write(
                f"{prefix}Changed questions that already had answers: {len(report.changed_with_attempts)}."
            )
        self.stdout.write(f"{prefix}Content SHA-256: {report.content_sha256[:16]}...")
        if not report.dry_run:
            self.stdout.write(self.style.SUCCESS("Loaded. Publish the exam in Django admin when it is ready."))
