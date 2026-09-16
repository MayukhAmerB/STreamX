# Course platform V2: implementation and admin guide

## Sources and decisions

- V2 developer requirements: course selection, detailed curriculum, genuine reviews, confirmed enrollment counts and separate Pentesting applications.
- OSINT Batch IV screenshot: three-month course, limited seats, live classes, live chat, lifetime recordings, three Q&A sessions and completion certificate.
- `6-Month-Web-and-API-Pentesting-Course (2).pdf`: six phases, 24 weeks, 48 classes, approximately 100?120 hours, six projects, Al Mikael, January 1, 2027 start, and three payment plans.
- The requirements PDF prohibits decorative cybersecurity imagery, fake interfaces and hooded-hacker visuals. The default card and hero layouts are information-led; an administrator can opt into an uploaded, directly relevant course-context image when appropriate. All labels, facts and fees remain HTML/database content.
- The latest user instruction leaves OSINT pricing to admin. The screenshot's prices are deliberately not used.

## Stages completed

| Stage | Result |
| --- | --- |
| Preserve data | Local SQLite backup; forward migrations; row-level comparison against backup |
| Data and admin | Editable card title, subtitle, summary, bullet list, image, facts, curriculum and prices |
| Source content | Separate OSINT Batch IV and six-month Web/API Pentesting program records |
| Student workflows | Verified reviews, moderation, enrollment counts, application review step, private checkout reference, student dashboard |
| Payments | One-time, monthly and three-month bundle plans; server-controlled amounts and installment counts; order terms snapshots; retry-safe provisioning |
| Visuals | Two equal information-led cards; facts placed in the course header; optional admin-controlled course-context imagery; responsive pages; sticky desktop enrollment panel |
| Verification | API/admin/payment tests, frontend tests, build, desktop/mobile browser checks and data preservation audit |

## Local data state

- Created and published OSINT program **#18**, slug `osint-professional-training-batch-iv`.
- Created and published Pentesting program **#19**, slug `web-api-pentesting-six-month-2027`.
- All **271 original rows across 46 application tables** were verified unchanged after migrations and import. SQLite integrity passed.
- Existing course IDs, student accounts, enrollments, lessons and payments remain in place. Previous students retain their original course associations; no automatic transfer to a new batch was performed.
- Backup: `.hostinger-backups/course-v2-2026-09-16/before-course-v2.sqlite3` (ignored by Git).
- The source import never overwrites an existing record with the same slug. Re-running it also preserves admin edits.

## Admin controls

Open **Django admin ? Courses ? select the course**.

| Section | Controls |
| --- | --- |
| Homepage card | Card title, subtitle, summary, one bullet per line, image alt text and the optional image display toggle |
| Course facts | Flagship selection, batch, duration, schedule, class length, class count, hours and seat count |
| Batch and extended facts | Start date, descriptive hours range, descriptive seat availability |
| Pricing | One-time price, monthly price, enabled flags, number of monthly payments and access days |
| Three-month bundle pricing | Enabled flag, per-installment price, installment count and access days |
| Media | Optional thumbnail upload or public image URL. It is shown on the card and hero only when `Show course image` is enabled and the image directly explains the program. |
| Course content | Overview, learning capabilities, outcomes, benefits and enrollment message |
| Modules | Ordered module title, description, public topics and lesson records |

### OSINT pricing

The new OSINT program starts with prices unset (zero) and both plans disabled. Set **Price** for one-time enrollment and/or **Monthly price**, choose the corresponding enabled flags, and save. A positive price is required before checkout becomes available. The global payment configuration must also be enabled and configured. Existing OSINT courses and their prices were not changed.

### Initial Pentesting pricing

| Plan | Price | Payments | Total |
| --- | --- | --- | --- |
| Monthly | INR 4,299 | 6 | INR 25,794 |
| Three-month bundle | INR 10,999 | 2 | INR 21,998 |
| One-time | INR 18,999 | 1 | INR 18,999 |

These are initial database values from the PDF, not frontend constants. The checkout calculates totals from the current API response; the backend calculates order amounts independently. Existing orders retain their recorded amount and terms. Installment access does not expire before a future batch begins. Repeated provisioning of a successful payment does not add access days again or downgrade permanent access.

