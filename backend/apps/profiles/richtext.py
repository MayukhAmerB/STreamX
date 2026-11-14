"""Constrained rich text for the profile bio.

The editor sends a small Markdown subset (``source``); the server parses it
into a JSON document and that document is what is stored, published and
rendered. Raw HTML is never accepted (``sanitize.clean_text`` refuses
markup) and never produced for the public page: the frontend renders the
JSON with React elements (``frontend/src/features/profiles/RichText.jsx``).

Supported syntax (one level, no nesting)::

    ### Heading
    > quote
    - list item          (or "* item")
    **bold**  *italic*  _italic_  `code`  [label](https://example.com)

Document shape::

    {"type": "doc", "content": [
        {"type": "paragraph", "content": [inline, ...]},
        {"type": "heading", "content": [inline, ...]},
        {"type": "quote", "content": [inline, ...]},
        {"type": "list", "items": [[inline, ...], ...]}]}

    inline = {"type": "text", "text": "...", "marks": ["bold" | "italic" | "code"]}
           | {"type": "link", "text": "...", "href": "https://..."}
           | {"type": "break"}
"""

from __future__ import annotations

import re
from html import escape

from apps.core.errors import ValidationFailed

from .sanitize import LINK_REL, clean_url, sanitize_html

MAX_SOURCE_LENGTH = 4000
MAX_BLOCKS = 60
MAX_LINKS = 20
MAX_LIST_ITEMS = 30
MARKS = ("bold", "italic", "code")

_INLINE = re.compile(
    r"(?P<code>`(?P<code_text>[^`\n]{1,200})`)"
    r"|(?P<link>\[(?P<link_text>[^\]\n]{1,120})\]\((?P<link_href>[^)\s]{1,2048})\))"
    r"|(?P<bold>\*\*(?P<bold_text>[^*\n]{1,500})\*\*)"
    r"|(?P<italic>(?<![\w*])\*(?P<italic_text>[^*\n]{1,500})\*(?![\w*])|(?<![\w_])_(?P<italic_text2>[^_\n]{1,500})_(?![\w_]))"
    r"|(?P<escaped>\\(?P<escaped_char>[\\`*_\[\]()#>\-]))"
)


def _text(value: str, marks: list[str] | None = None) -> dict:
    node = {"type": "text", "text": value}
    if marks:
        node["marks"] = list(marks)
    return node


