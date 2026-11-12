#!/usr/bin/env bash
# Report files: separate noexec storage mounted only into backend/worker
# containers, never into media/nginx/frontend; the ClamAV service is internal,
# pinned, sized and health-checked; deploy scripts prepare storage first.
# Renders the real phase 4 (single backend) and phase 5 (pool) Compose sets with `docker compose config`.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
HOSTINGER="$REPO_ROOT/infra/hostinger"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

PYTHON="${PYTHON:-$(command -v python3 || command -v python || true)}"
[[ -n "$PYTHON" ]] || fail "python3 is required"
docker compose version >/dev/null 2>&1 || fail "docker compose is required to render the Compose files"

# Render from a copy of the compose files (the production env file is not in git).
mkdir -p "$TEST_ROOT/repo/infra/hostinger" "$TEST_ROOT/repo/backend"
cp "$REPO_ROOT/docker-compose.hostinger.yml" "$TEST_ROOT/repo/"
cp "$HOSTINGER"/docker-compose.hostinger.*.yml "$TEST_ROOT/repo/infra/hostinger/"
: > "$TEST_ROOT/repo/backend/.env.hostinger.production"
printf 'POSTGRES_PASSWORD=test\nOWNCAST_STREAM_KEY=test\n' > "$TEST_ROOT/env"

render() {
  local output="$1"
  shift
  local args=()
  local file
  for file in "$@"; do
    args+=(-f "$TEST_ROOT/repo/$file")
  done
  (cd "$TEST_ROOT/repo" && docker compose -p streamx --env-file "$TEST_ROOT/env" "${args[@]}" config --format json) > "$output" \
    || fail "docker compose config failed for: $*"
}

render "$TEST_ROOT/phase4.json" \
  docker-compose.hostinger.yml \
  infra/hostinger/docker-compose.hostinger.resource-limits.yml \
  infra/hostinger/docker-compose.hostinger.resource-limits.pgbouncer.yml \
  infra/hostinger/docker-compose.hostinger.async-workers.yml \
  infra/hostinger/docker-compose.hostinger.pgbouncer.yml \
  infra/hostinger/docker-compose.hostinger.postgres-tuning.yml
render "$TEST_ROOT/phase5.json" \
  docker-compose.hostinger.yml \
  infra/hostinger/docker-compose.hostinger.resource-limits.yml \
  infra/hostinger/docker-compose.hostinger.resource-limits.pool.yml \
  infra/hostinger/docker-compose.hostinger.resource-limits.pgbouncer.yml \
  infra/hostinger/docker-compose.hostinger.async-workers.yml \
  infra/hostinger/docker-compose.hostinger.backend-pool.yml \
  infra/hostinger/docker-compose.hostinger.gateway-lb.yml \
  infra/hostinger/docker-compose.hostinger.pgbouncer.yml \
  infra/hostinger/docker-compose.hostinger.pgbouncer.pool.yml \
  infra/hostinger/docker-compose.hostinger.postgres-tuning.yml

"$PYTHON" - "$TEST_ROOT/phase4.json" "$TEST_ROOT/phase5.json" "$HOSTINGER/clamav/clamd.conf" <<'PY'
import json
import re
import sys

REPORTS = "/srv/streamx/reports"
QUARANTINE = "/srv/streamx/reports-quarantine"
PHASE5_WRITERS = {
    "backend", "backend-2", "backend-3", "backend-4", "payment-backend-1", "payment-backend-2",
    "worker", "worker-2", "stream-recorder",
}
NEVER = {"media", "gateway", "frontend", "owlcognito-frontend", "cases", "osint-labs", "owncast", "livekit",
         "livekit-egress", "transcoder", "postgres", "redis", "pgbouncer", "clamav"}
problems = []


def check(condition, message):
    if not condition:
        problems.append(message)


