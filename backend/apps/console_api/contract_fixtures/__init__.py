"""Frozen UI-overhaul contract fixtures (plan Appendix A), FROZEN after WS-0.

The JSON files here are byte-identical copies of
``frontend/src/__contracts__/ui-overhaul/*.json`` (checked by
``tests/test_ui_overhaul_contracts.py``). Each file maps a variant name to
one payload (the ``data`` member of the API envelope)::

    from apps.console_api.contract_fixtures import load_fixture

    load_fixture("attention")["busy"]

Stub views return these until their owners implement the real services;
tests use them as the reference shape.
"""

from __future__ import annotations

import copy
import json
from functools import lru_cache
from pathlib import Path

FIXTURE_DIR = Path(__file__).resolve().parent
FIXTURE_NAMES = ("capabilities", "today", "attention", "search", "features", "errors")


@lru_cache(maxsize=None)
def _read(name: str) -> dict:
    if name not in FIXTURE_NAMES:
        raise KeyError(name)
    return json.loads((FIXTURE_DIR / f"{name}.json").read_text(encoding="utf-8"))


def load_fixture(name: str) -> dict:
    """A deep copy of fixture ``name`` (callers may mutate it)."""
    return copy.deepcopy(_read(name))
