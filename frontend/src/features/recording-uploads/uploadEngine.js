/**
 * Resumable chunk uploader (no React): sends the chunks the server does not
 * have yet, 3 at a time, retries with exponential backoff and jitter, and
 * reports progress, speed and time left. Pause aborts the chunks in flight
 * (they are sent again on resume); a refreshed page resumes because the
 * server lists the chunks it already has.
 *
 *   const uploader = createChunkUploader({ upload, file, api, onUpdate });
 *   const queued = await uploader.start();   // every chunk stored + complete requested
 *   uploader.pause(); uploader.resume(); uploader.cancel();
 *
 * `api` = { putChunk(id, index, blob, { sha256, signal, onProgress }), completeUpload(id), abortUpload(id) }
 * (recordingUploadsApi.js). Everything time-related is injectable for tests.
 */

export const DEFAULT_CONCURRENCY = 3;
export const SPEED_WINDOW_MS = 8000;
const MAX_BACKOFF_MS = 30_000;
// Lost connections are retried for as long as it takes; a chunk the server
// keeps receiving damaged (the file is changing on disk) stops after this.
const MAX_DAMAGED_ATTEMPTS = 5;

/** 1 s, 2 s, 4 s … capped at 30 s, each with 50–100 % jitter. */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base / 2 + (random() * base) / 2);
}

// Sending the same bytes again can fix these (damaged or cut-off body).
const RETRYABLE_CODES = new Set(["chunk_checksum_mismatch", "chunk_incomplete"]);
// Statuses no retry can fix (wrong chunk, upload cancelled or expired, no access).
const FATAL_STATUSES = new Set([400, 401, 403, 404, 409, 410, 411, 413, 416, 422]);

export function errorCode(error) {
  return error?.response?.data?.errors?.code || error?.response?.data?.code || "";
}

export function isFatalError(error) {
  if (RETRYABLE_CODES.has(errorCode(error))) return false;
  const status = Number(error?.response?.status) || 0;
  return FATAL_STATUSES.has(status);
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.name === "CanceledError" || error?.code === "ERR_CANCELED";
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** SHA-256 (hex) of a Blob with WebCrypto, or "" where WebCrypto is unavailable (plain http). */
export async function sha256Hex(blob) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof blob?.arrayBuffer !== "function") return "";
  const digest = await subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function chunkRange(upload, index) {
  const start = index * upload.chunk_bytes;
  const end = Math.min(upload.total_bytes, start + upload.chunk_bytes);
  return { start, end, size: end - start };
}

