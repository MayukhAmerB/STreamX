# Class recording runbook (OBS live classes -> module lectures)

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| Session tagging (`target_module`) | backends | Admin form or `PATCH /api/realtime/sessions/<id>/` |
| Start/stop hooks | backends | `stream/start` (OBS) creates a `ClassRecording` in `recording`; `stream/stop` and `end` move it to `finalizing`. Hook failures are logged and never fail the request. |
| Capture, finalize, publish | `stream-recorder` service (`manage.py run_stream_recorder`) | Defined in `infra/hostinger/docker-compose.hostinger.async-workers.yml`. Run exactly one (a Redis leader key also guards this). |
| HLS transcode | existing `transcoder` service | Picks up the new lecture (`stream_status=uploaded`) like any upload. |

Capture is `ffmpeg -c copy` of Owncast's HLS output (`http://owncast:8080/hls/stream.m3u8`
inside `streamx_appnet`) into MPEG-TS parts under `/recordings/class-recordings/class-recording-<id>/`.
ffmpeg reads Owncast through the recorder's own playlist filter (a small proxy on 127.0.0.1 inside
the `stream-recorder` container, `apps/realtime/recording/hls_proxy.py`):

- When OBS disconnects, Owncast appends its "offline" clip to the live playlist
  (`#EXT-X-DISCONTINUITY`, `offline-v2.ts`, `#EXT-X-ENDLIST`). The filter cuts that tail and ends the
  playlist, so the offline clip is never downloaded and never ends up in a recording; ffmpeg finishes
  the live segments and closes the part at once.
- It keeps only the best variant of the master playlist (largest resolution, then bitrate), so video
  and audio come from the same rendition.
- If ffmpeg has to be restarted inside one OBS connection, the next part starts exactly after the
  last segment already captured (no repeated and no missing seconds). A new OBS connection (new
  `lastConnectTime`) starts fresh; a stale ended playlist served right after a reconnect is ignored.
- `STREAM_RECORDER_HLS_FILTER=0` turns it off (ffmpeg then reads Owncast directly and the offline clip
  can be recorded again); if the filter cannot start, the recorder logs
  `CLASS_RECORDING_HLS_FILTER_UNAVAILABLE` and captures directly rather than not at all.

Each OBS connection becomes a new part (the filter ends the part when OBS disconnects; without an
offline tail ffmpeg exits ~30-60 s after the playlist stops growing, and a changed Owncast
`lastConnectTime` cuts a new part). On stop the parts are concatenated
(copy, `+faststart`) straight into `/app/media/lecture_videos/<course>/module_<id>/`, an
unpublished lecture is created at the end of the tagged module (title "<class title> - DD Mon YYYY",
description = module description), the transcoder builds HLS, and the recorder publishes the lecture
when HLS is ready. The recorder is only an HLS viewer of Owncast: if it fails, the live class is not
affected.

Host Studio (browser) sessions: when an egress recording is stopped (`recordings/stop/`), the same
finalize/publish path runs on the LiveKit output file in `/recordings` (the original egress file is
left in place). If the session has no target module yet, the class recording is created `failed`
with "No module selected for this class - choose a module and retry": set the module (admin or
`PATCH /api/realtime/sessions/<id>/`) and retry it.

Finalizing (concat, OBS remux) runs on the recorder's own finalize thread with a bounded queue, so a
long concat never delays the next class's capture; the Redis leader key is renewed by a separate
thread every 10 s. Students are notified about a recorded class once, when its lecture is published
(HLS ready); replacing a published lecture's video with the OBS file does not notify again.

## Enable (one time)

