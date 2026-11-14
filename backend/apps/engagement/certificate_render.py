"""Certificate artwork: one layout, three outputs.

* ``certificate_png``: the certificate as an image (A4 landscape, 2339 x 1654,
  i.e. 200 dpi), with the reference number in its PNG text chunks.
* ``certificate_pdf``: one A4-landscape page holding that image plus an
  invisible text layer (render mode 3, Helvetica), so the reference number and
  the name can be searched, selected and copied. The PDF is written by hand
  (about 60 lines) because Pillow's PDF writer has no text layer and no new
  dependency is wanted.
* ``og_png``: a 1200 x 630 link-preview card (Open Graph / LinkedIn / X) that
  shows the certificate next to its status, name and reference number.

The positions, sizes, fonts and colours come from ``certificate_layout.json``,
which the web page (frontend/src/features/certificates) uses too, and every
printed string comes from ``print_block`` (also sent to the web page with the
font sizes after fitting), so the PDF, the image and the page match.

Fonts: IBM Plex Serif and IBM Plex Sans (SIL Open Font License, ``fonts/``).
If they cannot be loaded, Pillow's bundled scalable font is used.
"""

from __future__ import annotations

import io
import json
import struct
from functools import lru_cache
from pathlib import Path

from django.core.cache import cache
from django.utils import timezone
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

from . import certificates, rules

HERE = Path(__file__).resolve().parent
LAYOUT = json.loads((HERE / "certificate_layout.json").read_text(encoding="utf-8"))
FONT_FILES = {
    "serif": "IBMPlexSerif-Regular.woff",
    "serif-italic": "IBMPlexSerif-Italic.woff",
    "serif-semibold": "IBMPlexSerif-SemiBold.woff",
    "sans": "IBMPlexSans-Regular.woff",
    "sans-semibold": "IBMPlexSans-SemiBold.woff",
}
PAGE_W = float(LAYOUT["page"]["width"])
PAGE_H = float(LAYOUT["page"]["height"])
PRINT_SCALE = 2.339  # px per layout unit: 2339 px across 297 mm = 200 dpi
PDF_W_PT, PDF_H_PT = 841.89, 595.28  # A4 landscape in points
CACHE_SECONDS = 24 * 3600
OG_SIZE = (1200, 630)
MEASURE_SCALE = 10.0


def _rgb(name_or_hex: str) -> tuple[int, int, int]:
    value = LAYOUT["colors"].get(name_or_hex, name_or_hex).lstrip("#")
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))


@lru_cache(maxsize=256)
def _font(key: str, px: int):
    px = max(1, int(px))
    try:
        return ImageFont.truetype(str(HERE / "fonts" / FONT_FILES[key]), px)
    except (OSError, KeyError):
        try:
            return ImageFont.load_default(size=px)
        except TypeError:  # pragma: no cover - Pillow < 10.1
            return ImageFont.load_default()


def _measure(text: str, font_key: str, size: float, tracking: float = 0.0) -> float:
    """Width of ``text`` in layout units."""
    if not text:
        return 0.0
    font = _font(font_key, round(size * MEASURE_SCALE))
    width = float(font.getlength(text)) if not tracking else sum(float(font.getlength(char)) for char in text)
    width += tracking * size * MEASURE_SCALE * max(0, len(text) - 1)
    return width / MEASURE_SCALE


def fit(key: str, text: str) -> tuple[str, float]:
    """``(text, size)`` after shrinking (then ellipsising) to the element's ``maxWidth``."""
    spec = LAYOUT["text"][key]
    size = float(spec["size"])
    text = str(text or "")
    limit = spec.get("maxWidth")
    if not limit or not text:
        return text, size
    minimum = float(spec.get("minSize", size))
    tracking = float(spec.get("tracking", 0))
    while size > minimum and _measure(text, spec["font"], size, tracking) > limit:
        size = max(minimum, size - 0.5)
    if _measure(text, spec["font"], size, tracking) > limit:
        while len(text) > 1 and _measure(text + "…", spec["font"], size, tracking) > limit:
            text = text[:-1].rstrip()
        text += "…"
    return text, size