export function createChunkUploader({
  upload,
  file,
  api,
  hashChunk = sha256Hex,
  concurrency = DEFAULT_CONCURRENCY,
  onUpdate = () => {},
  sleep = defaultSleep,
  now = () => Date.now(),
  random = Math.random,
}) {
  const received = new Set(upload.received_chunks || []);
  let confirmedBytes = 0;
  for (const index of received) confirmedBytes += chunkRange(upload, index).size;
  const startedWith = confirmedBytes;
  const inflight = new Map(); // index -> bytes sent so far
  const controllers = new Map(); // index -> AbortController
  const samples = [];
  let phase = "idle";
  let paused = false;
  let cancelled = false;
  let fatal = null;
  let retry = null; // { index, attempt, inMs, message }
  let resumeWaiters = [];
  const cancelController = new AbortController();

  const sentBytes = () => confirmedBytes + Array.from(inflight.values()).reduce((sum, value) => sum + value, 0);

  function snapshot() {
    const bytes = Math.min(upload.total_bytes, sentBytes());
    const t = now();
    samples.push({ t, bytes });
    while (samples.length > 2 && t - samples[0].t > SPEED_WINDOW_MS) samples.shift();
    const first = samples[0];
    const elapsed = (t - first.t) / 1000;
    const speed = elapsed >= 0.5 && bytes > first.bytes ? (bytes - first.bytes) / elapsed : 0;
    return {
      phase,
      totalBytes: upload.total_bytes,
      sentBytes: bytes,
      resumedBytes: startedWith,
      receivedChunks: received.size,
      chunkCount: upload.chunk_count,
      percent: upload.total_bytes ? Math.floor((bytes / upload.total_bytes) * 100) : 0,
      speedBytesPerSecond: speed,
      etaSeconds: speed > 0 ? Math.ceil((upload.total_bytes - bytes) / speed) : null,
      retry,
      error: fatal ? fatal.message : "",
    };
  }

  const emit = () => onUpdate(snapshot());

  function setPhase(next) {
    phase = next;
    emit();
  }

  function waitWhilePaused() {
    if (!paused || cancelled) return Promise.resolve();
    return new Promise((resolve) => resumeWaiters.push(resolve));
  }

  async function sendChunk(index) {
    let attempt = 0;
    for (;;) {
      await waitWhilePaused();
      if (cancelled || fatal) return;
      const { start, end, size } = chunkRange(upload, index);
      const controller = new AbortController();
      controllers.set(index, controller);
      inflight.set(index, 0);
      try {
        const blob = file.slice(start, end);
        const sha256 = hashChunk ? await hashChunk(blob) : "";
        await api.putChunk(upload.id, index, blob, {
          sha256,
          signal: controller.signal,
          onProgress: (loaded) => {
            if (!controllers.has(index)) return;
            inflight.set(index, Math.min(size, loaded));
            emit();
          },
        });
        controllers.delete(index);
        inflight.delete(index);
        received.add(index);
        confirmedBytes += size;
        if (retry?.index === index) retry = null;
        if (phase === "retrying") phase = "uploading";
        emit();
        return;
      } catch (error) {
        controllers.delete(index);
        inflight.delete(index);
        if (cancelled || fatal) return;
        if (paused && (isAbort(error) || controller.signal.aborted)) {
          emit();
          continue; // sent again from the start of the chunk after resume
        }
        const damagedAgain = RETRYABLE_CODES.has(errorCode(error)) && attempt + 1 >= MAX_DAMAGED_ATTEMPTS;
        if (isFatalError(error) || damagedAgain) {
          fatal = new Error(
            damagedAgain
              ? `Part ${index + 1} keeps arriving damaged. Check that the file is not still being written, then try again.`
              : error?.response?.data?.message || `Part ${index + 1} was refused by the server.`
          );
          fatal.cause = error;
          abortInflight();
          return;
        }
        attempt += 1;
        const inMs = backoffDelay(attempt, random);
        retry = { index, attempt, inMs, message: navigatorOffline() ? "You are offline." : "Connection problem." };
        setPhase("retrying");
        await sleep(inMs, cancelController.signal);
      }
    }
  }

  function navigatorOffline() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  function abortInflight() {
    for (const controller of controllers.values()) controller.abort();
  }

  async function sendAll(indexes) {
    const queue = [...indexes];
    const worker = async () => {
      while (queue.length && !cancelled && !fatal) {
        await waitWhilePaused();
        if (cancelled || fatal) return;
        const index = queue.shift();
        if (index === undefined) return;
        await sendChunk(index);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  }

  async function completeWithRetry() {
    let attempt = 0;
    for (;;) {
      if (cancelled) return null;
      try {
        return await api.completeUpload(upload.id);
      } catch (error) {
        if (errorCode(error) === "chunks_missing") {
          const missing = error?.response?.data?.errors?.missing_chunks || [];
          missing.forEach((index) => {
            if (received.delete(index)) confirmedBytes -= chunkRange(upload, index).size;
          });
          setPhase("uploading");
          await sendAll(missing);
          if (fatal) throw fatal;
          continue;
        }
        if (isFatalError(error)) throw error;
        attempt += 1;
        retry = { index: null, attempt, inMs: backoffDelay(attempt, random), message: "Connection problem." };
        setPhase("retrying");
        await sleep(retry.inMs, cancelController.signal);
      }
    }
  }

  return {
    async start() {
      setPhase("uploading");
      const missing = [];
      for (let index = 0; index < upload.chunk_count; index += 1) if (!received.has(index)) missing.push(index);
      await sendAll(missing);
      if (cancelled) return null;
      if (fatal) {
        setPhase("failed");
        throw fatal;
      }
      setPhase("completing");
      retry = null;
      try {
        const response = await completeWithRetry();
        if (cancelled) return null;
        setPhase("processing");
        return response;
      } catch (error) {
        fatal = fatal || new Error(error?.response?.data?.message || "The upload could not be completed.");
        setPhase("failed");
        throw fatal;
      }
    },
    pause() {
      if (cancelled || paused || !["uploading", "retrying"].includes(phase)) return;
      paused = true;
      abortInflight();
      setPhase("paused");
    },
    resume() {
      if (!paused || cancelled) return;
      paused = false;
      const waiters = resumeWaiters;
      resumeWaiters = [];
      waiters.forEach((resolve) => resolve());
      setPhase("uploading");
    },
    async cancel() {
      if (cancelled) return;
      cancelled = true;
      cancelController.abort();
      abortInflight();
      const waiters = resumeWaiters;
      resumeWaiters = [];
      waiters.forEach((resolve) => resolve());
      setPhase("cancelled");
      await api.abortUpload(upload.id);
    },
    snapshot,
  };
}
