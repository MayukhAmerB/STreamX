"""Weekly reports: virus scanning (fail closed), quarantine, re-scans, private storage.

No real ClamAV is needed: ``tests.clamd_fake.FakeClamd`` is a stdlib TCP server
speaking clamd's protocol, and the default test scanner ("fake") flags the
EICAR test string and STREAMX-TEST-VIRUS markers. API-level tests use the
marker (not EICAR) for files that touch the disk, so a desktop antivirus never
interferes with the test run.
"""

import io
import os
import shutil
import sys
import tempfile
import uuid
import zipfile
from datetime import timedelta
from io import StringIO
from pathlib import Path
from unittest import mock

from apps.core.circuit import get_breaker
from apps.core.models import OutboxEvent
from apps.core.outbox import drain_outbox
from apps.notifications.models import NotificationRecipient
from apps.reports import antivirus, checks, rescan
from apps.reports.antivirus import (
    EICAR_SIGNATURE,
    ClamdScanner,
    ScannerError,
    ScanRefused,
    parse_instream_reply,
)
from apps.reports.models import (
    ReportAttachment,
    ReportFile,
    ReportGrade,
    ReportQuarantineRecord,
    ReportSubmission,
)
from django.core.checks import ERROR
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from tests import factories as f
from tests import report_files as rf
from tests.clamd_fake import FAKE_VERSION, FakeClamd, closed_port
from tests.test_reports_api import ReportsTestCase

MARKER = b"STREAMX-TEST-VIRUS"


def marked_pdf(name="infected.pdf"):
    return rf.upload(name, rf.PDF_BYTES + b"%" + MARKER + b"\n", "application/pdf")


def clamd_settings(server_or_port, **extra):
    port = server_or_port if isinstance(server_or_port, int) else server_or_port.port
    values = {
        "REPORTS_ANTIVIRUS_SCANNER": "clamd",
        "CLAMD_HOST": "127.0.0.1",
        "CLAMD_PORT": port,
        "CLAMD_CONNECT_TIMEOUT_SECONDS": 2,
        "CLAMD_TIMEOUT_SECONDS": 5,
    }
    values.update(extra)
    return override_settings(**values)


def stored_files(root):
    """Every regular file under the private root except the staging area."""
    found = []
    for directory, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name != ".incoming"]
        found.extend(os.path.join(directory, name) for name in filenames)
    return found


def incoming_files(root):
    path = Path(root) / ".incoming"
    return list(path.iterdir()) if path.exists() else []


class _BreakerResetMixin:
    def setUp(self):
        super().setUp()
        get_breaker(antivirus.BREAKER_NAME).reset()
        antivirus.reset_probe_cache()
        self.addCleanup(get_breaker(antivirus.BREAKER_NAME).reset)
        self.addCleanup(antivirus.reset_probe_cache)


