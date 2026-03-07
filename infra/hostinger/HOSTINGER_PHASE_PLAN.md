# Hostinger Phase Plan

## Current architecture

- Frontend: React/Vite served by nginx on `127.0.0.1:3000`
- Backend: Django/Gunicorn on `127.0.0.1:8000`
- Database: PostgreSQL in Docker
- Cache/session layer: Redis in Docker
- Realtime: LiveKit server plus LiveKit egress in Docker
- Broadcast delivery: Owncast in Docker
- Media storage: local Docker volume mounted at `/app/media`
- Recording storage: local Docker volume mounted at `/recordings`
- Public routing: host nginx proxies `alsyedinitiative.com`, `api.*`, `livekit.*`, `stream.*`

## Phase 1

Status: completed in this pass

- Removed the GCS-backed production media path from Django settings.
- Removed cloud-only media storage packages from backend requirements.
- Switched Hostinger production to first-class local media storage served through `/media/`.
- Added missing media nginx config and fixed `/media/` proxying.
- Corrected the Hostinger nginx config to target host loopback ports instead of Docker-internal names.
- Raised upload limits for large course videos and fallback recordings.
- Installed `ffmpeg` in the backend image for local HLS transcoding support.
- Added instructor-side direct uploads for course thumbnails and lecture videos.
- Locked Docker persistence to fixed volume names so rebuilds do not create fresh empty volumes.
- Added backup, restore, and safe-deploy scripts for Hostinger operations.

## Phase 2

Status: recommended next

- Run `python manage.py transcode_lecture_streams --all-uploaded` on a schedule so uploaded lectures become HLS assets automatically.
- Add retention and cleanup jobs for stale recordings and superseded transcoded artifacts.
- Add admin visibility for lecture source type, transcode status, and storage footprint.
- Move large upload and transcode operations to dedicated workers if authoring volume grows.

## Phase 3

Status: required before high concurrency claims become realistic

- Split LiveKit, Owncast, and Django onto separate VPS instances or separate Hostinger compute tiers.
- Move PostgreSQL and Redis off the app node if write volume or connection count increases.
- Put course media and HLS assets behind object storage plus CDN inside the chosen hosting stack if VOD demand grows beyond a single disk/node.
- Introduce background job orchestration for transcoding, recording post-processing, and notification workflows.

## Scalability notes

- Meetings up to a few hundred interactive participants are aligned with the current LiveKit-based design, provided the VPS has enough CPU, bandwidth, and open UDP ports.
- Broadcast and VOD traffic are the first places a single-node Hostinger deployment will saturate.
- The current code is now Hostinger-safe for local media and recordings, but a single VPS should not be treated as a true 50,000-viewer architecture.