1. Add to `backend/.env.hostinger.production`:
   ```
   STREAM_RECORDER_ENABLED=1
   # optional overrides (defaults shown)
   # STREAM_RECORDER_SOURCE_URL=http://owncast:8080/hls/stream.m3u8
   # STREAM_RECORDER_WORK_DIR=/recordings/class-recordings
   # STREAM_RECORDER_MAX_BYTES=32212254720          # 30 GiB per class, capture pauses beyond it
   # STREAM_RECORDER_MIN_FREE_BYTES=5368709120      # capture pauses below 5 GiB free
   # STREAM_RECORDER_MAX_DURATION_SECONDS=21600     # auto-finalize after 6 h
   # STREAM_RECORDER_FINALIZE_SPACE_FACTOR=2.0      # finalize/remux needs input x 2 + MIN_FREE free on media
   # STREAM_RECORDER_FAILED_RETENTION_DAYS=7        # parts/uploads of failed recordings kept this long
   # STREAM_RECORDER_SWEEP_INTERVAL_SECONDS=3600    # how often the recorder sweeps stale files
   # STREAM_RECORDER_FINALIZE_QUEUE_SIZE=32         # finalize thread queue (extra rows wait a tick)
   # STREAM_RECORDER_HLS_FILTER=1                   # playlist filter (keeps Owncast's offline clip out)
   # FFMPEG_BINARY=ffmpeg  FFPROBE_BINARY=ffprobe    # binaries used by the recorder and the checks
   # REALTIME_BROADCAST_REQUIRE_TARGET_MODULE=1     # once the UI sends target_module_id
   ```
2. Apply migrations as usual (`courses 0035`, `realtime 0025`, `realtime 0026`; additive,
   nullable/defaulted columns and new choices only -- no data migration).
