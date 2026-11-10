"""Weekly-report upload validation: every accepted type and every rejection."""

import io
import json
import zipfile

from config.upload_validators import validate_report_upload
from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from tests import report_files as rf

MB = 1024 * 1024


def check(name, data, *, allowed=None, max_bytes=50 * MB, limits=None):
    return validate_report_upload(
        rf.upload(name, data), max_bytes=max_bytes, allowed_extensions=allowed, zip_limits=limits
    )


class AcceptedTypesTests(SimpleTestCase):
    def test_every_supported_type_is_accepted(self):
        for name, data in rf.every_type():
            with self.subTest(name=name):
                info = check(name, data)
                self.assertEqual(info["extension"], name.rsplit(".", 1)[1])
                self.assertTrue(info["content_type"])

    def test_served_type_comes_from_extension_not_browser(self):
        info = validate_report_upload(rf.upload("r.pdf", rf.PDF_BYTES, "text/html"), max_bytes=MB)
        self.assertEqual(info["content_type"], "application/pdf")

    def test_vault_zip_with_os_junk_is_accepted(self):
        data = rf.vault_zip(
            [("__MACOSX/Vault/._Target.md", b"\x00\x05junk"), ("Vault/.DS_Store", b"\x00"), ("Vault/._x.md", b"\x00")]
        )
        self.assertEqual(check("vault.zip", data)["extension"], "zip")

    def test_vault_zip_with_obsidian_settings_is_accepted(self):
        data = rf.vault_zip([(".obsidian/app.json", "{}"), (".obsidian/snippets/a.css", "a{}"), ("Vault/", "")])
        check("vault.zip", data)


class RejectionTests(SimpleTestCase):
    def assertRejected(self, name, data, fragment="", **kwargs):
        with self.assertRaises(ValidationError) as ctx:
            check(name, data, **kwargs)
        message = ctx.exception.message_dict["file"][0]
        if fragment:
            self.assertIn(fragment.lower(), message.lower())
        return message

    def test_macro_extensions(self):
        self.assertRejected("deck.pptm", rf.ooxml_bytes("pptx"), "macro")
        self.assertRejected("doc.docm", rf.ooxml_bytes("docx"), "macro")

    def test_macro_file_renamed_to_pptx_or_docx(self):
        self.assertRejected("deck.pptx", rf.ooxml_bytes("pptx", vba=True), "macros")
        self.assertRejected("doc.docx", rf.ooxml_bytes("docx", macro=True), "macros")

    def test_legacy_doc_with_vba_project(self):
        self.assertRejected("old.doc", rf.ole_bytes("doc", vba=True), "macros")

    def test_executable_renamed_to_pdf(self):
        self.assertRejected("report.pdf", b"MZ\x90\x00" + b"\x00" * 200, "programs")

    def test_magic_byte_mismatches(self):
        self.assertRejected("photo.jpg", rf.image_bytes("PNG"), "not a real")
        self.assertRejected("report.pdf", b"just some text pretending to be a pdf", "not a real pdf")
        self.assertRejected("deck.pptx", rf.ooxml_bytes("docx"), "not a powerpoint")
        self.assertRejected("doc.docx", rf.PDF_BYTES, "not a real")
        self.assertRejected("old.ppt", rf.ole_bytes("doc"), "not a powerpoint")
        self.assertRejected("old.doc", rf.PDF_BYTES, "not a real")
        self.assertRejected("text.odt", rf.odf_bytes("odp"), "opendocument")
        self.assertRejected("pic.webp", rf.image_bytes("PNG"), "not a real")

    def test_password_protected_docx_hint(self):
        self.assertRejected("secret.docx", rf.ole_bytes("doc"), "password")

    def test_double_extension(self):
        self.assertRejected("shell.php.pdf", rf.PDF_BYTES, "executable")

    def test_empty_and_too_large(self):
        self.assertRejected("empty.pdf", b"", "empty")
        self.assertRejected("big.pdf", rf.PDF_BYTES, "larger than", max_bytes=10)

    def test_type_not_allowed_by_task(self):
        message = self.assertRejected("notes.md", b"# hi", "not accepted", allowed=["pdf", "pptx"])
        self.assertIn(".pdf, .pptx", message)

    def test_unknown_and_missing_extension(self):
        self.assertRejected("tool.exe", b"MZ", "not accepted")
        self.assertRejected("README", b"text", "without an extension")

    def test_markdown_must_be_utf8_text(self):
        self.assertRejected("n.md", b"\x00\x01\x02binary", "binary")
        self.assertRejected("n.md", b"\xff\xfe\xfa bad", "utf-8")

    def test_canvas_validation(self):
        self.assertRejected("c.canvas", b"{not json", "valid json")
        self.assertRejected("c.canvas", b"[1, 2]", "not an obsidian canvas")
        bad_edge = {"nodes": [{"id": "a"}], "edges": [{"id": "e", "toNode": "a"}]}
        self.assertRejected("c.canvas", json.dumps(bad_edge).encode(), "connection")
        self.assertRejected("c.canvas", json.dumps({"nodes": [{"x": 1}]}).encode(), "without an id")

    def test_svg_with_active_content(self):
        cases = [
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
            '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">x</a></svg>',
        ]
        for text in cases:
            with self.subTest(text=text):
                self.assertRejected("g.svg", text.encode(), "scripts")

    def test_svg_must_be_svg(self):
        self.assertRejected("g.svg", b"<html><body/></html>", "not an svg")
        self.assertRejected("g.svg", b"<svg", "not an svg")


