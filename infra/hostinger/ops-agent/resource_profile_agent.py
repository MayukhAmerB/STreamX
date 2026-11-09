#!/usr/bin/env python3
"""Apply the admin-selected server resource profile to running containers.

Runs on the Docker host (systemd). Every cycle it asks the backend which
profile is desired, then reconciles each service's CPU quota with
`docker update --cpus`, which changes limits live without restarting
containers. The values come only from infra/hostinger/resource-profiles/*.env
on this host; the backend can choose a profile name, nothing else. Applied
values are also written to the production env file so later
`docker compose up` recreates keep the selected profile.

Standard library only.
"""

import argparse
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

PROFILE_NAMES = ("content", "broadcast", "meeting")
CPU_VALUE = re.compile(r"^\d{1,2}(\.\d{1,2})?$")
KEY_SERVICES = {
    "POSTGRES_CPUS": ("postgres",),
    "REDIS_CPUS": ("redis",),
    "BACKEND_CPUS": ("backend",),
    "BACKEND_POOL_CPUS": ("backend-2", "backend-3", "backend-4"),
    "WORKER_CPUS": ("worker",),
    "TRANSCODER_CPUS": ("transcoder",),
    "LIVEKIT_CPUS": ("livekit",),
    "LIVEKIT_EGRESS_CPUS": ("livekit-egress",),
    "OWNCAST_CPUS": ("owncast",),
    "MEDIA_CPUS": ("media",),
    "FRONTEND_CPUS": ("frontend",),
    "GATEWAY_CPUS": ("gateway",),
    "PGBOUNCER_CPUS": ("pgbouncer",),
}


class AgentError(Exception):
    pass


def log(message):
    print(f"[resource-profile-agent] {message}", flush=True)


def load_profile(profile_dir, name):
    if name not in PROFILE_NAMES:
        raise AgentError(f"Unknown profile {name!r}.")
    path = Path(profile_dir) / f"{name}.env"
    values = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if key not in KEY_SERVICES:
            continue
        if not CPU_VALUE.match(value) or float(value) <= 0:
            raise AgentError(f"{path}: invalid CPU value {key}={value!r}.")
        values[key] = value
    if not values:
        raise AgentError(f"{path} defines no CPU values.")
    return values


def docker(*args, runner=subprocess.run):
    result = runner(["docker", *args], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise AgentError(f"docker {' '.join(args[:2])} failed: {(result.stderr or result.stdout).strip()}")
    return result.stdout.strip()


def project_containers(project, runner=subprocess.run):
    """Return (service, container_id, nano_cpus) for every running project container.

    Two docker calls per cycle regardless of how many services exist.
    """
    ids = docker("ps", "-q", "--filter", f"label=com.docker.compose.project={project}", runner=runner).split()
    if not ids:
        return []
    output = docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "com.docker.compose.service"}} {{.Id}} {{.HostConfig.NanoCpus}}',
        *ids,
        runner=runner,
    )
    rows = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[2].isdigit():
            rows.append((parts[0], parts[1], int(parts[2])))
    return rows


def nano_cpus(value):
    return int(round(float(value) * 1_000_000_000))


def reconcile(values, project, runner=subprocess.run):
    """Bring every running container's CPU quota to the profile; return the number updated."""
    targets = {service: cpus for key, cpus in values.items() for service in KEY_SERVICES[key]}
    updated = 0
    for service, container, current in project_containers(project, runner=runner):
        cpus = targets.get(service)
        if cpus is None or current == nano_cpus(cpus):
            continue
        docker("update", "--cpus", cpus, container, runner=runner)
        log(f"{service}: cpus -> {cpus}")
        updated += 1
    return updated


def persist_env(env_file, values):
    """Write the profile's CPU values into the compose env file atomically."""
    path = Path(env_file)
    if not path.is_file():
        return False
    original = path.read_text(encoding="utf-8")
    lines = original.splitlines()
    remaining = dict(values)
    for index, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key in remaining:
            lines[index] = f"{key}={remaining.pop(key)}"
    lines.extend(f"{key}={value}" for key, value in remaining.items())
    updated = "\n".join(lines) + "\n"
    if updated == original:
        return False
    shutil.copy2(path, path.with_name(path.name + ".bak-resource-profile"))
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(updated)
        temp_name = handle.name
    shutil.copymode(path, temp_name)
    os.replace(temp_name, path)
    return True


class BackendClient:
    def __init__(self, base_url, token, host_header):
        self.base_url = base_url.rstrip("/") + "/"
        self.token = token
        self.host_header = host_header

    def _request(self, url, payload=None):
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(url, data=body, method="POST" if body else "GET")
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("Accept", "application/json")
        request.add_header("Host", self.host_header)
        request.add_header("X-Forwarded-Proto", "https")
        if body:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode() or "{}")
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as exc:
            # Includes resets while a backend restarts; the next cycle retries.
            raise AgentError(f"backend request failed: {exc}") from exc

    def desired_profile(self):
        data = (self._request(self.base_url) or {}).get("data") or {}
        name = str(data.get("profile") or "").strip()
        if name not in PROFILE_NAMES:
            raise AgentError(f"backend returned unknown profile {name!r}.")
        return name

    def report(self, applied_profile, error=""):
        self._request(self.base_url + "report/", {"applied_profile": applied_profile, "error": error})


def run_cycle(client, profile_dir, project, env_file, runner=subprocess.run):
    """One reconcile pass; returns (applied_profile, error)."""
    try:
        name = client.desired_profile()
    except AgentError as exc:
        log(str(exc))
        return "", str(exc)
    try:
        values = load_profile(profile_dir, name)
        reconcile(values, project, runner=runner)
        if persist_env(env_file, values):
            log(f"saved {name} profile to {env_file}")
        applied, error = name, ""
    except (AgentError, OSError, subprocess.SubprocessError) as exc:
        log(f"failed to apply {name}: {exc}")
        applied, error = "", str(exc)
    try:
        client.report(applied, error)
    except AgentError as exc:
        log(str(exc))
    return applied, error


def main(argv=None):
    repo_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--once", action="store_true", help="Run a single reconcile pass and exit.")
    args = parser.parse_args(argv)

    token = os.environ.get("STREAMX_OPS_TOKEN", "").strip()
    if not token:
        log("STREAMX_OPS_TOKEN is not set.")
        return 2
    client = BackendClient(
        os.environ.get("STREAMX_OPS_API", "http://127.0.0.1:8000/api/internal/ops/resource-profile/"),
        token,
        os.environ.get("STREAMX_API_HOSTNAME", "api.alsyedinitiative.com"),
    )
    profile_dir = os.environ.get("STREAMX_PROFILE_DIR", str(repo_root / "infra/hostinger/resource-profiles"))
    env_file = os.environ.get("STREAMX_ENV_FILE", str(repo_root / "backend/.env.hostinger.production"))
    project = os.environ.get("STREAMX_COMPOSE_PROJECT", "streamx")
    interval = max(5, int(os.environ.get("STREAMX_AGENT_INTERVAL_SECONDS", "15")))

    while True:
        try:
            _applied, error = run_cycle(client, profile_dir, project, env_file)
        except Exception as exc:  # never let one bad cycle stop the agent
            log(f"cycle failed: {exc!r}")
            error = str(exc)
        if args.once:
            return 1 if error else 0
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main())
