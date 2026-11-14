"""Profile image intake (apps.profiles.images): type and size limits, the virus
scan, metadata PII, EXIF/GPS stripping and polyglot destruction.

No database: ``process_upload`` is pure apart from the private temp folder.
"""

from __future__ import annotations

import io
import os
import shutil
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from PIL import Image, PngImagePlugin

from apps.profiles import pii
from apps.profiles.images import ImageMetadataPii, ImageRejected, metadata_texts, process_upload, sniff_format
from apps.reports.antivirus import EICAR_SIGNATURE, ScannerUnavailable

CTX = pii.ScanContext(full_name="Ravi Kumar Sharma", email="ravi.sharma99@example.com", phone="9811122333")
GPS_IFD = 0x8825


def jpeg_bytes(size=(640, 480), *, exif=None, comment=None, color=(30, 30, 30)) -> bytes:
    image = Image.new("RGB", size, color)
    buffer = io.BytesIO()
    kwargs = {"format": "JPEG", "quality": 90}
    if exif is not None:
        kwargs["exif"] = exif
    if comment:
        kwargs["comment"] = comment
    image.save(buffer, **kwargs)
    return buffer.getvalue()


def exif_with(artist=None, gps=True, description=None):
    exif = Image.Exif()
    if artist:
        exif[0x013B] = artist
    if description:
        exif[0x010E] = description
    exif[0x0110] = "Pixel 8"  # camera model: not text a person typed
    if gps:
        exif.get_ifd(GPS_IFD).update({1: "N", 2: (28.0, 36.0, 50.0), 3: "E", 4: (77.0, 12.0, 30.0)})
    return exif


def png_bytes(size=(300, 300), text=None, mode="RGBA") -> bytes:
    image = Image.new(mode, size, (200, 200, 200, 128) if mode == "RGBA" else (200, 200, 200))
    info = PngImagePlugin.PngInfo()
    for key, value in (text or {}).items():
        info.add_text(key, value)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", pnginfo=info)
    return buffer.getvalue()


def upload(data: bytes, name="photo.jpg", content_type="image/jpeg"):
    return SimpleUploadedFile(name, data, content_type=content_type)


class ImageTestCase(SimpleTestCase):
    def setUp(self):
        super().setUp()
        self.root = tempfile.mkdtemp(prefix="profiles-test-")
        self.override = override_settings(PROFILES_PRIVATE_ROOT=self.root, REPORTS_ANTIVIRUS_SCANNER="fake")
        self.override.enable()

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.root, ignore_errors=True)
        super().tearDown()

    def incoming_is_empty(self):
        folder = os.path.join(self.root, ".incoming")
        return not os.path.isdir(folder) or not os.listdir(folder)


