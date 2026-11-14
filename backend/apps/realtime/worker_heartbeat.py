"""Per-process liveness file for the async worker healthcheck (Phase 2 ops).

``process_async_jobs`` runs ``run_periodic_hooks`` on every tick. A hook
registered under a name unique to this process (host + pid) is gated per
process, so every worker process touches its own ``WORKER_HEARTBEAT_FILE``
about every ``HEARTBEAT_INTERVAL_SECONDS``. The compose healthcheck fails
when the file is older than 90 s (a hung or wedged worker), and autoheal
restarts it (infra/hostinger/autoheal.sh).

Web processes register the hook too but never run periodic hooks, so they
never write the file.
"""

from __future__ import annotations

import os
import socket
import time
from pathlib import Path

from django.conf import settings

HEARTBEAT_INTERVAL_SECONDS = 10


def heartbeat_file() -> str:
    return str(getattr(settings, "WORKER_HEARTBEAT_FILE", "") or "").strip()


def hook_name() -> str:
    return f"core.worker_heartbeat:{socket.gethostname()}:{os.getpid()}"


def touch_heartbeat() -> str | None:
    path = heartbeat_file()
    if not path:
        return None
    target = Path(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(int(time.time())), encoding="ascii")
    except OSError:
        return None
    return path
