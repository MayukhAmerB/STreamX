# End-to-end journeys

Playwright journeys that drive the whole product on one machine: Django on a
dedicated SQLite file, the production frontend build (`vite preview`), the
OSINTCTF labs server, and local stand-ins for every external service.
Nothing outside `localhost` is contacted.

```
cd e2e
npm install            # @playwright/test 1.63.0 (uses the Chromium 1243 build already in %LOCALAPPDATA%\ms-playwright)
node run.mjs           # start the stack, run every journey (desktop 1440 + mobile 390), write reports, tear down
node run.mjs --project=desktop tests/live-class.spec.mjs   # extra args go to `playwright test`
node stack.mjs         # only start the stack (Ctrl+C stops it); stack.json in the run folder has the control token
```

Results go to `<scratch>/e2e-results/<run>/`:
`html-report/index.html`, `results.json`, `summary.json` (pass/fail per
journey and project, bugs, teardown check), `artifacts/` (failure screenshots
and traces), `logs/` (django, web, labs, stubs, build). Set `E2E_SCRATCH_DIR`
to change `<scratch>`; `E2E_REBUILD=1` forces a fresh migration template and
frontend build (both are cached by content hash).

## The stack

| Piece | Where | What it stands in for |
|---|---|---|
| Django | `backend/`, `DJANGO_SETTINGS_MODULE=config.settings.e2e`, `E2E=1` | the backend (no worker process: the journeys run jobs and periodic hooks on demand) |
| gateway | `stubs/gateway.mjs` | nginx: `/media/` allowlist, internal `/_protected_media/`, `X-Accel-Redirect` |
| web | `vite preview` of `frontend/` with `vite.preview.config.mjs` | the frontend container |
| labs | `OSINTCTF/server.js` on :8092 | labs.alsyedinitiative.com |
| Owncast | `stubs/owncast.mjs` | `/api/status`, fixture HLS, embed pages, admin API |
| LiveKit | `stubs/livekit.mjs` | Twirp egress and room APIs (an active egress puts the Owncast stub online) |
| clamd | `stubs/clamd.mjs` | ClamAV INSTREAM over TCP; `E2E-INFECTED` or EICAR means infected |
| YouTube | `fixtures/youtube-feed.xml` | the channel feed (parsed by the real parser) |
| ffmpeg | `backend/apps/e2e_support/fakes.py` | capture/concat/ffprobe of the stream recorder (no binary runs) |

`backend/apps/e2e_support` (installed only by the E2E settings) holds the
`seed_e2e` command, the test clock (`django.utils.timezone.now` frozen or
shifted on demand), the fakes and the control API `/api/__e2e__/`
(`reset`, `clock`, `tick`, `fixture/<name>`, session state), which needs the
per-run `X-E2E-Token`. `config.settings.e2e` refuses to load without `E2E=1`
or with `APP_ENV=production`; `config/urls.py` and the production apps are not
changed.

Determinism: one worker, a fresh seed per journey, a server clock set by the
journey (and `page.clock` in the browser), background work run by explicit
`tick` calls, and waits on responses or UI state instead of sleeps.

## Quality specs (UI overhaul, WS-I)

| Spec | What it checks |
|---|---|
| `tests/visual.spec.mjs` | every page in `tests/visual/pages.mjs` (plan Appendix A.4) at 1440x900 and 390x844: viewport screenshots, reduced motion, frozen clocks, fresh seed, `maxDiffPixelRatio 0.01`; on every page also ≤1 champagne-filled element in the viewport, no sideways scroll, Console/back-office radii 0 or pill |
| `tests/motion.spec.mjs` | `/`, `/console`, `/console/admin`, `/admin/`: no layout/paint-property motion, bounded loops, reduced motion still, one champagne action per viewport, radii 0/pill, IBM Plex Sans |
| `tests/a11y.spec.mjs` | every listed page: axe-core 0 serious/critical, 24 px targets (WCAG 2.5.8), no sideways scroll |

Baselines live in `tests/visual/baselines/<project>/<page>.png` and are accepted
only after design review: `node run.mjs tests/visual.spec.mjs --update-snapshots`.
A page without a baseline runs only the language checks (annotated `no-baseline`); a page still showing a WS-0 placeholder is skipped. Live media and embeds are masked in `#262626`.
`E2E_SHOTS_DIR=<dir>` makes the visual spec also write review copies
`<page>-<width>.png`. Fixtures for these pages: `features`, `attention`,
`admin-queues` (`backend/apps/e2e_support/ui_fixtures.py`).