3. Build and start the recorder with the same compose file set the stack already uses, e.g.
   ```
   docker compose -p streamx --env-file backend/.env.hostinger.production \
     -f docker-compose.hostinger.yml \
     -f infra/hostinger/docker-compose.hostinger.async-workers.yml \
     <other overlays in use> \
     up -d --build --no-deps stream-recorder
   ```
   then recreate the backends so they read `STREAM_RECORDER_ENABLED`.
   `deploy-course-v2.sh` does not rebuild `stream-recorder`; after each release run the command
   above (or add `stream-recorder` to that script's service list) so it runs the released code.
4. Verify: `docker logs streamx-stream-recorder-1` shows "Stream recorder started"; during a class
   Admin > Realtime > Class recordings shows `recording` with a growing part count and a fresh
   heartbeat ("offline since ..." means the recorder is down).
5. Prove the whole pipeline with the server's real ffmpeg (see "Verify the pipeline" below):
   `docker exec streamx-stream-recorder-1 python manage.py verify_recording_pipeline`.
6. Once after this release: list the recordings that are already on the server (see "Recordings made
   before this pipeline" below).

Resources: `cpus 0.5`, `mem 768m` by default (`STREAM_RECORDER_CPUS`, `STREAM_RECORDER_MEM_LIMIT`).
ffmpeg runs under `nice 10`.

## Quality and the OBS upload replacement

The server recording has the quality of the Owncast rendition it pulls. The playlist filter keeps the
highest-resolution (then highest-bitrate) rendition of the master playlist; enable video passthrough
on Owncast's top variant to record OBS's own encode, or point `STREAM_RECORDER_SOURCE_URL` at a
specific variant playlist.

For the best quality the instructor uploads the file OBS saved locally:
- API: `POST /api/realtime/class-recordings/<id>/obs-upload/` or
  `POST /api/realtime/sessions/<id>/class-recordings/obs-upload/` (multipart `video_file`).
- Admin: Class recordings > "Replace with OBS recording".

The same lecture row is kept (id, likes, comments, views, progress); its file is swapped, the old
HLS manifest is dropped and the transcoder re-encodes. Accepted: MP4/MOV/M4V/WEBM (swapped in at
once) and OBS's default MKV, or FLV/TS. MKV/FLV/TS are staged under
`/app/media/class-recording-uploads/` and a `finalizing` OBS-upload recording is queued; the
`stream-recorder` service remuxes the file to a faststart MP4 (`ffmpeg -c copy`, no re-encode, never
on a web worker) and only then swaps it into the lecture. A remux failure leaves the old video in
place and the recording `failed` with the ffmpeg error; retry it, or remux in OBS (File > Remux
Recordings) and upload the MP4. The `stream-recorder` service must be running for MKV uploads to
complete. Max `MAX_VIDEO_UPLOAD_BYTES` (5 GiB, matching nginx `client_max_body_size 5120m`). nginx streams the
body to gunicorn (`proxy_request_buffering off`, 3600 s timeouts) and Django spools it to a temp
file, then copies it into media: keep 2x the file size free on the container disk and the
`backend_media` volume. Files above 5 GiB need a chunked/resumable uploader, which this release does
not add.

## Disk use

- Parts: about 2.7 GB/hour at 6 Mbit/s; deleted after a successful finalize; kept on failure for retry.
- Caps: per-class `STREAM_RECORDER_MAX_BYTES`, global `STREAM_RECORDER_MIN_FREE_BYTES`, max duration.
- A finalize (concat or OBS remux) only starts when the media disk has the input size x
  `STREAM_RECORDER_FINALIZE_SPACE_FACTOR` (2.0: the MP4 plus the HLS transcode) plus
  `STREAM_RECORDER_MIN_FREE_BYTES` free; otherwise the recording fails with "Not enough free disk
  space ..." and keeps its parts: free space, then retry.
- Final MP4 lives in `backend_media` next to the transcoder's HLS output.
- Failed recordings keep their parts (or staged OBS upload) for
  `STREAM_RECORDER_FAILED_RETENTION_DAYS` (7) so a retry works; the recorder's hourly sweep then
  deletes them and notes it in the error. It also removes `class-recording-<id>` folders and staged
  uploads whose recording row was deleted, and leftover folders of published recordings (all only
  after an hour). Recordings that are `recording` or `finalizing` are never touched.

## Failures and retries

- `failed` rows show the reason in Admin > Class recordings. Fix the cause (for example tag the
  session's module) and use the "Retry selected failed recordings" action or
  `POST /api/realtime/class-recordings/<id>/retry/`.
- A failed transcode is retried by the transcoder itself; the recorder republishes automatically
  when the lecture becomes ready.
- Recorder down during class: the live stream is unaffected; capture resumes with a new part
  when it is back. Stop requests made meanwhile are finalized when it restarts.

## Verify the pipeline on the server (real ffmpeg)

```
docker exec streamx-stream-recorder-1 python manage.py verify_recording_pipeline
```

Runs in about a minute (the feed is real time) and prints one line per check, ending in
`RESULT: PASS (<n> checks passed)` (exit code 0) or `RESULT: FAIL (...)` (exit code 1, the failing
checks are marked `[FAIL]` with the ffmpeg error or the measured value). What it does:

1. Checks ffmpeg/ffprobe and the codecs/formats used (libx264, aac, hls, concat, mpegts, mp4,
   matroska) and prints the ffmpeg version and the free space of the real media/recordings folders
   (`[WARN]` if below `STREAM_RECORDER_MIN_FREE_BYTES`; informational only).
2. Generates test media with ffmpeg (testsrc + sine tone, H.264/AAC, 2 s segments) and serves it like
   Owncast from a tiny HTTP server on 127.0.0.1: master playlist with two variants, a live playlist
   growing every 2 s, then Owncast's offline tail (`#EXT-X-DISCONTINUITY` + `offline-v2.ts` +
   `#EXT-X-ENDLIST`), then a reconnect with fresh segment names. Only Owncast's status API is replaced.
3. Drives the recorder's real capture code against it (ffmpeg through the playlist filter), ends the
   class and runs the real finalize, then asserts: two parts, the offline clip never downloaded and
   ffmpeg ending the part by itself, only the best variant read, each part and the final MP4 of the
   live duration (+/- 3 s; the offline clip is 8 s), H.264 + AAC, audio/video durations together,
   faststart (moov before mdat), and an unpublished lecture in the module with the module description.
4. Runs the other finalize paths for real: a Host Studio (LiveKit egress) MP4, an OBS MKV upload
   (remux to faststart MP4 swapped into the lecture) and an imported file (scan -> "Publish to module").

It is safe on production and inside the running recorder container: every database row it creates is
in one transaction that is always rolled back (other processes never see them, so the live recorder
and the transcoder never touch them; only id sequence numbers advance), all files are in a fresh
temporary folder that is deleted afterwards (`--keep-temp` keeps it for inspection), MEDIA_ROOT and the
recorder folders are redirected for this process only, the simulated Owncast and the filter use their
own ephemeral 127.0.0.1 ports, and it never takes the recorder's Redis leader key. It refuses to run if
rows named `zz-verify-recording-pipeline...` already exist. It uses up to about one CPU for a few
seconds while generating the test media (under `nice`); a live capture (stream copy) is not affected.
`backend/tests/test_recording_pipeline_real_ffmpeg.py` runs the same check in the test suite wherever
ffmpeg is installed (skipped elsewhere).

## Admin: Class recordings

Admin > Realtime > Class recordings lists every recording (server capture, OBS upload, Host Studio,
imported) with course, module, class, date, source, duration, size, state and the lecture
(published/unpublished). Filters: course, module (narrowed to the chosen course), source, state, date;
search covers class, course, module, lecture and file path.

The recording page has a staff-only player and a download link. Files under MEDIA_ROOT are handed to
nginx's internal `/_protected_media/` location (same mechanism as the course player, byte ranges
served by nginx); files on the `/recordings` volume are streamed by Django with HTTP Range support in
chunks of at most 8 MiB. Only active staff with the class-recording view permission get a file;
students and anonymous users are sent to the admin login. Actions (change permission):

- Publish / Unpublish lecture (publish only once its HLS stream is ready; unpublish once the recording
  is no longer processing, otherwise it would be re-published automatically);
- Move to another module of the same course (the lecture keeps its video, likes, comments and views
  and goes to the end of the new module; its file stays where it is);
- Retry (failed recordings);
- Delete recording files: a confirmation page lists the captured parts, the source/original file and
  the lecture's MP4 with sizes. A published lecture's video is only deleted with an extra
  confirmation; students keep the HLS stream already built. Nothing is deleted while a recording is
  recording or finalizing, nothing outside the recording folders and never through a symlink. Files
  on `/recordings` (read-only in the web containers) are deleted by the stream recorder within a few
  seconds.
- Publish to module (imported recordings) and Replace with OBS recording (as before).

The older Admin > Realtime > Recordings (LiveKit) list shows course, module, source, status, size,
duration and the class recording/lecture made from each file, and plays files through the same staff
view instead of public URLs.

nginx: `/media/class-recording-uploads/` (OBS uploads waiting for conversion) now answers 404 publicly,
like `/media/lecture_videos/` and `/media/streams/` (`infra/hostinger/tests/test-media-protection-config.sh`).
Deploy `nginx/alsyedinitiative.conf` with `deploy-nginx-config.sh` and restart the `media` service so it
reads the updated `media.conf`. Note: `/media/realtime_recordings/` (old Host Studio browser
recordings) is still public by URL, because the realtime recordings API still hands out those URLs.

## Recordings made before this pipeline (import)

Run once after deploying this release (and whenever old files turn up):

```
docker exec streamx-stream-recorder-1 python manage.py scan_existing_recordings --dry-run
docker exec streamx-stream-recorder-1 python manage.py scan_existing_recordings
```

or Admin > Class recordings > "Scan for existing recordings" (limited to 200 new files and 20 s of
ffprobe per click; run it again for more). The scan looks in `/app/media/lecture_videos`,
`/app/media/realtime_recordings`, `/app/media/class-recording-uploads`, `/recordings` (LiveKit egress
outputs) and the recorder work folder, and lists every video that no lecture or class recording uses
as **Imported (unassigned)** with its size and (ffprobe) duration; an orphaned
`class-recording-<id>` capture folder becomes one recording. It never changes, moves or deletes a file,
never follows symlinks, skips hidden/partial/temporary files and anything modified in the last 10
minutes (`--min-age`), and is idempotent (path + size + mtime: re-running lists nothing twice and
refreshes a changed unassigned file). LiveKit files keep their session (title, course) when the
realtime recording row still exists.

Then open an imported recording, check it in the player, and use **Publish to module** (course +
module). The stream recorder then puts the file into
`/app/media/lecture_videos/<course>/module_<id>/`: a hard link when the original is on the same volume
(files already under `/app/media`: no extra space), otherwise a copy (`/recordings` -> `/app/media` are
separate Docker volumes); MKV/FLV/TS are remuxed to a faststart MP4 (the original container is kept if
that fails). Orphaned capture parts are concatenated. The same disk-space check as every finalize
applies (input x `STREAM_RECORDER_FINALIZE_SPACE_FACTOR` + `STREAM_RECORDER_MIN_FREE_BYTES` free on
the media disk, otherwise the recording fails with a retryable error). An unpublished lecture is
created at the end of the module (title "<class title> - DD Mon YYYY" when the session is known,
otherwise "Class recording - DD Mon YYYY" from the file date; description = module description), the
transcoder builds HLS and the recorder publishes the lecture when it is ready, like any class
recording. The original stays where it was; delete it later with "Delete recording files" if the space
is needed. The recorder's sweep never deletes folders or uploads that an imported recording points at.