# ---------------------------------------------------------------------------
# clamd client against the fake TCP server
# ---------------------------------------------------------------------------
class ClamdClientTests(_BreakerResetMixin, SimpleTestCase):
    def scanner(self, server_or_port, **kwargs):
        port = server_or_port if isinstance(server_or_port, int) else server_or_port.port
        return ClamdScanner("127.0.0.1", port, connect_timeout=2, timeout=kwargs.pop("timeout", 5), **kwargs)

    def test_clean_stream(self):
        with FakeClamd() as server:
            payload = os.urandom(300 * 1024)
            self.assertEqual(self.scanner(server, chunk_bytes=64 * 1024).scan(io.BytesIO(payload)), (True, ""))
        self.assertEqual(server.streams, [payload])  # chunked INSTREAM reassembles exactly

    def test_eicar_is_found(self):
        with FakeClamd() as server:
            clean, signature = self.scanner(server).scan(io.BytesIO(b"prefix " + EICAR_SIGNATURE + b" suffix"))
        self.assertFalse(clean)
        self.assertEqual(signature, "Eicar-Test-Signature")

    def test_found_reply(self):
        with FakeClamd(mode="found") as server:
            self.assertEqual(self.scanner(server).scan(io.BytesIO(b"x")), (False, "Eicar-Test-Signature"))

    def test_error_reply_is_an_outage(self):
        with FakeClamd(mode="error") as server, self.assertRaises(ScannerError):
            self.scanner(server).scan(io.BytesIO(b"x"))

    def test_hang_up_without_reply_is_an_outage(self):
        with FakeClamd(mode="close") as server, self.assertRaises(ScannerError):
            self.scanner(server).scan(io.BytesIO(b"x"))

    def test_timeout_is_an_outage(self):
        with FakeClamd(mode="slow", delay=2.0) as server, self.assertRaises(ScannerError):
            self.scanner(server, timeout=0.3).scan(io.BytesIO(b"x"))

    def test_connection_refused_is_an_outage(self):
        with self.assertRaises(ScannerError):
            self.scanner(closed_port()).scan(io.BytesIO(b"x"))
        self.assertFalse(self.scanner(closed_port()).ping())

    def test_oversized_stream_is_refused(self):
        with FakeClamd() as server:
            scanner = self.scanner(server, max_stream_bytes=1024, chunk_bytes=256)
            with self.assertRaises(ScanRefused):  # known size: refused before connecting
                scanner.scan(io.BytesIO(b"x" * 2048), size=2048)
            with self.assertRaises(ScanRefused):  # unknown size: refused while streaming
                scanner.scan(io.BytesIO(b"x" * 2048))
        self.assertEqual(server.streams, [])
        with FakeClamd(stream_max=1000) as server, self.assertRaises(ScanRefused):  # clamd's own limit
            self.scanner(server, chunk_bytes=512).scan(io.BytesIO(b"x" * 4096))

    def test_version_and_ping(self):
        with FakeClamd() as server:
            scanner = self.scanner(server)
            self.assertTrue(scanner.ping())
            self.assertEqual(scanner.version(), FAKE_VERSION)
        self.assertEqual(server.commands, ["PING", "VERSION"])

    def test_reply_parsing(self):
        self.assertEqual(parse_instream_reply("stream: OK\0"), (True, ""))
        self.assertEqual(parse_instream_reply("stream: Win.Test.EICAR_HDB-1 FOUND"), (False, "Win.Test.EICAR_HDB-1"))
        with self.assertRaises(ScanRefused):
            parse_instream_reply("INSTREAM size limit exceeded. ERROR")
        with self.assertRaises(ScanRefused):
            parse_instream_reply("stream: Heuristics.Limits.Exceeded.MaxScanTime FOUND")
        self.assertEqual(
            parse_instream_reply("stream: Heuristics.Encrypted.Zip FOUND"), (False, "Heuristics.Encrypted.Zip")
        )
        for reply in ("", "garbage", "stream: ERROR", "Can't open file ERROR", "OK"):
            with self.subTest(reply=reply), self.assertRaises(ScannerError):
                parse_instream_reply(reply)

    def test_scan_path_records_scanner_and_version(self):
        with FakeClamd() as server, clamd_settings(server), tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file.bin"
            path.write_bytes(b"hello")
            verdict = antivirus.scan_path(path, size=5)
        self.assertTrue(verdict.clean)
        self.assertEqual((verdict.scanner, verdict.signature_version), ("clamd", FAKE_VERSION))

    def test_circuit_opens_after_repeated_outages(self):
        with clamd_settings(closed_port()), tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file.bin"
            path.write_bytes(b"hello")
            for _ in range(3):
                with self.assertRaises(antivirus.ScannerUnavailable):
                    antivirus.scan_path(path)
            self.assertEqual(get_breaker(antivirus.BREAKER_NAME).state(), "open")
            with mock.patch.object(ClamdScanner, "_connect", side_effect=AssertionError("must fail fast")):
                with self.assertRaises(antivirus.ScannerUnavailable):
                    antivirus.scan_path(path)

    @override_settings(REPORTS_ANTIVIRUS_SCANNER="off")
    def test_scanner_off_refuses(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(antivirus.ScannerUnavailable):
            path = Path(directory) / "file.bin"
            path.write_bytes(b"hello")
            antivirus.scan_path(path)

    def test_fake_scanner_finds_markers_across_chunks(self):
        scanner = antivirus.FakeScanner()
        padded = b"a" * (1024 * 1024 - 5) + EICAR_SIGNATURE  # straddles the 1 MiB read boundary
        self.assertEqual(scanner.scan(io.BytesIO(padded)), (False, "Eicar-Test-Signature"))
        self.assertEqual(scanner.scan(io.BytesIO(b"x" + MARKER)), (False, "StreamX.Test.Marker"))
        self.assertEqual(scanner.scan(io.BytesIO(b"plain")), (True, ""))


# ---------------------------------------------------------------------------
# Upload pipeline: scan before anything is stored, fail closed
# ---------------------------------------------------------------------------
class UploadScanningTests(_BreakerResetMixin, ReportsTestCase):
    def test_clean_upload_through_clamd_is_stored_with_its_scan_record(self):
        with FakeClamd() as server, clamd_settings(server):
            response = self.upload(file=rf.pdf("Week 1.pdf"), user=self.student)
        self.assertEqual(response.status_code, 201, response.data)
        stored = ReportFile.objects.get()
        self.assertEqual((stored.scan_status, stored.scanner), ("clean", "clamd"))
        self.assertEqual(stored.scan_signature_version, FAKE_VERSION)
        self.assertEqual(server.streams, [rf.PDF_BYTES])
        self.assertEqual(server.commands, ["VERSION", "INSTREAM"])
        path = Path(stored.file.path)
        self.assertEqual(path.suffix, ".bin")
        self.assertEqual(path.read_bytes(), rf.PDF_BYTES)
        if os.name == "posix":
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o750)
        self.assertEqual(incoming_files(self.private_root), [])

    def test_infected_upload_is_rejected_logged_and_recorded_but_never_stored(self):
        with FakeClamd(mode="found") as server, clamd_settings(server), self.assertLogs("security.audit") as logs:
            response = self.upload(file=rf.pdf("payload.pdf"), user=self.student)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "file_infected")
        self.assertEqual(response.data["message"], "This file was blocked by the virus scanner.")
        self.assertFalse(ReportFile.objects.exists())
        self.assertEqual(stored_files(self.private_root), [])
        self.assertEqual(incoming_files(self.private_root), [])
        record = ReportQuarantineRecord.objects.get()
        self.assertEqual((record.source, record.kind, record.action), ("upload", "submission", "rejected"))
        self.assertEqual((record.user, record.task), (self.student, self.task))
        self.assertEqual(record.signature, "Eicar-Test-Signature")
        self.assertEqual(record.signature_version, FAKE_VERSION)
        self.assertEqual(record.original_name, "payload.pdf")
        self.assertEqual(len(record.sha256), 64)
        self.assertEqual(record.quarantine_name, "")
        event = "\n".join(logs.output)
        for expected in ("reports.upload_blocked_by_antivirus", "Eicar-Test-Signature", record.sha256, "payload.pdf"):
            self.assertIn(expected, event)
        self.assertIn(f"'task_id': {self.task.pk}", event)
        self.assertIn(f"'user_id': {self.student.pk}", event)
        self.assertNotIn("%PDF", event)  # never the file content

    def test_scanner_unreachable_fails_closed_with_503(self):
        with clamd_settings(closed_port()):
            response = self.upload(user=self.student)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data["code"], "antivirus_unavailable")
        self.assertEqual(
            response.data["message"], "Virus scanner is temporarily unavailable, please try again in a minute."
        )
        self.assertIn("Retry-After", response)
        self.assertFalse(ReportFile.objects.exists())
        self.assertFalse(ReportQuarantineRecord.objects.exists())
        self.assertEqual(stored_files(self.private_root), [])
        self.assertEqual(incoming_files(self.private_root), [])

    def test_scanner_error_and_timeout_fail_closed(self):
        for mode in ("error", "slow", "close"):
            with self.subTest(mode=mode):
                get_breaker(antivirus.BREAKER_NAME).reset()
                with FakeClamd(mode=mode, delay=2.0) as server, clamd_settings(server, CLAMD_TIMEOUT_SECONDS=1):
                    response = self.upload(user=self.student)
                self.assertEqual(response.status_code, 503, response.data)
                self.assertFalse(ReportFile.objects.exists())
                self.assertEqual(stored_files(self.private_root), [])

    def test_file_too_large_for_the_scanner_is_refused(self):
        with FakeClamd() as server, clamd_settings(server, CLAMD_STREAM_MAX_BYTES=10):
            response = self.upload(user=self.student)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "file_too_large_to_scan")
        self.assertFalse(ReportFile.objects.exists())

    def test_marker_upload_with_default_fake_scanner(self):
        response = self.upload(file=marked_pdf(), user=self.student)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "file_infected")
        self.assertEqual(ReportQuarantineRecord.objects.get().signature, "StreamX.Test.Marker")
        self.assertEqual(stored_files(self.private_root), [])

    def test_zip_vault_is_scanned_as_a_whole(self):
        # Stored (not deflated) so the in-process fake sees the marker; real
        # clamd unpacks deflated archives itself (ScanArchive yes).
        vault = rf.zip_bytes(
            [("Vault/a.md", b"# notes"), ("Vault/b.md", b"evidence " + MARKER)], compression=zipfile.ZIP_STORED
        )
        response = self.upload(file=rf.upload("vault.zip", vault), user=self.student)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["code"], "file_infected")
        with FakeClamd() as server, clamd_settings(server):
            clean_vault = rf.zip_bytes([("Vault/a.md", b"# notes")])
            self.assertEqual(self.upload(file=rf.upload("vault.zip", clean_vault)).status_code, 201)
        self.assertEqual(server.streams, [clean_vault])  # the archive itself goes to clamd

    def test_reference_attachments_are_scanned(self):
        self.as_user(self.instructor)
        url = reverse("reports-manage-task-attachments", args=[self.task.pk])
        blocked = self.client.post(url, {"file": marked_pdf("brief.pdf")}, format="multipart")
        self.assertEqual(blocked.status_code, 400)
        self.assertEqual(blocked.data["code"], "file_infected")
        self.assertFalse(ReportAttachment.objects.exists())
        self.assertEqual(ReportQuarantineRecord.objects.get().kind, "attachment")
        with clamd_settings(closed_port()):
            self.assertEqual(self.client.post(url, {"file": rf.pdf()}, format="multipart").status_code, 503)
        ok = self.client.post(url, {"file": rf.pdf("brief.pdf")}, format="multipart")
        self.assertEqual(ok.status_code, 201)
        attachment = ReportAttachment.objects.get()
        self.assertEqual(attachment.scan_status, "clean")
        self.assertTrue(attachment.file.name.endswith(".bin"))
        self.assertEqual(ok.data["data"]["attachment"]["scan_status"], "clean")

    def test_annotated_feedback_files_are_scanned(self):
        submission = self.submit_pdf()
        self.as_user(self.instructor)
        url = reverse("reports-manage-submission-grade", args=[submission.pk])
        payload = {"action": "draft", "expected_revision": submission.revision, "feedback": "See notes"}
        blocked = self.client.post(url, {**payload, "annotated_file": marked_pdf("notes.pdf")}, format="multipart")
        self.assertEqual(blocked.status_code, 400)
        self.assertEqual(blocked.data["code"], "file_infected")
        self.assertFalse(ReportGrade.objects.exists())
        self.assertEqual(ReportQuarantineRecord.objects.get().kind, "feedback")
        with clamd_settings(closed_port()):
            down = self.client.post(url, {**payload, "annotated_file": rf.pdf("notes.pdf")}, format="multipart")
        self.assertEqual(down.status_code, 503)
        self.assertFalse(ReportGrade.objects.exists())
        ok = self.client.post(url, {**payload, "annotated_file": rf.pdf("notes.pdf")}, format="multipart")
        self.assertEqual(ok.status_code, 200, ok.data)
        grade = ReportGrade.objects.get()
        self.assertEqual((grade.annotated_scan_status, grade.annotated_scanner), ("clean", "fake"))
        self.assertTrue(grade.annotated_file.name.endswith(".bin"))
        self.assertEqual(ok.data["data"]["grade"]["annotated_file"]["scan_status"], "clean")

    def test_grade_conflict_discards_the_scanned_feedback_file(self):
        submission = self.submit_pdf()
        self.as_user(self.instructor)
        url = reverse("reports-manage-submission-grade", args=[submission.pk])
        stale = {"action": "draft", "expected_revision": submission.revision - 1, "annotated_file": rf.pdf()}
        self.assertEqual(self.client.post(url, stale, format="multipart").status_code, 409)
        names = {Path(path).name for path in stored_files(self.private_root)}
        self.assertEqual(names, {Path(ReportFile.objects.get().file.path).name})