def print_block(certificate) -> dict:
    """Every string printed on the certificate, and the fitted font sizes (also sent to the web page)."""
    valid = certificate.is_valid
    issued = timezone.localtime(certificate.issued_at, rules.IST)
    footer = f"Verify this certificate at {certificates.short_url(certificate.reference)}"
    if certificate.revision > 1:
        footer += f" · Revision {certificate.revision}"
    texts = {
        "monogram": "ASI",
        "brandLine1": "AL SYED",
        "brandLine2": "INITIATIVE",
        "sealTop": "VERIFIED" if valid else "REVOKED",
        "sealBottom": "CREDENTIAL",
        "kicker": certificates.TYPE_LABELS.get(certificate.cert_type, "").upper(),
        "heading": certificate.heading,
        "preamble": "This is to certify that",
        "name": certificate.recipient_name or "Name not on record",
        "statement": certificate.statement,
        "title": certificate.title,
        "programme": (certificate.programme or "").upper(),
        "dateValue": f"{issued.day} {issued:%B %Y}",
        "dateLabel": "DATE OF ISSUE",
        "signature": certificates.SIGNATORY,
        "signatureLabel": "AUTHORISED SIGNATORY",
        "referenceValue": certificate.reference or "",
        "referenceLabel": "REFERENCE NUMBER",
        "footer": footer,
    }
    matrix = certificates.qr_matrix(certificates.public_url(certificate.reference)) if certificate.reference else None
    texts["qrCaption"] = "SCAN TO VERIFY" if matrix else ""
    fitted = {key: fit(key, value) for key, value in texts.items()}
    return {
        "texts": {key: value for key, (value, _size) in fitted.items()},
        "sizes": {key: round(size, 2) for key, (_value, size) in fitted.items()},
        "stamp": None if valid else "REVOKED",
        "qr": matrix,
    }


