# AL SYED OSINT CTF Labs

Standalone bilingual student-facing OSINT CTF application for:

- `https://labs.alsyedinitiative.com/`

The browser contains challenge prompts, language switching, scoring UI, and
local progress. Answers are validated by `server.js`; raw answers are not
included in browser-delivered JavaScript.

## Local run

```bash
docker build -t alsyed-osint-labs .
docker run --rm -p 8092:8080 alsyed-osint-labs
```

Open `http://127.0.0.1:8092/`.

## Security boundary

- `solutions_guide.md` is instructor material and is excluded from Git and Docker.
- `realworld_lab_setup/` is repository-seeding material and is excluded from Git and Docker.
- Only the dashboard, images, and student materials are copied into the image.
- Validation requests are rate-limited and answers are compared server-side.
- CSP, MIME sniffing protection, path allowlisting, and cross-origin isolation headers are enabled.

## Production

The root `docker-compose.hostinger.yml` exposes this service only on
`127.0.0.1:8092`. Host Nginx publishes it through
`infra/hostinger/nginx/labs-subdomain.conf`.

## Examination tab (graded, recorded)

The `05 EXAMINATION` tab (`exam.js`) is different from the practice labs:

- It calls the LMS API (`/api/ctf/`) from the browser with the student's LMS
  session (`credentials: "include"`). The LMS checks every answer and stores
  every attempt, right or wrong, in Postgres; scores are in Django admin under
  "OSINT CTF examinations".
- `GET /api/config` returns `{lmsApiBase}` from `LABS_LMS_API_BASE`
  (default `https://alsyedinitiative.com/api`); the CSP `connect-src` allows
  that origin only.
- Nothing about the exam is stored in the browser, and no answer or hash is in
  any file served here.
- Exam content lives in `private/exams/<slug>.json` (git- and Docker-ignored)
  and is loaded into the LMS with
  `python manage.py load_ctf_exam --file - < OSINTCTF/private/exams/<slug>.json`.
  Evidence files go in `materials/exams/<slug>-<32 random hex>/`.
- `/materials/` never serves `.html`, `.svg`, `.js` or `.xml` files.

Local end-to-end run: start the backend on `127.0.0.1:8000`, then

```bash
LABS_LMS_API_BASE=http://127.0.0.1:8000/api PORT=8092 node server.js
```

Server tests: `node --test OSINTCTF/tests/server.test.js` (not shipped in the image).

## Design, fonts and deep links

The page follows the main site's design language (black canvas, Geist,
golden-white accent; no colour for status). Fonts are self-hosted from the
frontend's Fontsource packages (SIL OFL) and served by `server.js` under
`/fonts/` (woff2 only); the CSP allows fonts and styles from this origin only.
After a font package upgrade, refresh them with:

```bash
node OSINTCTF/scripts/copy-fonts.mjs   # needs `npm ci` in frontend/
```

Tabs have deep links: `#hub`, `#realworld`, `#blackmeridian`, `#certification`
(app.js) and `#exam` (exam.js). They work on load, on `hashchange` and with
the back button; clicking a tab updates the address with `replaceState`.
Tabs 01-04 show an access chip ("Open"; "Members" when `GET /api/config`
returns `membershipRequired: true`); tab 05 shows "Sign-in".

Tests: `node --test OSINTCTF/tests/*.test.js`.
