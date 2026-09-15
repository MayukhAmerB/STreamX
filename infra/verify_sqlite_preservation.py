"""Check that all original application rows survive an additive local migration/import.

Usage: python infra/verify_sqlite_preservation.py <database> <backup>
Prints counts only, never application data. Both databases are opened read-only.
"""

import sqlite3
import sys
from pathlib import Path


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def verify(database, backup):
    with sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True) as connection:
        connection.execute("ATTACH DATABASE ? AS original", (Path(backup).resolve().as_uri() + "?mode=ro",))
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM original.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]
        total = 0
        checked = 0
        for table in tables:
            if table in {"django_migrations", "django_content_type", "auth_permission"}:
                continue
            columns = [row[1] for row in connection.execute(f"PRAGMA original.table_info({quote(table)})")]
            selected = ",".join(quote(column) for column in columns)
            lost = connection.execute(
                f"SELECT COUNT(*) FROM (SELECT {selected} FROM original.{quote(table)} "
                f"EXCEPT SELECT {selected} FROM main.{quote(table)})"
            ).fetchone()[0]
            if lost:
                raise RuntimeError(f"Preservation check failed: {table}, {lost} changed or missing original rows")
            total += connection.execute(f"SELECT COUNT(*) FROM original.{quote(table)}").fetchone()[0]
            checked += 1
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite integrity check failed")
        print(f"PASS: all {total} original rows across {checked} application tables preserved; SQLite integrity OK.")


if __name__ == "__main__":
    verify(*sys.argv[1:])