def size_bytes(value):
    match = re.fullmatch(r"(\d+(?:\.\d+)?)([kmg]?)b?", str(value).strip().lower())
    if not match:
        return 0
    return int(float(match.group(1)) * {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[match.group(2)])


def seconds(value):
    total = 0
    for amount, unit in re.findall(r"(\d+)([hms])", str(value)):
        total += int(amount) * {"h": 3600, "m": 60, "s": 1}[unit]
    return total


def mounts(service):
    return service.get("volumes") or []


for label, path, writers in (("phase4", sys.argv[1], {"backend", "worker", "worker-2", "stream-recorder"}),
                             ("phase5", sys.argv[2], PHASE5_WRITERS)):
    config = json.load(open(path, encoding="utf-8"))
    services = config["services"]
    check("backend_private_media" not in (config.get("volumes") or {}),
          f"{label}: the old named volume must not be (re)defined")
    for name, service in services.items():
        report_mounts = [m for m in mounts(service)
                         if str(m.get("source", "")).replace("\\", "/").startswith(REPORTS)
                         or m.get("target") in ("/app/private_media", "/app/private_quarantine")
                         or m.get("source") == "backend_private_media"]
        if name in writers:
            by_target = {m.get("target"): m for m in report_mounts}
            for target, source in (("/app/private_media", REPORTS), ("/app/private_quarantine", QUARANTINE)):
                mount = by_target.get(target)
                check(mount is not None, f"{label}: {name} must mount {source} at {target}")
                if mount:
                    check(mount.get("type") == "bind", f"{label}: {name} {target} must be a bind mount")
                    check(mount.get("source") == source, f"{label}: {name} {target} must come from {source}")
                    check(not (mount.get("bind") or {}).get("create_host_path"),
                          f"{label}: {name} {target} must not let Docker create the host path")
                    check(not mount.get("read_only"), f"{label}: {name} {target} must be writable")
            check("avnet" in (service.get("networks") or {}), f"{label}: {name} must reach clamd on avnet")
        else:
            check(not report_mounts, f"{label}: {name} must never mount report storage: {report_mounts}")
        if name in NEVER:
            check(name not in writers, f"{label}: {name} cannot be a writer")
    for name in writers:
        check(name in services, f"{label}: expected service {name}")

    clamav = services.get("clamav")
    check(clamav is not None, f"{label}: clamav service missing")
    if clamav:
        check(re.fullmatch(r"clamav/clamav:\d+\.\d+\.\d+", clamav.get("image", "")) is not None,
              f"{label}: clamav image must be pinned to an exact version: {clamav.get('image')}")
        check(not clamav.get("ports"), f"{label}: clamav must not publish ports")
        check(set((clamav.get("networks") or {}).keys()) == {"avnet", "av_egress"},
              f"{label}: clamav networks must be avnet + av_egress only")
        limit = size_bytes(clamav.get("mem_limit", 0))
        check(2.5 * 1024**3 <= limit <= 4 * 1024**3, f"{label}: clamav mem_limit must be 2.5-4 GiB, got {limit}")
        health = clamav.get("healthcheck") or {}
        check("clamdcheck.sh" in " ".join(health.get("test") or []), f"{label}: clamav healthcheck must PING clamd")
        check(seconds(health.get("start_period", "0s")) >= 600, f"{label}: clamav start_period must cover the first download")
        targets = {m.get("target"): m for m in mounts(clamav)}
        db = targets.get("/var/lib/clamav") or {}
        check(db.get("type") == "volume" and db.get("source") == "clamav_db", f"{label}: clamav DB volume missing")
        for conf in ("/etc/clamav/clamd.conf", "/etc/clamav/freshclam.conf"):
            check((targets.get(conf) or {}).get("read_only"), f"{label}: {conf} must be mounted read-only")
        check(not set(targets) & {"/app/private_media", "/app/private_quarantine"}, f"{label}: clamav gets streams only")
        check(int(str((clamav.get("environment") or {}).get("FRESHCLAM_CHECKS", "0"))) >= 1,
              f"{label}: freshclam must update signatures")
        check(not clamav.get("depends_on"), f"{label}: clamav must not depend on application services")
    check((config.get("volumes") or {}).get("clamav_db", {}).get("name") == "streamx_clamav_db",
          f"{label}: clamav DB volume must be streamx_clamav_db")
    networks = config.get("networks") or {}
    check((networks.get("avnet") or {}).get("internal") is True, f"{label}: avnet must be internal")
    on_avnet = {name for name, service in services.items() if "avnet" in (service.get("networks") or {})}
    check(on_avnet == writers | {"clamav"}, f"{label}: only backend/worker containers and clamav on avnet: {sorted(on_avnet)}")
    for name, service in services.items():
        if name != "backend":
            continue
        check(not any(m.get("target") == "/app/media" and str(m.get("source", "")).startswith(REPORTS)
                      for m in mounts(service)), "report storage must never be inside /app/media")
    media = services.get("media") or {}
    check([m.get("source") for m in mounts(media) if m.get("type") == "volume"] == ["backend_media"],
          f"{label}: media (nginx) must only see the public media volume")

conf = {}
for raw in open(sys.argv[3], encoding="utf-8"):
    line = raw.split("#", 1)[0].strip()
    if line:
        key, _, value = line.partition(" ")
        conf[key] = value.strip()
check(size_bytes(conf.get("StreamMaxLength", "0")) >= 210 * 1024**2, "clamd StreamMaxLength must cover 200 MB + margin")
check(size_bytes(conf.get("MaxFileSize", "0")) >= 500 * 1024**2, "clamd MaxFileSize must cover a 500 MB unpacked vault")
check(size_bytes(conf.get("MaxScanSize", "0")) >= 500 * 1024**2, "clamd MaxScanSize must cover a 500 MB unpacked vault")
check(int(conf.get("MaxFiles", "0")) >= 2000, "clamd MaxFiles must cover a 2000-entry vault")
for key, value in (("AlertEncrypted", "yes"), ("AlertOLE2Macros", "yes"), ("ScanArchive", "yes"),
                   ("AlertExceedsMax", "yes"), ("TCPSocket", "3310"), ("LocalSocket", "/tmp/clamd.sock"),
                   ("ConcurrentDatabaseReload", "no")):
    check(conf.get(key) == value, f"clamd.conf must set {key} {value}")
check("TCPAddr" not in conf or conf["TCPAddr"] == "0.0.0.0", "clamd must listen on the container network")

if problems:
    print("\n".join(f"FAIL: {problem}" for problem in problems), file=sys.stderr)
    sys.exit(1)
PY

# No nginx config (host, gateway or media container) can ever map to report storage.
if grep -REn '/srv/streamx/reports|private_media|private_quarantine|reports-quarantine' "$HOSTINGER/nginx" "$REPO_ROOT/frontend/nginx"* 2>/dev/null; then
  fail "an nginx config references report storage"
fi

# Deploy paths prepare the storage before compose touches containers.
grep -Fq 'bash "$SCRIPT_DIR/prepare-report-storage.sh" prepare' "$HOSTINGER/deploy-phases.sh"
grep -Fq 'bash "$SCRIPT_DIR/prepare-report-storage.sh" finalize' "$HOSTINGER/deploy-phases.sh"
prepare_line="$(grep -n 'prepare-report-storage.sh" prepare' "$HOSTINGER/deploy-phases.sh" | head -n1 | cut -d: -f1)"
first_up_line="$(grep -n 'up -d --build' "$HOSTINGER/deploy-phases.sh" | head -n1 | cut -d: -f1)"
(( prepare_line < first_up_line )) || fail "deploy-phases.sh must prepare storage before compose up"
grep -Fq 'bash "$SCRIPT_DIR/prepare-report-storage.sh" prepare' "$HOSTINGER/deploy-safe.sh"
grep -Fq 'bash "$SCRIPT_DIR/prepare-report-storage.sh" finalize' "$HOSTINGER/deploy-safe.sh"
gate_line="$(grep -n 'check-migration-safety.sh' "$HOSTINGER/release-production.sh" | head -n1 | cut -d: -f1)"
release_prepare_line="$(grep -n 'prepare-report-storage.sh" prepare' "$HOSTINGER/release-production.sh" | head -n1 | cut -d: -f1)"
(( release_prepare_line < gate_line )) || fail "release-production.sh must prepare storage before the migration gate"
grep -Fq 'prepare-report-storage.sh prepare' "$HOSTINGER/deploy-course-v2.sh"
grep -Fq 'prepare-report-storage.sh" prepare' "$HOSTINGER/deploy-course-library.sh"

# Backups read report files from wherever they currently live; restores go to the noexec directory.
grep -Fq 'backup_report_files "backend_private_media.tar.gz"' "$HOSTINGER/backup-data.sh"
! grep -Eq '^backup_volume "streamx_backend_private_media"' "$HOSTINGER/backup-data.sh"
grep -Fq 'restore_report_files "backend_private_media.tar.gz"' "$HOSTINGER/restore-data.sh"
! grep -Eq '^restore_volume "streamx_backend_private_media"' "$HOSTINGER/restore-data.sh"

# The smoke gate waits (bounded) for clamd and checks the noexec mount.
grep -Fq 'check_antivirus --wait-seconds "$ANTIVIRUS_WAIT_SECONDS"' "$HOSTINGER/post-deploy-smoke.sh"
grep -Fq 'ANTIVIRUS_WAIT_SECONDS="${SMOKE_ANTIVIRUS_WAIT_SECONDS:-600}"' "$HOSTINGER/post-deploy-smoke.sh"
grep -Fq 'check_report_storage --require-noexec' "$HOSTINGER/post-deploy-smoke.sh"

echo "Report storage and antivirus configuration tests passed."
