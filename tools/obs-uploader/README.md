# obs-uploader

A small Windows program for the host's laptop. When OBS stops recording, it
uploads the recording to the class it belongs to on the platform, on its own.
The better-quality OBS file then **replaces the server's auto-recording** of
that class (same lecture: students keep their progress and comments), or
creates and publishes the lecture when there is no auto-recording.

* Uploads in 32 MiB parts through the normal `api.alsyedinitiative.com`
  address. Each part is far below Cloudflare's 100 MB request limit, so the
  API stays behind the orange cloud (**no grey-cloud switching any more**).
* Resumable: a dropped connection, a closed laptop or a reboot continues from
  the parts already on the server (the server keeps an unfinished upload for
  48 hours).
* Each part carries its SHA-256 and the whole file's SHA-256 is checked on the
  server before the lecture is touched.
* Signs in with a **personal upload token** that can only upload class
  recordings and can be revoked at any time in the Console.

## 1. OBS settings

1. **Settings → Output → Recording → Recording Path**: where OBS saves
   recordings (default `C:\Users\<you>\Videos`). Use the same folder in the
   config below.
2. **Settings → Advanced → Recording → Automatically remux to mp4**: on. The
   uploader then sends the MP4. An MKV is accepted too (the server converts it
   to MP4 without re-encoding).
3. **Tools → WebSocket Server Settings**: **Enable WebSocket server** (port
   4455), keep **Enable Authentication** on and copy the **Server Password**.
   Without it the uploader still works by watching the recording folder.

## 2. Upload token

Console → **Upload recording** → *Automatic upload from your laptop* →
**Create upload token**. Copy the token (`asu_…`): it is shown only once.

## 3. Install

1. Copy `obs-uploader.exe` to e.g. `C:\Program Files\obs-uploader\`.
2. Create `%APPDATA%\obs-uploader\config.toml`:

   ```toml
   api_base = "https://api.alsyedinitiative.com/api"
   token = "asu_..."                       # the personal upload token
   recordings_dir = 'C:\Users\<you>\Videos' # OBS Recording Path (single quotes)
   obs_websocket_password = "..."          # OBS WebSocket Server Password

   # Optional
   # obs_websocket_url = "ws://127.0.0.1:4455"
   # session_id = 123          # always this class (default: your live class, else the one that ended last)
   # stable_seconds = 20       # the file must stop growing for this long
   # remux_wait_seconds = 180  # wait this long for OBS's MP4 copy of an MKV
   # parallel_chunks = 3
   ```

3. Check it: `obs-uploader.exe check` (token, folder and OBS connection).
4. Start it with Windows: `obs-uploader.exe install-task`. This creates a Task
   Scheduler task **"OBS recording uploader"** that runs `obs-uploader.exe run`
   at log on (normal user rights). Remove it with
   `obs-uploader.exe uninstall-task`. To see it: Task Scheduler → Task
   Scheduler Library.

Log: `%APPDATA%\obs-uploader\obs-uploader.log`. Resume state:
`%APPDATA%\obs-uploader\state.json` (delete a line there to upload a file again).

One file by hand (resumes if interrupted): `obs-uploader.exe upload "C:\Users\<you>\Videos\2026-11-14 19-00-01.mp4"`
(add `--session <class id>` to choose the class).

## How it decides

* OBS reports `RecordStateChanged → OBS_WEBSOCKET_OUTPUT_STOPPED` with the file
  path (obs-websocket v5). If OBS is not reachable, the recording folder is
  scanned every 15 s instead (files from the last 24 hours).
* A file is uploaded once its size has not changed for `stable_seconds` and
  OBS no longer holds it open.
* An MKV whose `.mp4` twin appears (OBS automatic remux) is skipped; the MP4 is
  uploaded. An MKV without a twin after `remux_wait_seconds` is uploaded as is.
* Without `session_id`, the server attaches the upload to your live class, or
  else the class of yours that ended last (within 30 days).

## Build and test (developers)

```
cargo build --release      # target\release\obs-uploader.exe
cargo test                 # unit tests + an end-to-end upload against a mock API
cargo clippy --all-targets -- -D warnings
```
