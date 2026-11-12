# Weekly report files: security model

Students, graders and instructors upload files we do not trust. They are kept
apart from everything else, never executed or rendered on the server, and
virus-scanned before they are stored.

## Upload pipeline (`intake.py`)

1. Django streams the request body to a temporary upload file (small files
   stay in memory).
2. `validate_report_upload` checks type, size and structure (macros, zip
   bombs, fake extensions).
3. The bytes are copied and hashed into `<private root>/.incoming/`: a 0600
   file with a random name on the noexec filesystem.
4. clamd scans exactly that file (INSTREAM over TCP, chunked, with timeouts and
   the `clamd` circuit breaker). The signature version comes from `VERSION`.
5. Only a clean file is renamed (an atomic rename on the same filesystem) to
   `reports/<area>/<YYYY>/<MM>/<32 hex>.bin`, mode 0640, in 0750 directories.
6. The database row is created with its scan record: `scan_status=clean`,
   `scanned_at`, `scanner`, `scan_signature_version`. If the row cannot be
   saved, the file is deleted again.

The same pipeline handles student files, task reference files and annotated
feedback files. Zip vaults are scanned as one archive (clamd unpacks it with
`ScanArchive yes`), on top of the structural checks.

## Fail closed

| Situation | Result | Stored? |
|---|---|---|
| clamd unreachable, timeout, `ERROR` reply, circuit open, scanner `off` | HTTP 503 `antivirus_unavailable`, "Virus scanner is temporarily unavailable, please try again in a minute.", `Retry-After: 60` | no |
| `FOUND` | HTTP 400 `file_infected`, "This file was blocked by the virus scanner." | no |
| File larger than clamd takes, or `Heuristics.Limits.Exceeded.*` | HTTP 400 `file_too_large_to_scan` | no |

A blocked upload writes the security event `reports.upload_blocked_by_antivirus`
(user, task, file name, size, SHA-256, signature, signature version; never the
content) and a `ReportQuarantineRecord`. Staff see those records under Admin →
Weekly reports → Quarantined / blocked files. The record holds metadata only:
the bytes of a blocked upload are deleted.

The site does not go down when clamd is down. `/health/ready` reports clamd as
a soft warning (`upstreams.clamd.probe`, `warnings.clamd`). Only uploads fail.

## Downloads

* Only rows with `scan_status == "clean"` can be downloaded or previewed
  (`require_clean_scan`). Files stored before scanning existed
  (`unscanned`) get 409 `file_not_scanned` until a re-scan clears them.
  Infected files get 409 `file_infected`. The grader zip export leaves them
  out and lists them in `manifest.csv`.
