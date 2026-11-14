"""The profile document: a block list the owner arranges, validated server-side.

The client sends a document; ``normalize_document`` rebuilds it from scratch
with only known keys, cleaned text, checked links and images the owner
actually uploaded. Nothing the client sends is stored as-is. The function
also returns every user-written string with its field path, for the PII guard.

Shape (``v`` = 1)::

    {"v": 1,
     "theme":  {"accent": "gold"|"white", "align": "center"|"left",
                "banner": "lines"|"image"|"none", "tagline": "hand"|"plain"},
     "header": {"display_name": str, "tagline": str, "avatar_id": uuid|null, "banner_id": uuid|null},
     "blocks": [{"id": str, "type": "bio"|"badges"|"skills"|"writeups"|"gallery"|"links",
                 "visible": bool, "title": str, ...type fields}]}

Layout order is the order of ``blocks``; each type appears at most once.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable, Mapping

from apps.core.errors import ValidationFailed

from . import richtext
from .sanitize import clean_text, clean_url, link_host

DOC_VERSION = 1
BLOCK_TYPES = ("bio", "badges", "skills", "writeups", "gallery", "links")
THEME_CHOICES = {
    "accent": ("gold", "white"),
    "align": ("center", "left"),
    "banner": ("lines", "image", "none"),
    "tagline": ("hand", "plain"),
}
DEFAULT_THEME = {"accent": "gold", "align": "center", "banner": "lines", "tagline": "hand"}
SKILL_LEVELS = ("learning", "practising", "confident")
LIMITS = {
    "display_name": 40,
    "tagline": 60,
    "tagline_words": 8,
    "block_title": 40,
    "badges": 8,
    "skills": 24,
    "skill_name": 40,
    "writeups": 12,
    "writeup_title": 90,
    "writeup_summary": 280,
    "writeup_tags": 5,
    "tag": 24,
    "gallery": 12,
    "caption": 140,
    "alt": 140,
    "links": 8,
    "link_label": 40,
}
DEFAULT_TITLES = {
    "bio": "About",
    "badges": "Badges",
    "skills": "Skills",
    "writeups": "Write-ups",
    "gallery": "Gallery",
    "links": "Links",
}
_BLOCK_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")


def default_document(handle: str) -> dict:
    return {
        "v": DOC_VERSION,
        "theme": dict(DEFAULT_THEME),
        "header": {"display_name": handle, "tagline": "", "avatar_id": None, "banner_id": None},
        "blocks": [
            {"id": "bio", "type": "bio", "visible": True, "title": "", "source": "", "doc": {"type": "doc", "content": []}},
            {"id": "badges", "type": "badges", "visible": True, "title": "", "badge_keys": []},
            {"id": "skills", "type": "skills", "visible": True, "title": "", "items": []},
            {"id": "writeups", "type": "writeups", "visible": True, "title": "", "items": []},
            {"id": "links", "type": "links", "visible": True, "title": "", "items": []},
        ],
    }


class _Collector:
    def __init__(self):
        self.fields: list[tuple[str, str]] = []

    def add(self, path: str, text: str):
        if text:
            self.fields.append((path, text))


def _mapping(value, field: str) -> Mapping:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValidationFailed(details={field: ["Expected an object."]})
    return value


def _items(value, field: str, limit: int) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationFailed(details={field: ["Expected a list."]})
    if len(value) > limit:
        raise ValidationFailed(details={field: [f"Use at most {limit} items here."]})
    return value


def _image_ref(value, field: str, kind: str, owned_images: Mapping[str, str]) -> str | None:
    if value in (None, ""):
        return None
    try:
        key = str(uuid.UUID(str(value)))
    except (TypeError, ValueError):
        raise ValidationFailed(details={field: ["Unknown image."]}) from None
    if owned_images.get(key) != kind:
        raise ValidationFailed(details={field: ["Upload this image first (or pick one you uploaded)."]})
    return key


def normalize_document(
    raw,
    *,
    handle: str,
    owned_images: Mapping[str, str],
    badge_keys: Callable[[], set[str] | None] | None = None,
) -> tuple[dict, list[tuple[str, str]]]:
    """``(clean document, [(path, text), ...])`` or ``ValidationFailed``.

    ``owned_images`` maps the owner's image ids to their kind.
    ``badge_keys`` returns the badge keys that exist (None: catalogue
    unavailable, so keys are only shape-checked).
    """
    raw = _mapping(raw, "document")
    collect = _Collector()

    theme_raw = _mapping(raw.get("theme"), "theme")
    theme = {}
    for key, choices in THEME_CHOICES.items():
        value = theme_raw.get(key, DEFAULT_THEME[key])
        theme[key] = value if value in choices else DEFAULT_THEME[key]

    header_raw = _mapping(raw.get("header"), "header")
    display_name = clean_text(
        header_raw.get("display_name", ""), field="header.display_name", max_length=LIMITS["display_name"]
    ) or handle
    tagline = clean_text(header_raw.get("tagline", ""), field="header.tagline", max_length=LIMITS["tagline"])
    if tagline and len(tagline.split()) > LIMITS["tagline_words"]:
        raise ValidationFailed(details={"header.tagline": [f"Keep the tagline to {LIMITS['tagline_words']} words."]})
    header = {
        "display_name": display_name,
        "tagline": tagline,
        "avatar_id": _image_ref(header_raw.get("avatar_id"), "header.avatar_id", "avatar", owned_images),
        "banner_id": _image_ref(header_raw.get("banner_id"), "header.banner_id", "banner", owned_images),
    }
    collect.add("header.display_name", display_name if display_name != handle else "")
    collect.add("header.tagline", tagline)

    blocks_raw = _items(raw.get("blocks"), "blocks", len(BLOCK_TYPES))
    blocks: list[dict] = []
    seen_types: set[str] = set()
    seen_ids: set[str] = set()
    available_badges = badge_keys() if badge_keys else None
    for index, block_raw in enumerate(blocks_raw):
        path = f"blocks[{index}]"
        block_raw = _mapping(block_raw, path)
        kind = block_raw.get("type")
        if kind not in BLOCK_TYPES:
            raise ValidationFailed(details={f"{path}.type": ["Unknown block type."]})
        if kind in seen_types:
            raise ValidationFailed(details={f"{path}.type": ["Each block can appear once."]})
        seen_types.add(kind)
        block_id = str(block_raw.get("id") or kind)
        if not _BLOCK_ID.match(block_id) or block_id in seen_ids:
            block_id = kind
        seen_ids.add(block_id)
        title = clean_text(block_raw.get("title", ""), field=f"{path}.title", max_length=LIMITS["block_title"])
        collect.add(f"{path}.title", title)
        block = {"id": block_id, "type": kind, "visible": bool(block_raw.get("visible", True)), "title": title}

        if kind == "bio":
            source = clean_text(
                block_raw.get("source", ""), field=f"{path}.source", max_length=richtext.MAX_SOURCE_LENGTH, multiline=True
            )
            block["source"] = source
            block["doc"] = richtext.parse(source, field=f"{path}.source")
            collect.add(f"{path}.source", source)
        elif kind == "badges":
            keys = []
            for key_index, key in enumerate(_items(block_raw.get("badge_keys"), f"{path}.badge_keys", LIMITS["badges"])):
                if not isinstance(key, str) or not re.fullmatch(r"[a-z0-9_\-]{1,40}", key):
                    raise ValidationFailed(details={f"{path}.badge_keys[{key_index}]": ["Unknown badge."]})
                if available_badges is not None and key not in available_badges:
                    continue
                if key not in keys:
                    keys.append(key)
            block["badge_keys"] = keys
        elif kind == "skills":
            items = []
            for item_index, item in enumerate(_items(block_raw.get("items"), f"{path}.items", LIMITS["skills"])):
                item_path = f"{path}.items[{item_index}]"
                item = _mapping(item, item_path)
                name = clean_text(item.get("name", ""), field=f"{item_path}.name", max_length=LIMITS["skill_name"], required=True)
                level = item.get("level") if item.get("level") in SKILL_LEVELS else "learning"
                items.append({"name": name, "level": level})
                collect.add(f"{item_path}.name", name)
            block["items"] = items
        elif kind == "writeups":
            items = []
            for item_index, item in enumerate(_items(block_raw.get("items"), f"{path}.items", LIMITS["writeups"])):
                item_path = f"{path}.items[{item_index}]"
                item = _mapping(item, item_path)
                title_text = clean_text(
                    item.get("title", ""), field=f"{item_path}.title", max_length=LIMITS["writeup_title"], required=True
                )
                summary = clean_text(
                    item.get("summary", ""), field=f"{item_path}.summary", max_length=LIMITS["writeup_summary"], multiline=True
                )
                url = item.get("url") or ""
                url = clean_url(url, field=f"{item_path}.url") if url else ""
                tags = []
                for tag_index, tag in enumerate(_items(item.get("tags"), f"{item_path}.tags", LIMITS["writeup_tags"])):
                    tag = clean_text(tag, field=f"{item_path}.tags[{tag_index}]", max_length=LIMITS["tag"])
                    if tag and tag not in tags:
                        tags.append(tag)
                        collect.add(f"{item_path}.tags[{tag_index}]", tag)
                items.append({"title": title_text, "summary": summary, "url": url, "host": link_host(url) if url else "", "tags": tags})
                collect.add(f"{item_path}.title", title_text)
                collect.add(f"{item_path}.summary", summary)
                collect.add(f"{item_path}.url", url)
            block["items"] = items
        elif kind == "gallery":
            items = []
            used: set[str] = set()
            for item_index, item in enumerate(_items(block_raw.get("items"), f"{path}.items", LIMITS["gallery"])):
                item_path = f"{path}.items[{item_index}]"
                item = _mapping(item, item_path)
                image_id = _image_ref(item.get("image_id"), f"{item_path}.image_id", "gallery", owned_images)
                if not image_id or image_id in used:
                    continue
                used.add(image_id)
                caption = clean_text(item.get("caption", ""), field=f"{item_path}.caption", max_length=LIMITS["caption"])
                alt = clean_text(item.get("alt", ""), field=f"{item_path}.alt", max_length=LIMITS["alt"])
                items.append({"image_id": image_id, "caption": caption, "alt": alt})
                collect.add(f"{item_path}.caption", caption)
                collect.add(f"{item_path}.alt", alt)
            block["items"] = items
        elif kind == "links":
            items = []
            for item_index, item in enumerate(_items(block_raw.get("items"), f"{path}.items", LIMITS["links"])):
                item_path = f"{path}.items[{item_index}]"
                item = _mapping(item, item_path)
                url = clean_url(item.get("url", ""), field=f"{item_path}.url")
                label = clean_text(item.get("label", ""), field=f"{item_path}.label", max_length=LIMITS["link_label"]) or link_host(url)
                items.append({"label": label, "url": url, "host": link_host(url)})
                collect.add(f"{item_path}.label", label)
                collect.add(f"{item_path}.url", url)
            block["items"] = items
        blocks.append(block)

    return {"v": DOC_VERSION, "theme": theme, "header": header, "blocks": blocks}, collect.fields


def referenced_image_ids(doc) -> set[str]:
    """Image ids a document shows (avatar, banner, gallery)."""
    ids: set[str] = set()
    if not isinstance(doc, Mapping):
        return ids
    header = doc.get("header") or {}
    for key in ("avatar_id", "banner_id"):
        if header.get(key):
            ids.add(str(header[key]))
    for block in doc.get("blocks") or []:
        if isinstance(block, Mapping) and block.get("type") == "gallery":
            for item in block.get("items") or []:
                if isinstance(item, Mapping) and item.get("image_id"):
                    ids.add(str(item["image_id"]))
    return ids
