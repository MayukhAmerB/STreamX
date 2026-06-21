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