class MaliciousZipTests(SimpleTestCase):
    def assertZipRejected(self, data, fragment, **kwargs):
        with self.assertRaises(ValidationError) as ctx:
            check("vault.zip", data, **kwargs)
        self.assertIn(fragment.lower(), ctx.exception.message_dict["file"][0].lower())

    def test_traversal(self):
        self.assertZipRejected(rf.zip_bytes([("../evil.md", "x")]), "'..' paths")
        self.assertZipRejected(rf.zip_bytes([("notes/../../evil.md", "x")]), "'..' paths")

    def test_absolute_paths(self):
        self.assertZipRejected(rf.zip_bytes([("/etc/evil.md", "x")]), "absolute")
        self.assertZipRejected(rf.zip_bytes([("C:/evil.md", "x")]), "absolute")

    def test_symlink_entry(self):
        info = zipfile.ZipInfo("Vault/link.md")
        info.external_attr = 0o120777 << 16
        self.assertZipRejected(rf.zip_bytes([info]), "symbolic links")

    def test_encrypted_entry(self):
        data = bytearray(rf.zip_bytes([("Vault/a.md", "secret")], compression=zipfile.ZIP_STORED))
        # Set the "encrypted" general-purpose flag in the local and central headers.
        for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
            index = data.find(signature)
            data[index + offset] |= 0x01
        self.assertZipRejected(bytes(data), "password")

    def test_too_many_entries(self):
        entries = [(f"Vault/n{i}.md", "x") for i in range(6)]
        self.assertZipRejected(rf.zip_bytes(entries), "more than 5 entries", limits={"max_entries": 5})

    def test_zip_bomb_by_ratio(self):
        self.assertZipRejected(rf.zip_bytes([("Vault/zeros.md", b"\x00" * (5 * MB))]), "zip bomb")

    def test_total_uncompressed_limit(self):
        data = rf.zip_bytes([("Vault/a.md", "x" * 3000), ("Vault/b.md", "y" * 3000)])
        self.assertZipRejected(data, "unpacks to more than", limits={"max_uncompressed_bytes": 4000})

    def test_disallowed_inner_type(self):
        data = rf.vault_zip([(".obsidian/plugins/evil/main.js", "alert(1)")])
        self.assertZipRejected(data, "plugins folder")
        self.assertZipRejected(rf.vault_zip([("Vault/run.exe", "MZ")]), "not allowed")
        self.assertZipRejected(rf.vault_zip([("Vault/inner.zip", "PK")]), "not allowed")

    def test_empty_zip(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("Vault/", "")
        self.assertZipRejected(buffer.getvalue(), "no notes")

    def test_not_a_zip(self):
        self.assertZipRejected(rf.PDF_BYTES, "not a real .zip")
        self.assertZipRejected(b"PK\x03\x04garbage-not-a-zip", "damaged")