The provided material does not specify exact OSINT schedule, class length, class count or hour count, or an exact Pentesting class length/seat count. These fields remain unset and display `To be announced` until entered by admin.

## Course identity, statistics and privacy

- One flagship per category; the public selector prefers the published flagship.
- Count paid enrollments for the displayed course record across its history. Pending/failed records are excluded. No invented counts or reviews.
- Reviews require an authenticated confirmed student, one review per account/course. New reviews are pending. Admin can approve, hide or delete; permitting an edit allows one revision and returns it to moderation.
- Public author label: `Verified student`; no account ID, phone or email is returned with reviews.
- Applications are separate from enrollments. The private random reference permits checkout for the matching course/email. Signed-in applicants must use the same account.
- Admin can inspect application and payment status. Verified payment provisions access through the existing student-account flow.

## Safe setup on another environment

Back up that environment's database and media first. Then run in PowerShell from the repository root:

```powershell
.venv\Scripts\python.exe backend/manage.py migrate --noinput
.venv\Scripts\python.exe backend/manage.py setup_course_experience --publish
npm.cmd --prefix frontend run build
```

On a server use its Python executable/environment. Omitting `--publish` creates unpublished drafts. The command creates only missing program slugs, never overwrites an existing program and never edits old enrollments or prices. If a different flagship already exists, the new record is created without replacing that flag; select the desired flagship deliberately in admin.

Existing thumbnail records and uploaded media are preserved. New program records do not receive decorative fallback artwork. Upload a course-context image in admin and enable `Show course image` only when it is genuinely useful to the student.

## Validation evidence

- 56 existing/course-experience backend tests passed, plus 4 new source-catalog/admin/bundle preservation tests (60 distinct backend tests in this update).
- 58 frontend tests passed; TypeScript and production build passed. ESLint: 0 errors; 22 pre-existing warnings. Existing Browserslist-age and large-chunk build warnings remain.
- Django system check and migration drift check passed; payment order service mypy check passed.
- Headless Chromium verified desktop 1440px and mobile 390px, image loading, two cards, expandable modules, confirmed counts, no horizontal overflow, price-free course pages, registration gating, conditional institution fields, review-before-submit, all three plans and their totals. No browser JavaScript errors.
- Browser submission tests used a separate QA database; no test applicant was inserted into the working database.
- `infra/verify_sqlite_preservation.py` verified every original application row against the backup after the local import.

## Release boundary

Local implementation, migrations and course creation are complete. Production deployment is a separate operator step; no real payment was charged. Deployment credentials, webhook delivery and live-host verification remain environment-specific release checks.

### Hostinger production release

Use the targeted `infra/hostinger/deploy-course-v2.sh` script from the server checkout at `/opt/alsyed/StreamX`. It requires an explicit, full `RELEASE_COMMIT` value and refuses to run if the checked-out commit differs. Record the currently deployed commit before updating, then fast-forward to the approved release commit. Do not run a fresh-install/reset script.

The release script checks migrations, backs up PostgreSQL and the media/recording volumes, verifies the backup, rebuilds services and checks readiness. Set `HOSTINGER_BACKUP_RETENTION_COUNT=0` and `HOSTINGER_BACKUP_RETENTION_DAYS=0` for this release to retain older backups as well. Run outside a live class and allow enough free disk space for the video archives and image builds.

Run the deployment only outside a live class:

```bash
RELEASE_COMMIT="<full-approved-sha>" ./infra/hostinger/deploy-course-v2.sh
```

The script creates a PostgreSQL and media recovery point, verifies it, applies only forward migrations, updates the existing pooled services, and creates only missing program slugs. It never overwrites matching courses or admin edits. Existing thumbnails remain stored but are not presented unless an administrator enables their display toggle. Set OSINT pricing in admin, and check an existing student's video playback, login, the new cards and registration before considering the release verified.

### Explicit unbacked release

The default release creates and verifies PostgreSQL, media, recording and Owncast recovery archives. Only when an operator explicitly accepts the loss of that recovery point may they set `ALLOW_UNBACKED_RELEASE=1`. This bypasses Alpine and all archive work but keeps the release guards, migrations, rolling service updates and health checks. It is not the recommended production path.