def _merge_text(nodes: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for node in nodes:
        if (
            merged
            and node["type"] == "text"
            and merged[-1]["type"] == "text"
            and merged[-1].get("marks") == node.get("marks")
        ):
            merged[-1] = {**merged[-1], "text": merged[-1]["text"] + node["text"]}
        else:
            merged.append(node)
    return [node for node in merged if node["type"] != "text" or node["text"]]


def parse_inline(line: str, *, field: str, links: list[int]) -> list[dict]:
    nodes: list[dict] = []
    position = 0
    for match in _INLINE.finditer(line):
        if match.start() > position:
            nodes.append(_text(line[position : match.start()]))
        if match.group("code"):
            nodes.append(_text(match.group("code_text"), ["code"]))
        elif match.group("link"):
            links[0] += 1
            if links[0] > MAX_LINKS:
                raise ValidationFailed(details={field: [f"Use at most {MAX_LINKS} links in your bio."]})
            href = clean_url(match.group("link_href"), field=field)
            nodes.append({"type": "link", "text": match.group("link_text").strip() or href, "href": href})
        elif match.group("bold"):
            nodes.append(_text(match.group("bold_text"), ["bold"]))
        elif match.group("italic"):
            nodes.append(_text(match.group("italic_text") or match.group("italic_text2") or "", ["italic"]))
        elif match.group("escaped"):
            nodes.append(_text(match.group("escaped_char")))
        position = match.end()
    if position < len(line):
        nodes.append(_text(line[position:]))
    return _merge_text(nodes)


def parse(source: str, *, field: str = "bio") -> dict:
    """Markdown subset -> document (``ValidationFailed`` on bad links or size)."""
    text = str(source or "")
    if len(text) > MAX_SOURCE_LENGTH:
        raise ValidationFailed(details={field: [f"Keep your bio under {MAX_SOURCE_LENGTH} characters."]})
    links = [0]
    blocks: list[dict] = []
    paragraph: list[str] = []
    list_items: list[str] = []
    quote: list[str] = []

    def flush_paragraph():
        if paragraph:
            content: list[dict] = []
            for index, line in enumerate(paragraph):
                if index:
                    content.append({"type": "break"})
                content.extend(parse_inline(line, field=field, links=links))
            if content:
                blocks.append({"type": "paragraph", "content": content})
            paragraph.clear()

    def flush_list():
        if list_items:
            items = [parse_inline(item, field=field, links=links) for item in list_items[:MAX_LIST_ITEMS]]
            if len(list_items) > MAX_LIST_ITEMS:
                raise ValidationFailed(details={field: [f"Keep each list under {MAX_LIST_ITEMS} items."]})
            blocks.append({"type": "list", "items": [item for item in items if item]})
            list_items.clear()

    def flush_quote():
        if quote:
            content: list[dict] = []
            for index, line in enumerate(quote):
                if index:
                    content.append({"type": "break"})
                content.extend(parse_inline(line, field=field, links=links))
            if content:
                blocks.append({"type": "quote", "content": content})
            quote.clear()

    def flush_all():
        flush_paragraph()
        flush_list()
        flush_quote()

    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            flush_all()
            continue
        heading = re.match(r"^#{1,3}\s+(.*)$", line)
        bullet = re.match(r"^[-*]\s+(.*)$", line)
        quoted = re.match(r"^>\s?(.*)$", line)
        if heading:
            flush_all()
            content = parse_inline(heading.group(1).strip(), field=field, links=links)
            if content:
                blocks.append({"type": "heading", "content": content})
        elif bullet:
            flush_paragraph()
            flush_quote()
            list_items.append(bullet.group(1).strip())
        elif quoted:
            flush_paragraph()
            flush_list()
            quote.append(quoted.group(1).strip())
        else:
            flush_list()
            flush_quote()
            paragraph.append(line)
        if len(blocks) > MAX_BLOCKS:
            raise ValidationFailed(details={field: ["Your bio has too many sections. Shorten it."]})
    flush_all()
    if len(blocks) > MAX_BLOCKS:
        raise ValidationFailed(details={field: ["Your bio has too many sections. Shorten it."]})
    return {"type": "doc", "content": blocks}


# ---------------------------------------------------------------------------
# Validation of stored documents (published snapshots are re-checked on read)
# ---------------------------------------------------------------------------
def _valid_inline(nodes) -> bool:
    if not isinstance(nodes, list):
        return False
    for node in nodes:
        if not isinstance(node, dict):
            return False
        kind = node.get("type")
        if kind == "text":
            if not isinstance(node.get("text"), str) or set(node.get("marks") or []) - set(MARKS):
                return False
        elif kind == "link":
            if not isinstance(node.get("text"), str) or not isinstance(node.get("href"), str):
                return False
            try:
                clean_url(node["href"], field="href")
            except ValidationFailed:
                return False
        elif kind != "break":
            return False
    return True


def is_valid(doc) -> bool:
    if not isinstance(doc, dict) or doc.get("type") != "doc" or not isinstance(doc.get("content"), list):
        return False
    for block in doc["content"]:
        if not isinstance(block, dict):
            return False
        kind = block.get("type")
        if kind in {"paragraph", "heading", "quote"}:
            if not _valid_inline(block.get("content")):
                return False
        elif kind == "list":
            items = block.get("items")
            if not isinstance(items, list) or not all(_valid_inline(item) for item in items):
                return False
        else:
            return False
    return True


def plain_text(doc) -> str:
    """All visible text of a document (for search snippets and PII scanning)."""
    parts: list[str] = []

    def inline(nodes):
        for node in nodes or []:
            if node.get("type") in {"text", "link"}:
                parts.append(node.get("text", ""))
                if node.get("type") == "link":
                    parts.append(" " + node.get("href", ""))
            elif node.get("type") == "break":
                parts.append("\n")

    for block in (doc or {}).get("content", []):
        if block.get("type") == "list":
            for item in block.get("items", []):
                inline(item)
                parts.append("\n")
        else:
            inline(block.get("content"))
            parts.append("\n")
    return "".join(parts).strip()


# ---------------------------------------------------------------------------
# HTML rendering (admin moderation preview only), then allowlist-sanitised
# ---------------------------------------------------------------------------
def _render_inline(nodes) -> str:
    out = []
    for node in nodes or []:
        kind = node.get("type")
        if kind == "break":
            out.append("<br>")
        elif kind == "link":
            try:
                href = clean_url(node.get("href", ""), field="href")
            except ValidationFailed:
                out.append(escape(str(node.get("text", ""))))
                continue
            out.append(
                f'<a href="{escape(href, quote=True)}" rel="{LINK_REL}" target="_blank">{escape(str(node.get("text", "")))}</a>'
            )
        elif kind == "text":
            html = escape(str(node.get("text", "")))
            marks = node.get("marks") or []
            if "code" in marks:
                html = f"<code>{html}</code>"
            if "italic" in marks:
                html = f"<em>{html}</em>"
            if "bold" in marks:
                html = f"<strong>{html}</strong>"
            out.append(html)
    return "".join(out)


def render_html(doc) -> str:
    """Escaped HTML for a document, passed through the allowlist sanitiser."""
    if not is_valid(doc):
        return ""
    out = []
    for block in doc["content"]:
        kind = block["type"]
        if kind == "paragraph":
            out.append(f"<p>{_render_inline(block['content'])}</p>")
        elif kind == "heading":
            out.append(f"<h3>{_render_inline(block['content'])}</h3>")
        elif kind == "quote":
            out.append(f"<blockquote>{_render_inline(block['content'])}</blockquote>")
        elif kind == "list":
            items = "".join(f"<li>{_render_inline(item)}</li>" for item in block["items"])
            out.append(f"<ul>{items}</ul>")
    return sanitize_html("".join(out))
