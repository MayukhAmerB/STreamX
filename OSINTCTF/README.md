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
  (default `https://api.alsyedinitiative.com/api`, the host that holds the LMS
  session cookies) and `{siteUrl}` from `LABS_SITE_URL` (default: that origin
  without `api.`; used for the sign-in link); the CSP `connect-src` allows
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

The page is a dark investigation dashboard in the main site's language (black
canvas, Geist, golden-white accent; no colour for status; one column under
960px, safe-area insets, no horizontal scroll down to 320px). Fonts are self-hosted from the
frontend's Fontsource packages (SIL OFL) and served by `server.js` under
`/fonts/` (woff2 only); the CSP allows fonts and styles from this origin only.
After a font package upgrade, refresh them with:

```bash
node OSINTCTF/scripts/copy-fonts.mjs   # needs `npm ci` in frontend/
```

## Sections and access

Top-level navigation: **Free CTFs** (`#hub`) | **Paid Labs** (`#paid`) |
**Examination** (`#exam`, exam.js) | **Leaderboard** (`#leaderboard`). The
labs open from those pages: `#realworld` (The Zenith Footprint),
`#blackmeridian`, `#certification`, with a lab switcher under the header.
Deep links work on load, on `hashchange` and with the back button; clicking a
tab updates the address with `replaceState`.

The free/paid split is the labs' own difficulty map (`labs-access.js`
`QUESTION_DIFFICULTY`): **easy and medium = Free** (Zenith cases 1-6, plus the
curated community CTFs from the LMS directory `/api/ctf/labs/directory/`, or
`free-directory.json` when that is empty); **expert and professional = Paid**
(Zenith 7-10, Black Meridian, Certification CTF).

| Who | Free CTFs | Paid labs | Examination |
|---|---|---|---|
| Signed out | locked (sign in) | locked | sign-in banner (exam.js) |
| Enrolled student with active course access (Batch 2 / Batch 3): `/api/ctf/eligibility/` reason `ok` or `not_assigned`; pass claim `exm` | open | locked | open (LMS assigns exams per batch) |
| Starter (`ctf_starter`, billing `easy_ctfs` / `free_ctfs`) | open | locked | per LMS |
| CTF Labs member (`ctf_labs`, billing `all_labs`) and staff (`/api/ctf/labs/entitlement/`) | open | open | per LMS |

The page reads these from the LMS with the student's session and shows the
handle, monthly-CTF rank and XP (`/api/ctf/seasons/me/`, the current season,
directory XP) in the header. Server-side enforcement is the labs pass: with
the LMS switch `labs_membership_required` on, `/api/validate` and
`/materials/` accept easy/medium for a pass with `exm` (enrolled students) or
Starter difficulties, and expert/professional only for members. With the
switch off (today) the server accepts every answer and the locks are display
only. Signed-in visitors get a pass automatically (`POST /api/ctf/labs/pass/`
then `POST /api/session`) when `LABS_PASS_SECRET` is configured on both sides.
`GET /api/access` reports `{membershipRequired, allowedDifficulties, pass, passExpiresAt}`.

Adding a lab: a rail button and a tab section in `index.html`, its cases in
`app.js` (question set, `DIFFICULTY`, `CASE_TITLES`, `LAB_TABS`/`PARENT`),
its answer hashes in `server.js` and its difficulty in `labs-access.js`.

Local preview against a mock LMS: run any stub that answers the endpoints
above on `127.0.0.1:8000`, then
`LABS_LMS_API_BASE=http://127.0.0.1:8000/api PORT=8092 node server.js`.

Tests: `node --test OSINTCTF/tests/*.test.js`.
