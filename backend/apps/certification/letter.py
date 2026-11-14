"""The congratulations letter: one A4 portrait page, PDF (image + searchable text layer).

Palette law: black, greys, whites and golden white (#F3E2B3). A black
letterhead band with the ASI monogram in golden white, a white sheet with ink
text, golden hairlines, a result panel (band, date, reference), the
verification address and QR code, signed by the Al Syed Initiative.

It is drawn with Pillow and the certificate fonts (IBM Plex) and written as a
PDF exactly like the certificate (``apps.engagement.certificate_render``):
the page image plus an invisible Helvetica text layer, so the name, the
reference number and the address can be searched and copied.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from django.utils import timezone
from PIL import Image, ImageDraw

from apps.engagement import certificates, rules
from apps.engagement.certificate_render import _content_string, _font, _pdf_string, _png_idat

from .grading import band_range

PAGE_PX = (1240, 1754)  # A4 portrait at 150 dpi
PDF_W_PT, PDF_H_PT = 595.28, 841.89
PT_PER_PX = PDF_W_PT / PAGE_PX[0]
MARGIN = 120

INK = (10, 10, 10)
INK2 = (43, 43, 43)
MUTED = (94, 94, 94)
FAINT = (138, 138, 138)
HAIR = (210, 210, 210)
PANEL = (11, 11, 11)
TINT = (246, 246, 244)
GOLD = (243, 226, 179)
GOLD_DEEP = (230, 210, 156)
PAPER = (255, 255, 255)


@dataclass
class LetterFacts:
    name: str
    reference: str
    exam_title: str
    programme: str
    band: str
    issued_on: str
    verify_url: str
    verify_short: str
    listed_in_hall_of_fame: bool


def facts_for(certificate, *, exam_title: str, band: str, listed_in_hall_of_fame: bool) -> LetterFacts:
    issued = timezone.localtime(certificate.issued_at, rules.IST)
    return LetterFacts(
        name=certificate.recipient_name or "Graduate",
        reference=certificate.reference or "",
        exam_title=exam_title or certificate.title,
        programme=certificate.programme or certificate.title,
        band=band or "Pass",
        issued_on=f"{issued.day} {issued:%B %Y}",
        verify_url=certificates.public_url(certificate.reference),
        verify_short=certificates.short_url(certificate.reference),
        listed_in_hall_of_fame=listed_in_hall_of_fame,
    )


def paragraphs(facts: LetterFacts) -> list[str]:
    band_text = band_range(facts.band)
    result = f"{facts.band}" + (f" ({band_text})" if band_text else "")
    body = [
        "Congratulations. On behalf of everyone at the Al Syed Initiative, it is our privilege to confirm that you "
        f"have passed the {facts.exam_title} and are now certified. Your result places you in the {result} band.",
        "This certification is earned, never given. It reflects the patience, discipline and careful method you "
        "brought to every investigation: verifying before concluding, documenting every step and respecting the "
        "people behind the data.",
        f"Your certificate is issued in your name under the reference number {facts.reference}. Anyone can verify "
        f"it at any time at {facts.verify_short}"
        + (" or by scanning the code on this letter." if certificates.qr_available() else "."),
    ]
    if facts.listed_in_hall_of_fame:
        body.append(
            "Your handle has also been added to the Al Syed Initiative Hall of Fame, alongside the graduates who came "
            "before you. You can choose to remove it at any time from your profile settings."
        )
    body.append("We are proud of what you have achieved, and we look forward to the work you will do with it.")
    return body


class _Page:
    def __init__(self):
        self.image = Image.new("RGB", PAGE_PX, PAPER)
        self.draw = ImageDraw.Draw(self.image)
        self.runs: list[tuple[str, float, float, float]] = []  # text, x px, baseline px, size px

    def text(self, xy, value: str, *, font: str, size: int, fill, anchor: str = "ls", tracking: float = 0.0):
        if not value:
            return 0.0
        face = _font(font, size)
        x, y = xy
        width = self.width(value, font=font, size=size, tracking=tracking)
        if anchor[0] == "m":
            x -= width / 2
        elif anchor[0] == "r":
            x -= width
        if tracking:
            cursor = x
            for char in value:
                self.draw.text((cursor, y), char, font=face, fill=fill, anchor="ls")
                cursor += float(face.getlength(char)) + tracking * size
        else:
            self.draw.text((x, y), value, font=face, fill=fill, anchor="ls")
        self.runs.append((value, x, y, float(size)))
        return width

    @staticmethod
    def width(value: str, *, font: str, size: int, tracking: float = 0.0) -> float:
        face = _font(font, size)
        if not tracking:
            return float(face.getlength(value))
        return sum(float(face.getlength(char)) for char in value) + tracking * size * max(0, len(value) - 1)

    def wrap(self, value: str, *, font: str, size: int, width: float) -> list[str]:
        words, lines, line = value.split(), [], ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if line and self.width(candidate, font=font, size=size) > width:
                lines.append(line)
                line = word
            else:
                line = candidate
        if line:
            lines.append(line)
        return lines

    def fit(self, value: str, *, font: str, size: int, width: float, minimum: int) -> int:
        while size > minimum and self.width(value, font=font, size=size) > width:
            size -= 1
        return size

    def rule(self, x1, x2, y, color, stroke=2, diamond: int = 0):
        self.draw.line([(x1, y), (x2, y)], fill=color, width=stroke)
        if diamond:
            cx = (x1 + x2) / 2
            self.draw.polygon([(cx, y - diamond), (cx + diamond, y), (cx, y + diamond), (cx - diamond, y)], fill=color)


def _draw_qr(page: _Page, url: str, *, left: int, top: int, side: int):
    matrix = certificates.qr_matrix(url)
    if not matrix:
        return False
    count = len(matrix) + 4
    module = max(1, side // count)
    drawn = module * count
    page.draw.rectangle([left, top, left + side, top + side], fill=PAPER, outline=HAIR, width=1)
    offset_x = left + (side - drawn) // 2 + 2 * module
    offset_y = top + (side - drawn) // 2 + 2 * module
    for y, row in enumerate(matrix):
        for x, dark in enumerate(row):
            if dark:
                x0, y0 = offset_x + x * module, offset_y + y * module
                page.draw.rectangle([x0, y0, x0 + module - 1, y0 + module - 1], fill=INK)
    return True


def draw_letter(facts: LetterFacts) -> _Page:
    page = _Page()
    width, height = PAGE_PX
    draw = page.draw
    content_w = width - 2 * MARGIN

    # Letterhead band.
    draw.rectangle([0, 0, width, 250], fill=PANEL)
    page.text((MARGIN, 150), "ASI", font="serif-semibold", size=84, fill=GOLD, tracking=0.06)
    page.rule(MARGIN, MARGIN + 70, 180, GOLD, stroke=2)
    page.text((MARGIN, 214), "AL SYED INITIATIVE", font="sans-semibold", size=18, fill=GOLD, tracking=0.3)
    page.text((width - MARGIN, 150), "Letter of Congratulations", font="serif-italic", size=30, fill=GOLD_DEEP, anchor="rs")
    page.text((width - MARGIN, 196), "CERTIFICATION BOARD", font="sans-semibold", size=15, fill=(161, 161, 161),
              anchor="rs", tracking=0.28)
    page.rule(0, width, 252, GOLD_DEEP, stroke=3)

    # Date and reference.
    y = 340
    page.text((width - MARGIN, y), facts.issued_on, font="sans", size=20, fill=MUTED, anchor="rs")
    page.text((width - MARGIN, y + 32), f"Ref. {facts.reference}", font="sans-semibold", size=17, fill=FAINT, anchor="rs")

    # Salutation.
    y = 450
    name_size = page.fit(facts.name, font="serif-semibold", size=46, width=content_w, minimum=26)
    page.text((MARGIN, y), "Dear", font="serif-italic", size=26, fill=MUTED)
    page.text((MARGIN, y + 62), facts.name, font="serif-semibold", size=name_size, fill=INK)
    page.rule(MARGIN, MARGIN + 140, y + 92, GOLD_DEEP, stroke=2, diamond=5)

    # Body.
    y += 160
    for paragraph in paragraphs(facts):
        for line in page.wrap(paragraph, font="serif", size=23, width=content_w):
            page.text((MARGIN, y), line, font="serif", size=23, fill=INK2)
            y += 37
        y += 20

    # Result panel.
    y += 6
    panel_top, panel_h = y, 128
    draw.rectangle([MARGIN, panel_top, width - MARGIN, panel_top + panel_h], fill=TINT, outline=HAIR, width=1)
    draw.rectangle([MARGIN, panel_top, MARGIN + 6, panel_top + panel_h], fill=GOLD_DEEP)
    columns = [("RESULT", facts.band), ("DATE OF ISSUE", facts.issued_on), ("REFERENCE NUMBER", facts.reference)]
    column_w = (content_w - 40) / 3
    for index, (label, value) in enumerate(columns):
        x = MARGIN + 34 + index * column_w
        page.text((x, panel_top + 50), label, font="sans-semibold", size=14, fill=FAINT, tracking=0.24)
        size = page.fit(value, font="serif-semibold", size=27, width=column_w - 16, minimum=14)
        page.text((x, panel_top + 94), value, font="serif-semibold", size=size, fill=INK)

    # Closing and signature, QR on the right.
    y = panel_top + panel_h + 80
    page.text((MARGIN, y), "With our warmest congratulations,", font="serif-italic", size=24, fill=MUTED)
    page.text((MARGIN, y + 78), certificates.SIGNATORY, font="serif-italic", size=44, fill=INK)
    page.rule(MARGIN, MARGIN + 420, y + 100, INK2, stroke=2)
    page.text((MARGIN, y + 132), "AUTHORISED SIGNATORY", font="sans-semibold", size=14, fill=FAINT, tracking=0.26)
    qr_side = 190
    if _draw_qr(page, facts.verify_url, left=width - MARGIN - qr_side, top=y - 40, side=qr_side):
        page.text((width - MARGIN - qr_side / 2, y + qr_side - 10), "SCAN TO VERIFY", font="sans-semibold", size=13,
                  fill=FAINT, anchor="ms", tracking=0.26)

    # Footer band.
    draw.rectangle([0, height - 110, width, height], fill=PANEL)
    page.rule(0, width, height - 111, GOLD_DEEP, stroke=2)
    footer = f"Verify this certificate at {facts.verify_short}"
    size = page.fit(footer, font="sans", size=19, width=content_w, minimum=11)
    page.text((width / 2, height - 50), footer, font="sans", size=size, fill=GOLD, anchor="ms")
    return page


def _pdf(page: _Page, facts: LetterFacts) -> bytes:
    image = page.image.convert("RGB")
    width, height = image.size
    ops = [f"q {PDF_W_PT:.2f} 0 0 {PDF_H_PT:.2f} 0 0 cm /Im0 Do Q".encode("ascii"), b"BT 3 Tr"]
    for text, left, baseline, size in page.runs:
        x, y = left * PT_PER_PX, PDF_H_PT - baseline * PT_PER_PX
        ops.append(f"/F1 {size * PT_PER_PX:.2f} Tf 1 0 0 1 {x:.2f} {y:.2f} Tm ".encode("ascii") + _content_string(text) + b" Tj")
    ops.append(b"ET")
    content = b"\n".join(ops)
    info = {
        b"Title": _pdf_string(f"Letter of Congratulations: {facts.reference}"),
        b"Author": _pdf_string(certificates.ISSUER_NAME),
        b"Subject": _pdf_string(f"Congratulations to {facts.name} on passing the {facts.exam_title}"),
        b"Keywords": _pdf_string(f"{facts.reference} {facts.verify_url}"),
        b"Creator": _pdf_string(certificates.ISSUER_NAME),
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
    out.write(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {len(objects)} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode(
            "ascii"
        )
    )
    return out.getvalue()


def letter_pdf(facts: LetterFacts) -> bytes:
    return _pdf(draw_letter(facts), facts)


def letter_png(facts: LetterFacts) -> bytes:
    buffer = io.BytesIO()
    draw_letter(facts).image.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()


def letter_filename(reference: str) -> str:
    return f"{reference}-congratulations-letter.pdf"
