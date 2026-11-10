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
Each OBS connection becomes a new part (ffmpeg exits ~30-60 s after the playlist stops growing,
and a changed Owncast `lastConnectTime` cuts a new part). On stop the parts are concatenated
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
   # REALTIME_BROADCAST_REQUIRE_TARGET_MODULE=1     # once the UI sends target_module_id
   ```
2. Apply migrations as usual (`courses 0035`, `realtime 0025`; additive, nullable/defaulted columns).
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

Resources: `cpus 0.5`, `mem 768m` by default (`STREAM_RECORDER_CPUS`, `STREAM_RECORDER_MEM_LIMIT`).
ffmpeg runs under `nice 10`.

## Quality and the OBS upload replacement

The server recording has the quality of the Owncast rendition it pulls. Without `-map`, ffmpeg takes
the highest-resolution rendition of the master playlist; enable video passthrough on Owncast's top
variant to record OBS's own encode, or point `STREAM_RECORDER_SOURCE_URL` at a specific variant.

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