# ---------------------------------------------------------------------------
# Downloads refuse anything without a clean scan record
# ---------------------------------------------------------------------------
def write_private(root, name, data):
    path = Path(root, *name.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


class DownloadGateTests(_BreakerResetMixin, ReportsTestCase):
    def legacy_file(self, data=rf.PDF_BYTES, **overrides):
        name = write_private(self.private_root, f"reports/submissions/{self.task.pk}/2026/10/{uuid.uuid4().hex}.pdf", data)
        fields = {
            "task": self.task,
            "owner": self.student,
            "file": name,
            "original_name": "old.pdf",
            "extension": "pdf",
            "content_type": "application/pdf",
            "size": len(data),
            "sha256": "0" * 64,
            "submitted": True,
        }
        fields.update(overrides)
        return ReportFile.objects.create(**fields)

    def test_files_uploaded_before_scanning_are_refused(self):
        legacy = self.legacy_file()
        self.assertEqual(legacy.scan_status, "unscanned")
        self.as_user(self.student)
        url = reverse("reports-file-download", args=[legacy.pk])
        response = self.client.get(url)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "file_not_scanned")
        self.assertEqual(self.client.get(url, {"inline": "1"}).status_code, 409)

    def test_infected_files_are_refused(self):
        infected = self.legacy_file(scan_status="infected", scan_threat="Eicar-Test-Signature")
        self.as_user(self.instructor)
        response = self.client.get(reverse("reports-file-download", args=[infected.pk]))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "file_infected")

    def test_unscanned_attachment_and_feedback_are_refused(self):
        name = write_private(self.private_root, "reports/attachments/1/2026/10/a.pdf", rf.PDF_BYTES)
        attachment = ReportAttachment.objects.create(
            task=self.task, file=name, original_name="a.pdf", extension="pdf", content_type="application/pdf", size=1
        )
        self.as_user(self.student)
        self.assertEqual(self.client.get(reverse("reports-attachment-download", args=[attachment.pk])).status_code, 409)
        submission = self.submit_pdf()
        ReportGrade.objects.create(
            submission=submission,
            annotated_file=write_private(self.private_root, "reports/feedback/2026/10/f.pdf", rf.PDF_BYTES),
            annotated_file_name="f.pdf",
            annotated_extension="pdf",
            annotated_content_type="application/pdf",
        )
        submission.status = ReportSubmission.STATUS_RETURNED
        submission.save()
        self.as_user(self.student)
        response = self.client.get(reverse("reports-feedback-file-download", args=[submission.pk]))
        self.assertEqual(response.status_code, 409)

    def test_presenter_hides_preview_of_unclean_files(self):
        self.legacy_file(submitted=False)
        staged = self.detail()["staged_files"]
        self.assertEqual(len(staged), 1)
        self.assertEqual(staged[0]["scan_status"], "unscanned")
        self.assertEqual(staged[0]["preview"], "none")

    def test_zip_export_skips_unclean_files(self):
        submission = self.submit_pdf()
        ReportFile.objects.filter(versions__submission=submission).update(scan_status="unscanned")
        self.as_user(self.instructor)
        response = self.client.get(reverse("reports-manage-task-zip", args=[self.task.pk]))
        self.assertEqual(response.status_code, 200)
        archive = zipfile.ZipFile(io.BytesIO(b"".join(response.streaming_content)))
        self.assertEqual(archive.namelist(), ["manifest.csv"])
        self.assertIn("NOT SCANNED YET: report.pdf", archive.read("manifest.csv").decode("utf-8-sig"))

    def test_admin_download_of_unscanned_file_redirects_with_message(self):
        legacy = self.legacy_file()
        admin = f.make_admin()
        self.client.force_login(admin)
        response = self.client.get(reverse("admin:reports_reportfile_download", args=[legacy.pk]))
        self.assertEqual(response.status_code, 302)
        self.assertIn(f"/{legacy.pk}/change/", response["Location"])

    def test_inline_images_are_sandboxed_and_svg_is_download_only(self):
        self.as_user(self.student)
        png_id = self.upload(file=rf.upload("shot.png", rf.image_bytes())).data["data"]["id"]
        inline = self.client.get(reverse("reports-file-download", args=[png_id]), {"inline": "1"})
        self.assertTrue(inline["Content-Disposition"].startswith("inline;"))
        self.assertIn("sandbox", inline["Content-Security-Policy"])
        self.assertEqual(inline["X-Content-Type-Options"], "nosniff")
        self.assertEqual(inline["Cache-Control"], "private, no-store")