class SniffTests(SimpleTestCase):
    def test_signatures(self):
        self.assertEqual(sniff_format(jpeg_bytes()[:16]), "JPEG")
        self.assertEqual(sniff_format(png_bytes()[:16]), "PNG")
        self.assertEqual(sniff_format(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "WEBP")
        self.assertIsNone(sniff_format(b"GIF89a"))
        self.assertIsNone(sniff_format(b"<svg xmlns="))
        self.assertIsNone(sniff_format(b"%PDF-1.7"))


class ProcessUploadTests(ImageTestCase):
    def test_exif_and_gps_are_stripped_and_output_is_webp(self):
        data = jpeg_bytes((1200, 900), exif=exif_with())
        with Image.open(io.BytesIO(data)) as original:
            self.assertTrue(original.getexif().get_ifd(GPS_IFD), "fixture has GPS")
        result = process_upload(upload(data), kind="gallery", ctx=CTX)
        self.assertEqual(result.content_type, "image/webp")
        self.assertIn("location", result.stripped)
        self.assertIn("exif", result.stripped)
        with Image.open(io.BytesIO(result.data)) as clean:
            self.assertEqual(clean.format, "WEBP")
            self.assertFalse(clean.getexif())
            self.assertNotIn("exif", clean.info)
            self.assertNotIn("icc_profile", clean.info)
            self.assertNotIn("xmp", clean.info)
        self.assertNotIn(b"Exif", result.data)
        self.assertNotIn(b"Pixel 8", result.data)
        self.assertTrue(self.incoming_is_empty())

    def test_avatar_and_banner_are_cropped_to_their_slot(self):
        avatar = process_upload(upload(jpeg_bytes((1000, 700))), kind="avatar", ctx=CTX)
        self.assertEqual((avatar.width, avatar.height), (512, 512))
        banner = process_upload(upload(jpeg_bytes((3000, 2000))), kind="banner", ctx=CTX)
        self.assertEqual((banner.width, banner.height), (2400, 800))
        small = process_upload(upload(jpeg_bytes((300, 200))), kind="avatar", ctx=CTX)
        self.assertEqual(small.width, small.height)
        self.assertLessEqual(small.width, 200, "never upscaled")

    def test_png_with_alpha_keeps_transparency(self):
        result = process_upload(upload(png_bytes(), "a.png", "image/png"), kind="gallery", ctx=CTX)
        with Image.open(io.BytesIO(result.data)) as clean:
            self.assertEqual(clean.mode, "RGBA")

    def test_polyglot_payloads_do_not_survive(self):
        html = b"<html><script>alert(document.cookie)</script></html>"
        zip_tail = b"PK\x03\x04" + b"\x00" * 26 + b"evil.js"
        data = jpeg_bytes() + html + zip_tail
        result = process_upload(upload(data), kind="gallery", ctx=CTX)
        self.assertNotIn(b"<script", result.data)
        self.assertNotIn(b"PK\x03\x04", result.data)
        self.assertNotIn(b"evil.js", result.data)

    def test_jpeg_comment_with_html_is_dropped(self):
        result = process_upload(upload(jpeg_bytes(comment=b"<svg onload=alert(1)>")), kind="gallery", ctx=CTX)
        self.assertNotIn(b"onload", result.data)

    def test_metadata_with_personal_information_is_refused(self):
        cases = [
            jpeg_bytes(exif=exif_with(artist="Ravi Sharma")),
            jpeg_bytes(exif=exif_with(description="call me 9876543210")),
            jpeg_bytes(comment=b"ravi.sharma99@example.com"),
        ]
        for data in cases:
            with self.subTest(size=len(data)):
                with self.assertRaises(ImageMetadataPii) as caught:
                    process_upload(upload(data), kind="gallery", ctx=CTX)
                self.assertEqual(caught.exception.code, "pii_in_image_metadata")
                self.assertEqual(caught.exception.status, 422)
                self.assertNotIn("9876543210", str(caught.exception.details))
        png = png_bytes(text={"Author": "Ravi Kumar Sharma", "Comment": "Flat 3B, MG Road, Bengaluru 560001"})
        with self.assertRaises(ImageMetadataPii):
            process_upload(upload(png, "a.png", "image/png"), kind="gallery", ctx=CTX)
        self.assertTrue(self.incoming_is_empty())

    def test_metadata_text_reader(self):
        with Image.open(io.BytesIO(jpeg_bytes(exif=exif_with(artist="Someone", gps=True)))) as image:
            texts, present = metadata_texts(image)
        self.assertIn(("image.metadata.Artist", "Someone"), texts)
        self.assertIn("location", present)

    def test_type_and_size_limits(self):
        gif = io.BytesIO()
        Image.new("RGB", (100, 100)).save(gif, format="GIF")
        refused = [
            (b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "image_type"),
            (gif.getvalue(), "image_type"),
            (b"%PDF-1.7\n" + b"0" * 100, "image_type"),
            (b"", "image_empty"),
            (jpeg_bytes((40, 40)), "image_too_small"),
            (b"\xff\xd8\xff" + b"\x00" * 200, "image_invalid"),
        ]
        for data, code in refused:
            with self.subTest(code=code, head=data[:8]):
                with self.assertRaises(ImageRejected) as caught:
                    process_upload(upload(data), kind="gallery", ctx=CTX)
                self.assertEqual(caught.exception.code, code)
        with override_settings(PROFILES_IMAGE_MAX_BYTES=1024):
            with self.assertRaises(ImageRejected) as caught:
                process_upload(upload(jpeg_bytes((800, 800), color=(10, 200, 90))), kind="gallery", ctx=CTX)
            self.assertEqual(caught.exception.code, "image_too_large")
        self.assertTrue(self.incoming_is_empty())

    def test_png_disguised_as_jpeg_is_checked_by_content(self):
        result = process_upload(upload(png_bytes(mode="RGB"), "photo.jpg", "image/jpeg"), kind="gallery", ctx=CTX)
        self.assertEqual(result.original_format, "PNG")

    def test_unknown_kind(self):
        from apps.core.errors import ValidationFailed

        with self.assertRaises(ValidationFailed):
            process_upload(upload(jpeg_bytes()), kind="cover", ctx=CTX)

    def test_virus_is_blocked(self):
        data = jpeg_bytes() + EICAR_SIGNATURE
        with self.assertRaises(ImageRejected) as caught:
            process_upload(upload(data), kind="gallery", ctx=CTX)
        self.assertEqual(caught.exception.code, "image_blocked")
        self.assertTrue(self.incoming_is_empty())

    def test_scanner_outage_fails_closed(self):
        with override_settings(REPORTS_ANTIVIRUS_SCANNER="off"):
            with self.assertRaises(ScannerUnavailable):
                process_upload(upload(jpeg_bytes()), kind="gallery", ctx=CTX)
        self.assertTrue(self.incoming_is_empty())
