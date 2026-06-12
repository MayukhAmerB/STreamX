# AL SYED Cases

Standalone cases site for `cases.alsyedinitiative.com`.

## Routes

- Public site: `/`
- Case Control: `/case-control/`
- Legacy `/admin` requests redirect to `/case-control/`.

## Case Control Auth

Case Control uses browser Basic Auth from environment variables:

- `CASE_CONTROL_USERNAME`
- `CASE_CONTROL_PASSWORD`

If the same credentials as the normal admin panel are required, set these two
environment variables to the same username and password on the server. The
cases service stays standalone and does not read the main Django database.

If `CASE_CONTROL_PASSWORD` is empty, Case Control is intentionally disabled.

## Persistence

The Docker compose stack mounts:

- `streamx_cases_content` at `/app/content/cases`
- `streamx_cases_uploads` at `/app/public/uploads`

Do not run `docker compose down -v` in production, because that deletes these
persistent case/article volumes.

## Content Model

Each case is stored as one JSON file in `content/cases`. The public site reads
the generated `public/cases-index.json`.

Case Control updates the JSON files, stores uploaded cover images under
`public/uploads`, and rebuilds `cases-index.json` automatically after every
create, update, or delete.