def _draw_qr(canvas: _Canvas, matrix) -> None:
    """Monochrome QR: dark modules on a paper square, whole pixels per module (crisp when printed)."""
    spec = LAYOUT["qr"]
    count = len(matrix) + 2 * int(spec["quiet"])
    side = canvas.px(spec["size"])
    module = max(1, int(side // count))
    drawn = module * count
    left = round(canvas.px(spec["cx"]) - drawn / 2)
    top = round(canvas.px(spec["cy"]) - drawn / 2)
    # The paper square always has the layout's size; the code is centred in it.
    square_left, square_top = round(canvas.px(spec["cx"]) - side / 2), round(canvas.px(spec["cy"]) - side / 2)
    canvas.draw.rectangle([square_left, square_top, square_left + round(side) - 1, square_top + round(side) - 1], fill=_rgb(spec["background"]))
    ink = _rgb(spec["color"])
    offset = int(spec["quiet"]) * module
    for y, row in enumerate(matrix):
        for x, dark in enumerate(row):
            if dark:
                x0, y0 = left + offset + x * module, top + offset + y * module
                canvas.draw.rectangle([x0, y0, x0 + module - 1, y0 + module - 1], fill=ink)


# --- drawing ------------------------------------------------------------------------------------------
class _Canvas:
    def __init__(self, scale: float):
        self.scale = scale
        self.size = (round(PAGE_W * scale), round(PAGE_H * scale))
        self.image = Image.new("RGB", self.size, _rgb("paper"))
        self.draw = ImageDraw.Draw(self.image)
        self.runs: list[tuple[str, float, float, float]] = []  # text, left x, baseline y, size (units)

    def px(self, units: float) -> float:
        return units * self.scale

    def stroke(self, units: float) -> int:
        return max(1, round(units * self.scale))

    def line(self, spec: dict):
        y = self.px(spec["y"])
        self.draw.line([(self.px(spec["x1"]), y), (self.px(spec["x2"]), y)], fill=_rgb(spec["color"]), width=self.stroke(spec["stroke"]))
        if spec.get("diamond"):
            self.diamond((spec["x1"] + spec["x2"]) / 2, spec["y"], spec["diamond"], spec["color"])

    def diamond(self, cx: float, cy: float, half: float, color: str):
        x, y, d = self.px(cx), self.px(cy), self.px(half)
        self.draw.polygon([(x, y - d), (x + d, y), (x, y + d), (x - d, y)], fill=_rgb(color))

    def text(self, key: str, value: str, size: float):
        if not value:
            return
        spec = LAYOUT["text"][key]
        font = _font(spec["font"], round(size * self.scale))
        fill = _rgb(spec["color"])
        x, y = self.px(spec["x"]), self.px(spec["y"])
        tracking = float(spec.get("tracking", 0)) * size * self.scale
        width_units = _measure(value, spec["font"], size, float(spec.get("tracking", 0)))
        if tracking:
            cursor = x - self.px(width_units) / 2
            for char in value:
                self.draw.text((cursor, y), char, font=font, fill=fill, anchor="lm")
                cursor += float(font.getlength(char)) + tracking
        else:
            self.draw.text((x, y), value, font=font, fill=fill, anchor="mm")
        self.runs.append((value, spec["x"] - width_units / 2, spec["y"] + size * 0.35, size))


def _draw_stamp(canvas: _Canvas, label: str):
    spec = LAYOUT["stamp"]
    font = _font(spec["font"], round(spec["size"] * canvas.scale))
    left, top, right, bottom = font.getbbox(label)
    pad_x, pad_y = canvas.px(spec["padX"]), canvas.px(spec["padY"])
    stroke = canvas.stroke(spec["stroke"])
    width = int(right - left + 2 * pad_x + 4 * stroke)
    height = int(bottom - top + 2 * pad_y + 4 * stroke)
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    ink = _rgb(spec["color"]) + (235,)
    draw.rectangle([stroke, stroke, width - stroke - 1, height - stroke - 1], fill=(255, 255, 255, 215), outline=ink, width=stroke)
    inner = stroke * 3
    draw.rectangle([inner, inner, width - inner - 1, height - inner - 1], outline=ink, width=max(1, stroke // 2))
    draw.text((width / 2, height / 2), label, font=font, fill=ink, anchor="mm")
    layer = layer.rotate(-float(spec["angle"]), resample=Image.Resampling.BICUBIC, expand=True)
    x = round(canvas.px(spec["x"]) - layer.width / 2)
    y = round(canvas.px(spec["y"]) - layer.height / 2)
    canvas.image.paste(layer, (x, y), layer)
    canvas.runs.append((label, spec["x"] - 80, spec["y"] + 20, spec["size"]))


def draw_certificate(certificate, *, scale: float = PRINT_SCALE, block: dict | None = None) -> _Canvas:
    block = block or print_block(certificate)
    canvas = _Canvas(scale)
    draw = canvas.draw
    panel = LAYOUT["panel"]
    draw.rectangle([canvas.px(panel["x"]), 0, canvas.px(panel["x"] + panel["width"]), canvas.size[1]], fill=_rgb(panel["color"]))
    frame = LAYOUT["frame"]
    inset = canvas.px(frame["inset"])
    draw.rectangle(
        [inset, inset, canvas.size[0] - inset, canvas.size[1] - inset], outline=_rgb(frame["color"]), width=canvas.stroke(frame["stroke"])
    )
    for spec in LAYOUT["rules"].values():
        canvas.line(spec)
    seal = LAYOUT["seal"]
    cx, cy = canvas.px(seal["cx"]), canvas.px(seal["cy"])
    for radius, width, color in ((seal["r"], seal["stroke"], seal["color"]), (seal["innerR"], seal["innerStroke"], seal["innerColor"])):
        r = canvas.px(radius)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=_rgb(color), width=canvas.stroke(width))
    canvas.diamond(seal["cx"], seal["cy"], seal["diamond"], seal["color"])
    if block.get("qr"):
        _draw_qr(canvas, block["qr"])
    for key, value in block["texts"].items():
        canvas.text(key, value, block["sizes"][key])
    if block.get("stamp"):
        _draw_stamp(canvas, block["stamp"])
    return canvas


# --- outputs ------------------------------------------------------------------------------------------
def _cache_key(kind: str, certificate) -> str:
    return f"eng:cert:{kind}:{certificate.reference}:{certificates.render_version(certificate)}"


def _cached(kind: str, certificate, build):
    key = _cache_key(kind, certificate)
    try:
        data = cache.get(key)
    except Exception:  # noqa: BLE001
        data = None
    if data:
        return data
    data = build()
    try:
        cache.set(key, data, timeout=CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        pass
    return data


def _png_bytes(image: Image.Image, certificate, **extra) -> bytes:
    info = PngImagePlugin.PngInfo()
    info.add_text("Title", f"{certificate.heading}: {certificate.title}")
    info.add_text("Author", certificates.ISSUER_NAME)
    info.add_text("Reference", certificate.reference or "")
    info.add_text("Source", certificates.public_url(certificate.reference))
    buffer = io.BytesIO()
    image.save(buffer, "PNG", pnginfo=info, optimize=True, **extra)
    return buffer.getvalue()


def certificate_png(certificate) -> bytes:
    return _cached("png", certificate, lambda: _png_bytes(draw_certificate(certificate).image, certificate))


def _pdf_string(value: str) -> bytes:
    """A PDF text string: literal when Latin-1 safe, else UTF-16BE hex with a BOM."""
    try:
        raw = value.encode("latin-1")
        if all(32 <= byte < 127 for byte in raw):
            return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"
    except UnicodeEncodeError:
        pass
    return b"<FEFF" + value.encode("utf-16-be").hex().upper().encode("ascii") + b">"


def _content_string(value: str) -> bytes:
    raw = value.encode("cp1252", errors="replace")
    return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


def _png_idat(image: Image.Image) -> bytes:
    """The zlib stream of a PNG (PNG row filters): a PDF reads it with Predictor 15."""
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    data = buffer.getvalue()
    offset, chunks = 8, []
    while offset < len(data):
        length, kind = struct.unpack(">I4s", data[offset:offset + 8])
        if kind == b"IDAT":
            chunks.append(data[offset + 8:offset + 8 + length])
        offset += 12 + length
    return b"".join(chunks)


def _pdf_bytes(canvas: _Canvas, certificate) -> bytes:
    image = canvas.image.convert("RGB")
    width, height = image.size
    unit_pt = PDF_W_PT / PAGE_W
    ops = [f"q {PDF_W_PT:.2f} 0 0 {PDF_H_PT:.2f} 0 0 cm /Im0 Do Q".encode("ascii"), b"BT 3 Tr"]
    for text, left, baseline, size in canvas.runs:
        x, y = left * unit_pt, PDF_H_PT - baseline * unit_pt
        ops.append(f"/F1 {size * unit_pt:.2f} Tf 1 0 0 1 {x:.2f} {y:.2f} Tm ".encode("ascii") + _content_string(text) + b" Tj")
    ops.append(b"ET")
    content = b"\n".join(ops)
    issued = timezone.localtime(certificate.issued_at, rules.IST)
    info = {
        b"Title": _pdf_string(f"{certificate.heading}: {certificate.title}"),
        b"Author": _pdf_string(certificates.ISSUER_NAME),
        b"Subject": _pdf_string(f"Certificate {certificate.reference} issued to {certificate.recipient_name}"),
        b"Keywords": _pdf_string(f"{certificate.reference} {certificates.public_url(certificate.reference)}"),
        b"Creator": _pdf_string(certificates.ISSUER_NAME),
        b"CreationDate": _pdf_string(f"D:{issued:%Y%m%d%H%M%S}+05'30'"),
    }
    image_data = _png_idat(image)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PDF_W_PT:.2f} {PDF_H_PT:.2f}] "
            "/Resources << /XObject << /Im0 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>"
        ).encode("ascii"),
        (
            f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB "
            f"/BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 "
            f"/Columns {width} >> /Length {len(image_data)} >>\nstream\n"
        ).encode("ascii") + image_data + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        f"<< /Length {len(content)} >>\nstream\n".encode("ascii") + content + b"\nendstream",
        b"<< " + b" ".join(b"/" + key + b" " + value for key, value in info.items()) + b" >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode("ascii"))
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {len(objects)} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    return out.getvalue()


def certificate_pdf(certificate) -> bytes:
    return _cached("pdf", certificate, lambda: _pdf_bytes(draw_certificate(certificate), certificate))


def og_png(certificate) -> bytes:
    """1200 x 630 link preview: the certificate on the left, status, name and reference on the right."""

    def build():
        block = print_block(certificate)
        card = Image.new("RGB", OG_SIZE, _rgb("panel"))
        art = draw_certificate(certificate, scale=1.6, block=block).image
        art = art.resize((780, round(780 * PAGE_H / PAGE_W)), Image.Resampling.LANCZOS)
        top = (OG_SIZE[1] - art.height) // 2
        card.paste(art, (40, top))
        draw = ImageDraw.Draw(card)
        draw.rectangle([39, top - 1, 40 + art.width, top + art.height], outline=_rgb("goldDeep"), width=1)
        left, width = 862, 300

        def line(text, y, font_key, px, fill, minimum=12):
            size = px
            font = _font(font_key, size)
            while size > minimum and font.getlength(text) > width:
                size -= 1
                font = _font(font_key, size)
            while len(text) > 1 and font.getlength(text) > width:
                text = text[:-2] + "…"
            draw.text((left, y), text, font=font, fill=fill, anchor="lm")

        valid = certificate.is_valid
        line("VERIFIED CERTIFICATE" if valid else "REVOKED CERTIFICATE", 170, "sans-semibold", 17, _rgb("gold"))
        draw.line([(left, 196), (left + 64, 196)], fill=_rgb("gold"), width=2)
        line(certificate.recipient_name or "Certificate holder", 248, "serif-semibold", 36, (250, 250, 250), minimum=18)
        line(certificate.title, 300, "serif", 24, (200, 200, 200), minimum=13)
        line(certificate.heading, 336, "sans", 17, (161, 161, 161))
        line(certificate.reference or "", 404, "sans-semibold", 19, _rgb("gold"), minimum=11)
        line(certificates.ISSUER_NAME, 440, "sans", 17, (161, 161, 161))
        line(certificates.short_url(certificate.reference), 560, "sans", 14, (138, 138, 138), minimum=9)
        return _png_bytes(card, certificate)

    return _cached("og", certificate, build)
