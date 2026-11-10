// Lecture progress syncing, extracted from the player so it can be unit
// tested without a video element. Behaviour preserved from the original
// page: routine updates at most every 15s of playback, forced saves on
// pause / lesson switch / tab hide / unload, one request in flight at a time
// (the newest pending snapshot is sent afterwards), and a Retry-After aware
// back-off when the API rate limits (429).

export const PROGRESS_SYNC_INTERVAL_SECONDS = 15;
export const PROGRESS_THROTTLE_BACKOFF_MS = 30000;

export function resolveRetryAfterMs(error, fallbackMs = PROGRESS_THROTTLE_BACKOFF_MS, now = Date.now()) {
  const retryAfterHeader = error?.response?.headers?.["retry-after"];
  if (!retryAfterHeader) return fallbackMs;

  const retryAfterValue = String(retryAfterHeader).trim();
  const seconds = Number(retryAfterValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, seconds * 1000);
  }

  const retryAt = Date.parse(retryAfterValue);
  if (Number.isFinite(retryAt)) {
    return Math.max(1000, retryAt - now);
  }

  return fallbackMs;
}

/**
 * @param {object} options
 * @param {(lectureId: number, payload: object) => Promise<object>} options.save  resolves to the progress snapshot
 * @param {(lectureId: number, snapshot: object) => void} [options.onSaved]
 * @param {(status: {state: string, message?: string}) => void} [options.onStatus]
 * @param {(error: unknown) => string} [options.describeError]
 */
export function createProgressSyncer({
  save,
  onSaved = () => {},
  onStatus = () => {},
  describeError = () => "Unable to save lesson progress.",
  intervalSeconds = PROGRESS_SYNC_INTERVAL_SECONDS,
  backoffMs = PROGRESS_THROTTLE_BACKOFF_MS,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  let inFlight = false;
  let pending = null;
  let deferred = null;
  let retryAt = 0;
  let retryTimer = null;
  let hasError = false;
  let disposed = false;
  let pendingWaiters = [];
  let lastSynced = { lectureId: null, positionSeconds: 0, completed: undefined };

  function clearRetryTimer() {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(delayMs) {
    clearRetryTimer();
    retryTimer = setTimer(() => {
      retryTimer = null;
      retryAt = 0;
      const snapshot = deferred;
      deferred = null;
      if (snapshot && !disposed) void sync({ ...snapshot, force: true });
    }, delayMs);
  }

  /**
   * Resolves to { status, snapshot }:
   *  "saved"    the API accepted it (snapshot = server progress)
   *  "skipped"  nothing new to save (routine update inside the interval)
   *  "deferred" rate limited; it will be retried automatically
   *  "error"    the save failed
   * A forced save made while another request is in flight waits for it and
   * resolves with the result of the queued save.
   */
  async function sync({ lectureId, positionSeconds, durationSeconds, completed, force = false }) {
    if (!lectureId) return { status: "skipped", snapshot: null };

    const snapshot = {
      lectureId,
      positionSeconds: Math.max(0, Math.floor(Number(positionSeconds) || 0)),
      durationSeconds: Math.max(0, Math.floor(Number(durationSeconds) || 0)),
      completed,
      force,
    };

    const retryDelayMs = retryAt - now();
    if (retryDelayMs > 0) {
      deferred = snapshot;
      if (retryTimer === null) scheduleRetry(retryDelayMs);
      return { status: "deferred", snapshot: null };
    }

    const shouldSkip =
      !force &&
      lastSynced.lectureId === lectureId &&
      lastSynced.completed === completed &&
      Math.abs(lastSynced.positionSeconds - snapshot.positionSeconds) < intervalSeconds;
    if (shouldSkip) return { status: "skipped", snapshot: null };

    if (inFlight) {
      // A routine update never replaces a queued explicit save (e.g. "Mark complete").
      if (!force && pending?.force) return { status: "skipped", snapshot: null };
      pending = snapshot;
      if (!force) return { status: "skipped", snapshot: null };
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }

    inFlight = true;
    if (force) onStatus({ state: "saving" });
    let result;
    try {
      const payload = {
        position_seconds: snapshot.positionSeconds,
        duration_seconds: snapshot.durationSeconds || undefined,
      };
      // `completed` is only sent when it is an explicit decision (video ended,
      // "Mark complete" / "Mark incomplete"), so routine saves never undo a
      // lesson the learner marked complete by hand.
      if (typeof completed === "boolean") payload.completed = completed;

      const saved = await save(lectureId, payload);
      clearRetryTimer();
      deferred = null;
      retryAt = 0;
      lastSynced = { lectureId, positionSeconds: snapshot.positionSeconds, completed };
      if (!disposed) {
        if (saved) onSaved(lectureId, saved);
        if (force || hasError) onStatus({ state: "saved" });
      }
      hasError = false;
      result = { status: "saved", snapshot: saved || null };
    } catch (error) {
      hasError = true;
      if (error?.response?.status === 429) {
        const delayMs = resolveRetryAfterMs(error, backoffMs, now());
        retryAt = now() + delayMs;
        deferred = snapshot;
        if (!disposed) {
          scheduleRetry(delayMs);
          onStatus({
            state: "throttled",
            message: `Progress saving paused. Retrying in ${Math.ceil(delayMs / 1000)}s.`,
          });
        }
        result = { status: "deferred", snapshot: null };
      } else {
        if (!disposed) onStatus({ state: "error", message: describeError(error) });
        result = { status: "error", snapshot: null };
      }
    } finally {
      inFlight = false;
    }

    const next = pending;
    const waiters = pendingWaiters;
    pending = null;
    pendingWaiters = [];
    if (
      next &&
      (next.completed !== completed ||
        next.positionSeconds !== snapshot.positionSeconds ||
        next.lectureId !== lectureId)
    ) {
      const followUp = sync({ ...next, force: next.force || waiters.length > 0 });
      if (waiters.length) followUp.then((nextResult) => waiters.forEach((resolve) => resolve(nextResult)));
    } else {
      waiters.forEach((resolve) => resolve(result));
    }
    return result;
  }

  return {
    sync,
    dispose() {
      disposed = true;
      clearRetryTimer();
    },
  };
}