* Files are served with `FileResponse` from the private root, with
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, no-store` and a `sandbox` CSP.
* Inline preview is offered only for PDF and PNG/JPEG/WebP:
  * Images get a `sandbox` CSP.
  * PDFs get a script-free CSP (`default-src 'none'`) without `sandbox`,
    because Chromium refuses to render PDFs in sandboxed documents.
* SVG is always a download (`application/octet-stream`).
* `PrivateReportStorage.url()` raises, so no template, serializer or admin
  widget can link to a file directly. No nginx `root`/`alias` points at the
  storage (`infra/hostinger/tests/test-report-storage-config.sh`).

## Nothing is executed or rendered on the server

No LibreOffice, ImageMagick, PDF rasterising, Office thumbnailing or unzip to
disk. The validators only read bytes. Report images are checked with Pillow's
`verify()`, which inspects the header and checksums without decoding pixels.
Markdown and canvas previews are rendered in the browser by React
(`features/reports/markdown.jsx`, no HTML injection, http(s)/mailto links only,
no remote images). `tests/test_reports_antivirus.py::NoServerSideRenderingTests`
fails if conversion or extraction code appears.

## Storage on the VPS

| Host directory | In containers | Mode | Mounted |
|---|---|---|---|
| `/srv/streamx/reports` | `/app/private_media` (`REPORTS_PRIVATE_ROOT`) | root 0750 | `bind,noexec,nosuid,nodev` |
| `/srv/streamx/reports-quarantine` | `/app/private_quarantine` (`REPORTS_QUARANTINE_ROOT`) | root 0700 | `bind,noexec,nosuid,nodev` |

* Each directory is its own self bind mount with those flags, persisted in
  `/etc/fstab`. Docker bind mounts inherit the flags, so nothing on them can be
  executed inside a container. `infra/hostinger/prepare-report-storage.sh
  prepare` sets this up idempotently before every deploy.
* Compose bind-mounts both directories with `create_host_path: false`, and only
  into the backend, the pool replicas and the async workers. Media, nginx,
  frontend and clamav never mount them.
* `manage.py check_report_storage --require-noexec` verifies the mount flags
  (post-deploy smoke and readiness verification).
* The flags are not applied with a volume `driver_opts: o: bind,noexec`. The
  kernel ignores flags passed with the first bind, and Docker's local driver
  only remounts for `ro`. The host mount is what makes them stick.

### Migration from the old named volume

The release before this one may have stored files in the named volume
`streamx_backend_private_media`. That volume is no longer referenced, never
redefined, and never deleted automatically.

1. `prepare` copies its files into the new directory (pass 1, each copy checked
   by SHA-256) while the old containers keep running.
2. After `compose up` has recreated every container, `finalize` checks that no
   container still mounts the volume.
3. `finalize` then copies the late files (pass 2) and verifies every file of
   the volume against its copy by SHA-256.
4. Finally it records `/srv/streamx/reports/.migration/legacy-volume.done`.

If the volume never existed, `finalize` only records that. Remove the old
volume by hand once downloads are confirmed:
`docker volume rm streamx_backend_private_media`.

Legacy files keep the old `<hex>.<ext>` names until the first re-scan finds
them clean. The re-scan then renames them to `<hex>.bin`.

## Re-scans with fresh signatures (`rescan.py`)

* `manage.py rescan_report_files` (`--all`, `--limit N`) re-scans stored files.
  The async worker runs the same re-scan every `REPORTS_RESCAN_INTERVAL_HOURS`
  (24): a periodic hook publishes one deduplicated outbox event, and its handler
  scans in batches of `REPORTS_RESCAN_BATCH_SIZE` and queues continuations.
* A stored file found infected later is quarantined, not deleted:
  1. Every row pointing at it is marked `infected`, so downloads stop at once.
  2. The file is moved to `/srv/streamx/reports-quarantine/<kind>/<hex>.bin`
     with mode 000.
  3. A `ReportQuarantineRecord` (`source=rescan`) and the security event
     `reports.stored_file_quarantined` are written.
  4. Staff get a notification.

  Keeping the file lets an admin confirm a false positive or hand the sample to
  an investigation. Deleting it is a deliberate manual step.
* If clamd is down, nothing is marked. The outbox retries with backoff.

## ClamAV service

* `clamav/clamav:1.4.3`, service `clamav` in `docker-compose.hostinger.yml`.
* No published ports. It is reachable only on the internal `avnet` network
  (backend and workers). `av_egress` is used only for freshclam downloads.
* Signatures live in the `streamx_clamav_db` volume. freshclam checks 12 times
  a day.
* The configs are `infra/hostinger/clamav/clamd.conf` and `freshclam.conf`:
  * `StreamMaxLength 220M`, above the backend's 210 MiB stream cap, which is
    above the 200 MB file cap. reports.E002 enforces the backend side.
  * Archive scanning on, with `AlertEncrypted`, `AlertOLE2Macros` and
    `AlertExceedsMax`.
  * Limits cover a 2000-entry, 500 MB vault and 20000-entry Office files.
* Memory: `mem_limit 3g` (`CLAMAV_MEM_LIMIT`). One signature engine uses about
  1.3 GB with the full database. `ConcurrentDatabaseReload no` and
  `TestDatabases no` keep a reload from needing a second engine. During a
  reload, scans wait a few seconds.
* First boot: the image ships a signature snapshot that Docker copies into the
  empty volume. freshclam then updates it and clamd loads it, which takes 1–3
  minutes, or up to about 10 minutes when a full download is needed.
  The healthcheck `start_period` is 15 minutes.
  `post-deploy-smoke.sh` waits up to `SMOKE_ANTIVIRUS_WAIT_SECONDS` (600 s)
  with `manage.py check_antivirus --wait-seconds`.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `REPORTS_ANTIVIRUS_SCANNER` | `clamd` in production, `fake` elsewhere | `clamd`, `fake` (EICAR / `STREAMX-TEST-VIRUS` markers), `off`, or a dotted scanner class. reports.E001 refuses production without `clamd`. |
| `CLAMD_HOST` / `CLAMD_PORT` | `clamav` / `3310` | `REPORTS_CLAMD_HOST`/`_PORT` are still read as fallbacks. |
| `CLAMD_CONNECT_TIMEOUT_SECONDS` / `CLAMD_TIMEOUT_SECONDS` | 5 / 120 | clamd `MaxScanTime` is 100 s, so a verdict arrives first. |
| `CLAMD_STREAM_MAX_BYTES` | 210 MiB | Must cover `REPORTS_MAX_FILE_SIZE_MB_CAP` (reports.E002). |
| `REPORTS_QUARANTINE_ROOT` | `<BASE_DIR>/private_quarantine` | Must not overlap `MEDIA_ROOT` (reports.E003). |
| `REPORTS_RESCAN_INTERVAL_HOURS` / `REPORTS_RESCAN_BATCH_SIZE` | 24 / 200 | |

## Input firewall

`config/security.py` blocks SQL- and script-looking text in every API field,
except the explicit list in `FIREWALL_EXEMPTIONS`. An exemption applies only
when the URL name, path shape, method, JSON/form field and maximum length all
match:

* `reports-manage-tasks` (POST) and `reports-manage-task-detail` (PATCH):
  * `title` (200)
  * `brief` (20000)
  * `criteria[n].name` (120)
  * `criteria[n].description` (2000)
* `reports-manage-submission-grade` (POST): `feedback` (10000). It is stored as
  `feedback`, or as `revision_feedback` when the report is returned.
* `reports-task-submit` (POST): `note` (2000).
* `lecture-comments` (POST) and `lecture-comment-detail` (PATCH): `body` (2000).

These values are stored through the ORM and shown as text:

* Report text goes through the safe Markdown renderer.
* Comment HTML is stripped on the server, and the model-level active-content
  check still applies.

Every other field, query string and endpoint keeps the full block.
