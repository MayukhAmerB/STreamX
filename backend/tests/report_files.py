"""In-memory sample files for the weekly-report tests (real formats, tiny sizes)."""

from __future__ import annotations

import io
import json
import zipfile

from django.core.files.uploadedfile import SimpleUploadedFile
from PIL import Image

PDF_BYTES = (
    b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
)


def upload(name, data, content_type="application/octet-stream"):
    return SimpleUploadedFile(name, data, content_type=content_type)


def pdf(name="report.pdf"):
    return upload(name, PDF_BYTES, "application/pdf")


def _zip(entries, *, compression=zipfile.ZIP_DEFLATED):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=compression) as archive:
        for entry in entries:
            if isinstance(entry, zipfile.ZipInfo):
                archive.writestr(entry, b"x")
            else:
                name, data = entry
                archive.writestr(name, data)
    return buffer.getvalue()


def ooxml_bytes(kind="docx", *, macro=False, vba=False):
    content_type = (
        "application/vnd.ms-word.document.macroEnabled.main+xml"
        if macro
        else "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    )
    main = "word/document.xml" if kind == "docx" else "ppt/presentation.xml"
    entries = [
        ("[Content_Types].xml", f'<?xml version="1.0"?><Types><Override ContentType="{content_type}"/></Types>'),
        (main, "<doc/>"),
    ]
    if vba:
        entries.append(("word/vbaProject.bin" if kind == "docx" else "ppt/vbaProject.bin", b"\x00\x01"))
    return _zip(entries)


def odf_bytes(kind="odt"):
    mimetype = {
        "odt": "application/vnd.oasis.opendocument.text",
        "odp": "application/vnd.oasis.opendocument.presentation",
    }[kind]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(zipfile.ZipInfo("mimetype"), mimetype, compress_type=zipfile.ZIP_STORED)
        archive.writestr("content.xml", "<office:document-content/>")
    return buffer.getvalue()


OLE2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def ole_bytes(kind="doc", *, vba=False):
    marker = ("WordDocument" if kind == "doc" else "PowerPoint Document").encode("utf-16-le")
    body = OLE2 + b"\x00" * 504 + marker + b"\x00" * 64
    if vba:
        body += "_VBA_PROJECT".encode("utf-16-le")
    return body + b"\x00" * 512


def image_bytes(fmt="PNG"):
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (243, 226, 179)).save(buffer, format=fmt)
    return buffer.getvalue()


SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
CANVAS = {
    "nodes": [
        {"id": "a", "type": "text", "text": "Target", "x": 0, "y": 0, "width": 200, "height": 80},
        {"id": "b", "type": "text", "text": "Email", "x": 300, "y": 0, "width": 200, "height": 80},
    ],
    "edges": [{"id": "e1", "fromNode": "a", "toNode": "b"}],
}


def canvas_bytes(payload=None):
    return json.dumps(CANVAS if payload is None else payload).encode("utf-8")


def vault_zip(extra=None):
    entries = [
        ("Vault/Target.md", "# Target\n"),
        ("Vault/Board.canvas", canvas_bytes()),
        ("Vault/img.png", image_bytes()),
    ]
    return _zip(entries + list(extra or []))


def every_type():
    """(filename, bytes) for every accepted extension."""
    return [
        ("a.pdf", PDF_BYTES),
        ("a.docx", ooxml_bytes("docx")),
        ("a.pptx", ooxml_bytes("pptx")),
        ("a.doc", ole_bytes("doc")),
        ("a.ppt", ole_bytes("ppt")),
        ("a.odt", odf_bytes("odt")),
        ("a.odp", odf_bytes("odp")),
        ("a.md", b"# Notes\n\n- one"),
        ("a.canvas", canvas_bytes()),
        ("a.png", image_bytes("PNG")),
        ("a.jpg", image_bytes("JPEG")),
        ("a.jpeg", image_bytes("JPEG")),
        ("a.webp", image_bytes("WEBP")),
        ("a.svg", SVG_TEXT.encode()),
        ("a.zip", vault_zip()),
    ]


zip_bytes = _zip