# ---------------------------------------------------------------------------
# Re-scans with fresh signatures, quarantine
# ---------------------------------------------------------------------------
class RescanTests(_BreakerResetMixin, ReportsTestCase):
    def setUp(self):
        super().setUp()
        self.quarantine_root = tempfile.mkdtemp(prefix="reports-quarantine-")
        override = override_settings(REPORTS_QUARANTINE_ROOT=self.quarantine_root)
        override.enable()
        self.addCleanup(override.disable)
        self.addCleanup(shutil.rmtree, self.quarantine_root, True)
        self.admin = f.make_admin()

    def stored(self, data, *, ext="pdf", **overrides):
        name = write_private(self.private_root, f"reports/submissions/{self.task.pk}/2026/10/{uuid.uuid4().hex}.{ext}", data)
        fields = {
            "task": self.task,
            "owner": self.student,
            "file": name,
            "original_name": f"old.{ext}",
            "extension": ext,
            "content_type": "application/pdf",
            "size": len(data),
            "sha256": "a" * 64,
            "submitted": True,
        }
        fields.update(overrides)
        return ReportFile.objects.create(**fields)

    def test_legacy_file_is_scanned_renamed_and_becomes_downloadable(self):
        legacy = self.stored(rf.PDF_BYTES)
        out = StringIO()
        call_command("rescan_report_files", stdout=out)
        self.assertIn("scanned=1 clean=1 infected=0", out.getvalue())
        legacy.refresh_from_db()
        self.assertEqual((legacy.scan_status, legacy.scanner), ("clean", "fake"))
        self.assertTrue(legacy.file.name.endswith(".bin"))
        self.assertTrue(Path(legacy.file.path).exists())
        self.as_user(self.student)
        response = self.client.get(reverse("reports-file-download", args=[legacy.pk]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(b"".join(response.streaming_content), rf.PDF_BYTES)

    def test_later_detection_quarantines_blocks_and_notifies(self):
        item = self.stored(rf.PDF_BYTES + MARKER, ext="bin", scan_status="clean", scanned_at=timezone.now() - timedelta(days=3))
        original_path = Path(item.file.path)
        with self.assertLogs("security.audit") as logs:
            call_command("rescan_report_files", stdout=StringIO())
        item.refresh_from_db()
        self.assertEqual(item.scan_status, "infected")
        self.assertEqual(item.scan_threat, "StreamX.Test.Marker")
        self.assertFalse(original_path.exists())
        record = ReportQuarantineRecord.objects.get()
        self.assertEqual((record.source, record.action, record.kind), ("rescan", "quarantined", "submission"))
        self.assertEqual((record.object_id, record.user, record.task), (item.pk, self.student, self.task))
        quarantined = Path(self.quarantine_root, *record.quarantine_name.split("/"))
        self.assertTrue(quarantined.exists())
        self.assertTrue(quarantined.is_relative_to(Path(self.quarantine_root)))
        if os.name == "posix":
            self.assertEqual(quarantined.stat().st_mode & 0o777, 0)
        self.assertIn("reports.stored_file_quarantined", "\n".join(logs.output))
        self.assertTrue(NotificationRecipient.objects.filter(user=self.admin).exists())
        self.assertFalse(NotificationRecipient.objects.filter(user=self.student).exists())
        self.as_user(self.instructor)
        response = self.client.get(reverse("reports-file-download", args=[item.pk]))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data["code"], "file_infected")
        # Quarantined files are not scanned again.
        out = StringIO()
        call_command("rescan_report_files", "--all", stdout=out)
        self.assertIn("scanned=0", out.getvalue())

    def test_scanner_outage_changes_nothing(self):
        legacy = self.stored(rf.PDF_BYTES)
        with clamd_settings(closed_port()), self.assertRaises(CommandError):
            call_command("rescan_report_files", stdout=StringIO())
        legacy.refresh_from_db()
        self.assertEqual(legacy.scan_status, "unscanned")
        self.assertIsNone(legacy.scanned_at)

    def test_rescan_through_clamd_records_the_new_signature_version(self):
        item = self.stored(rf.PDF_BYTES, ext="bin", scan_status="clean", scanner="clamd", scan_signature_version="ClamAV 1.4.3/1/old")
        with FakeClamd() as server, clamd_settings(server):
            call_command("rescan_report_files", "--all", stdout=StringIO())
        item.refresh_from_db()
        self.assertEqual(item.scan_signature_version, FAKE_VERSION)

    def test_missing_files_do_not_stall_the_rescan(self):
        item = self.stored(rf.PDF_BYTES)
        os.remove(item.file.path)
        out = StringIO()
        call_command("rescan_report_files", stdout=out)
        self.assertIn("missing=1", out.getvalue())
        item.refresh_from_db()
        self.assertEqual(item.scan_status, "unscanned")
        self.assertIsNotNone(item.scanned_at)

    def test_shared_reference_file_is_quarantined_for_every_task(self):
        name = write_private(self.private_root, "reports/attachments/1/2026/10/shared.bin", rf.PDF_BYTES + MARKER)
        common = {"file": name, "original_name": "ref.pdf", "extension": "pdf", "content_type": "application/pdf", "scan_status": "clean"}
        first = ReportAttachment.objects.create(task=self.task, **common)
        second = ReportAttachment.objects.create(task=self.make_task(title="Copy"), **common)
        call_command("rescan_report_files", "--all", stdout=StringIO())
        self.assertEqual(set(ReportAttachment.objects.values_list("scan_status", flat=True)), {"infected"})
        self.assertEqual(ReportQuarantineRecord.objects.get().object_id, first.pk)
        self.assertNotEqual(first.pk, second.pk)

    def test_feedback_files_are_rescanned(self):
        submission = self.submit_pdf()
        grade = ReportGrade.objects.create(
            submission=submission,
            annotated_file=write_private(self.private_root, "reports/feedback/2026/10/x.bin", b"%PDF-1.4 " + MARKER),
            annotated_file_name="x.pdf",
            annotated_extension="pdf",
            annotated_scan_status="clean",
            graded_by=self.instructor,
        )
        call_command("rescan_report_files", "--all", stdout=StringIO())
        grade.refresh_from_db()
        self.assertEqual(grade.annotated_scan_status, "infected")
        self.assertEqual(ReportQuarantineRecord.objects.get().kind, "feedback")

    @override_settings(REPORTS_RESCAN_BATCH_SIZE=1)
    def test_periodic_outbox_rescan_continues_until_done(self):
        self.stored(rf.PDF_BYTES)
        self.stored(rf.PDF_BYTES)
        first = rescan.schedule_periodic_rescan()
        self.assertEqual(rescan.schedule_periodic_rescan().pk, first.pk)  # one per interval
        for _ in range(4):
            OutboxEvent.objects.update(available_at=timezone.now() - timedelta(seconds=1))
            drain_outbox(batch_size=10)
        self.assertEqual(set(ReportFile.objects.values_list("scan_status", flat=True)), {"clean"})
        events = OutboxEvent.objects.filter(event_type=rescan.EVENT_RESCAN)
        self.assertEqual(events.count(), 2)
        self.assertEqual(set(events.values_list("status", flat=True)), {OutboxEvent.STATUS_DELIVERED})


# ---------------------------------------------------------------------------
# Readiness, startup checks, management commands
# ---------------------------------------------------------------------------
class AntivirusOperationsTests(_BreakerResetMixin, ReportsTestCase):
    def setUp(self):
        super().setUp()
        from apps.core import health

        health.reset_readiness_cache()
        self.addCleanup(health.reset_readiness_cache)

    @override_settings(HEALTH_READINESS_CACHE_SECONDS=0)
    def test_readiness_reports_clamd_softly(self):
        body = self.client.get(reverse("health-ready")).json()
        self.assertEqual(body["upstreams"]["clamd"]["probe"], "ok")
        antivirus.reset_probe_cache()
        with clamd_settings(closed_port()):
            response = self.client.get(reverse("health-ready"))
        self.assertEqual(response.status_code, 200)  # a clamd restart never takes the site down
        body = response.json()
        self.assertEqual(body["upstreams"]["clamd"]["probe"], "unavailable")
        self.assertIn("clamd", body["warnings"])

    def test_check_antivirus_command(self):
        out = StringIO()
        call_command("check_antivirus", stdout=out)
        self.assertIn("scanner=fake", out.getvalue())
        with FakeClamd() as server, clamd_settings(server):
            out = StringIO()
            call_command("check_antivirus", stdout=out)
        self.assertIn(FAKE_VERSION, out.getvalue())
        down = {"scanner": "clamd", "state": "unavailable", "version": ""}
        out = StringIO()
        with mock.patch(
            "apps.reports.management.commands.check_antivirus.scanner_status", return_value=down
        ) as status, self.assertRaises(CommandError):
            call_command("check_antivirus", "--wait-seconds", "2", "--interval", "1", stdout=out)
        self.assertIn("not ready yet", out.getvalue())
        self.assertGreaterEqual(status.call_count, 2)  # bounded retry
        with clamd_settings(closed_port()), self.assertRaises(CommandError):
            call_command("check_antivirus", stdout=StringIO())

    def test_check_report_storage_command(self):
        quarantine = tempfile.mkdtemp(prefix="reports-quarantine-")
        self.addCleanup(shutil.rmtree, quarantine, True)
        with override_settings(REPORTS_QUARANTINE_ROOT=quarantine):
            hardened = {"noexec": True, "nosuid": True, "nodev": True}
            with mock.patch("apps.reports.management.commands.check_report_storage.mount_flags", return_value=hardened):
                out = StringIO()
                call_command("check_report_storage", "--require-noexec", stdout=out)
                self.assertIn("report storage OK", out.getvalue())
            exec_allowed = {**hardened, "noexec": False}
            with mock.patch(
                "apps.reports.management.commands.check_report_storage.mount_flags", return_value=exec_allowed
            ), self.assertRaisesMessage(CommandError, "noexec"):
                call_command("check_report_storage", "--require-noexec", stdout=StringIO())
        with override_settings(REPORTS_QUARANTINE_ROOT=os.path.join(quarantine, "missing")):
            with self.assertRaisesMessage(CommandError, "does not exist"):
                call_command("check_report_storage", stdout=StringIO())

    @mock.patch.object(sys, "platform", "linux")
    def test_mount_flags_reads_statvfs(self):
        from apps.reports.storage import mount_flags

        fake = mock.Mock(f_flag=8 | 2 | 4)
        with mock.patch("apps.reports.storage.os.statvfs", create=True, return_value=fake):
            self.assertEqual(mount_flags("/x"), {"noexec": True, "nosuid": True, "nodev": True})


class ReportChecksTests(SimpleTestCase):
    def test_production_requires_clamd(self):
        for scanner in ("fake", "off", "", "tests.custom.Scanner"):
            with self.subTest(scanner=scanner), override_settings(APP_ENV="production", REPORTS_ANTIVIRUS_SCANNER=scanner):
                messages = checks.check_report_antivirus_posture()
                self.assertEqual([m.id for m in messages if m.level >= ERROR], ["reports.E001"])
        with override_settings(APP_ENV="production", REPORTS_ANTIVIRUS_SCANNER="clamd", CLAMD_HOST="clamav"):
            self.assertEqual(checks.check_report_antivirus_posture(), [])
        with override_settings(APP_ENV="development", REPORTS_ANTIVIRUS_SCANNER="fake"):
            self.assertEqual(checks.check_report_antivirus_posture(), [])

    def test_stream_limit_must_cover_the_largest_file(self):
        with override_settings(REPORTS_MAX_FILE_SIZE_MB_CAP=200, CLAMD_STREAM_MAX_BYTES=100 * 1024 * 1024):
            self.assertIn("reports.E002", [m.id for m in checks.check_report_storage_settings()])
        with override_settings(REPORTS_MAX_FILE_SIZE_MB_CAP=200, CLAMD_STREAM_MAX_BYTES=210 * 1024 * 1024):
            self.assertNotIn("reports.E002", [m.id for m in checks.check_report_storage_settings()])

    def test_private_storage_must_not_overlap_media(self):
        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, True)
        with override_settings(MEDIA_ROOT=media, REPORTS_PRIVATE_ROOT=os.path.join(media, "reports")):
            self.assertIn("reports.E003", [m.id for m in checks.check_report_storage_settings()])
        with override_settings(REPORTS_PRIVATE_ROOT="/srv/a", REPORTS_QUARANTINE_ROOT="/srv/a"):
            self.assertIn("reports.E003", [m.id for m in checks.check_report_storage_settings()])

    def test_settings_defaults(self):
        from django.conf import settings

        self.assertEqual(settings.REPORTS_ANTIVIRUS_SCANNER, "fake")  # tests and local dev
        self.assertEqual((settings.CLAMD_HOST, settings.CLAMD_PORT), ("clamav", 3310))
        self.assertGreaterEqual(settings.CLAMD_STREAM_MAX_BYTES, settings.REPORTS_MAX_FILE_SIZE_MB_CAP * 1024 * 1024)
        self.assertIn("clamd", settings.CIRCUIT_BREAKERS)


class NoServerSideRenderingTests(SimpleTestCase):
    """Nothing in the reports pipeline converts, renders or unpacks a file."""

    # Pillow only *verifies* report images (header/CRC checks, no decode);
    # anything that converts, thumbnails, unpacks or shells out is forbidden.
    FORBIDDEN = (
        "subprocess",
        "os.system",
        "popen",
        "soffice",
        "libreoffice",
        "imagemagick",
        "wand.",
        "extractall",
        ".extract(",
        "pdf2image",
        "fitz",
        ".thumbnail(",
        ".convert(",
        ".load()",
    )

    def test_reports_code_never_executes_or_renders_files(self):
        root = Path(__file__).resolve().parents[1]
        sources = list((root / "apps" / "reports").rglob("*.py")) + [root / "config" / "upload_validators.py"]
        for source in sources:
            if "migrations" in source.parts:
                continue
            text = source.read_text(encoding="utf-8")
            if source.name == "upload_validators.py":
                text = text[text.index("REPORT_ALLOWED_EXTENSIONS") :]  # the report section only
            for token in self.FORBIDDEN:
                with self.subTest(source=source.name, token=token):
                    self.assertNotIn(token, text)
