"""Import free OSINT challenges (metadata only) from a JSON or CSV file.

    manage.py import_osint_directory                       # dry run of the starter list
    manage.py import_osint_directory path/to/file.csv --apply
    manage.py import_osint_directory file.json --apply --update

JSON: ``{"paths": [{key, title, summary, order}], "challenges": [{...}]}`` or a
bare list of challenges. CSV: one challenge per row with the column names of
``OsintChallenge`` (``skills`` separated by ``;``, ``path`` = path key).

Rows are matched by ``slug``. New rows are created; existing rows are left
alone unless ``--update`` is given (admin edits win by default). Every row is
validated with the model rules (https links, licence rules for hosting,
members' labs expert/professional only), so an invalid row stops the import.
Never store another platform's challenge text, images or answers here.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.text import slugify

from apps.osint_labs.models import OsintChallenge, OsintPath

DEFAULT_FILE = Path(__file__).resolve().parents[2] / "data" / "starter_directory.json"
FIELDS = (
    "title", "summary", "platform", "url", "difficulty", "skills", "estimated_minutes", "source_is_free",
    "hosting", "access_tier", "licence", "licence_url", "attribution", "source_repository", "xp", "path_order",
    "is_published",
)
BOOL_FIELDS = {"source_is_free", "is_published"}
INT_FIELDS = {"estimated_minutes", "xp", "path_order"}


def _bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def load_rows(path: Path) -> tuple[list[dict], list[dict]]:
    if not path.exists():
        raise CommandError(f"File not found: {path}")
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            rows = list(csv.DictReader(handle))
        for row in rows:
            row["skills"] = [item.strip() for item in str(row.get("skills") or "").split(";") if item.strip()]
        return [], rows
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CommandError(f"Invalid JSON: {exc}") from exc
    if isinstance(data, list):
        return [], data
    if not isinstance(data, dict):
        raise CommandError("Expected a JSON object or list.")
    return list(data.get("paths") or []), list(data.get("challenges") or [])


def normalise(row: dict) -> dict:
    values = {}
    for name in FIELDS:
        if name not in row or row[name] in (None, ""):
            continue
        value = row[name]
        if name in BOOL_FIELDS:
            value = _bool(value)
        elif name in INT_FIELDS:
            value = int(value)
        values[name] = value
    return values


def import_rows(paths, rows, *, apply=False, update=False) -> dict:
    report = {"paths_created": [], "create": [], "update": [], "unchanged": [], "errors": []}
    with transaction.atomic():
        path_map = {path.key: path for path in OsintPath.objects.all()}
        for item in paths:
            key = slugify(str(item.get("key") or item.get("title") or ""))[:40]
            if not key or key in path_map:
                continue
            path = OsintPath(
                key=key,
                title=str(item.get("title") or key)[:80],
                summary=str(item.get("summary") or "")[:200],
                order=int(item.get("order") or 0),
            )
            path.full_clean()
            path.save()
            path_map[key] = path
            report["paths_created"].append(key)
        existing = {row.slug: row for row in OsintChallenge.objects.all()}
        for index, row in enumerate(rows, start=1):
            slug = slugify(str(row.get("slug") or row.get("title") or ""))[:80]
            if not slug:
                report["errors"].append(f"row {index}: missing slug/title")
                continue
            values = normalise(row)
            path_key = str(row.get("path") or "").strip()
            values["path"] = path_map.get(path_key) if path_key else None
            if path_key and values["path"] is None:
                report["errors"].append(f"{slug}: unknown path {path_key!r}")
                continue
            challenge = existing.get(slug)
            if challenge is not None and not update:
                report["unchanged"].append(slug)
                continue
            target = challenge or OsintChallenge(slug=slug)
            for name, value in values.items():
                setattr(target, name, value)
            try:
                target.full_clean()
            except ValidationError as exc:
                report["errors"].append(f"{slug}: {'; '.join(exc.messages)}")
                continue
            target.save()
            (report["update"] if challenge is not None else report["create"]).append(slug)
        if report["errors"] or not apply:
            transaction.set_rollback(True)
    return report


class Command(BaseCommand):
    help = "Import free OSINT challenge metadata (link-out directory) from JSON or CSV. Dry run unless --apply."

    def add_arguments(self, parser):
        parser.add_argument("file", nargs="?", default=str(DEFAULT_FILE))
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--update", action="store_true", help="Overwrite existing rows with the file's values.")

    def handle(self, *args, **options):
        paths, rows = load_rows(Path(options["file"]))
        report = import_rows(paths, rows, apply=options["apply"], update=options["update"])
        mode = "APPLY" if options["apply"] else "DRY RUN"
        self.stdout.write(f"import_osint_directory [{mode}] {options['file']}")
        self.stdout.write(f"  paths created: {len(report['paths_created'])}")
        self.stdout.write(f"  create: {len(report['create'])}  update: {len(report['update'])}  "
                          f"unchanged: {len(report['unchanged'])}")
        for error in report["errors"]:
            self.stderr.write(f"  ERROR {error}")
        if report["errors"]:
            raise CommandError(f"{len(report['errors'])} invalid row(s); nothing was written.")
        if not options["apply"]:
            self.stdout.write("Nothing written. Re-run with --apply.")
