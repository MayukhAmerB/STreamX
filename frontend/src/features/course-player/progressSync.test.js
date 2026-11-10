import { describe, expect, it, vi } from "vitest";
import { createProgressSyncer, resolveRetryAfterMs } from "./progressSync";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides = {}) {
  let clock = 1_000_000;
  const timers = [];
  const save = vi.fn(async (_id, payload) => ({ ...payload, completed: Boolean(payload.completed) }));
  const onSaved = vi.fn();
  const onStatus = vi.fn();
  const syncer = createProgressSyncer({
    save,
    onSaved,
    onStatus,
    now: () => clock,
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer: () => {},
    ...overrides,
  });
  return {
    syncer,
    save,
    onSaved,
    onStatus,
    timers,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe("resolveRetryAfterMs", () => {
  it("reads seconds or an HTTP date, with a sane fallback", () => {
    expect(resolveRetryAfterMs({ response: { headers: { "retry-after": "12" } } })).toBe(12000);
    expect(resolveRetryAfterMs({ response: { headers: { "retry-after": "0" } } })).toBe(1000);
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(
      resolveRetryAfterMs({ response: { headers: { "retry-after": "Tue, 10 Nov 2026 12:00:20 GMT" } } }, 30000, now)
    ).toBe(20000);
    expect(resolveRetryAfterMs({})).toBe(30000);
  });
});

describe("createProgressSyncer", () => {
  it("saves at most every 15 seconds of playback unless forced", async () => {
    const { syncer, save } = setup();
    expect((await syncer.sync({ lectureId: 1, positionSeconds: 3, durationSeconds: 100 })).status).toBe("saved");
    expect((await syncer.sync({ lectureId: 1, positionSeconds: 10, durationSeconds: 100 })).status).toBe("skipped");
    expect((await syncer.sync({ lectureId: 1, positionSeconds: 19, durationSeconds: 100 })).status).toBe("saved");
    expect((await syncer.sync({ lectureId: 1, positionSeconds: 20, force: true })).status).toBe("saved");
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenNthCalledWith(1, 1, { position_seconds: 3, duration_seconds: 100 });
  });

  it("only sends `completed` for explicit decisions", async () => {
    const { syncer, save } = setup();
    await syncer.sync({ lectureId: 1, positionSeconds: 30, force: true });
    await syncer.sync({ lectureId: 1, positionSeconds: 30, completed: true, force: true });
    await syncer.sync({ lectureId: 1, positionSeconds: 30, completed: false, force: true });
    expect(save.mock.calls.map(([, payload]) => payload.completed)).toEqual([undefined, true, false]);
  });

  it("reports server snapshots", async () => {
    const { syncer, onSaved, onStatus } = setup();
    await syncer.sync({ lectureId: 4, positionSeconds: 50, force: true });
    expect(onSaved).toHaveBeenCalledWith(4, expect.objectContaining({ position_seconds: 50 }));
    expect(onStatus.mock.calls.map(([status]) => status.state)).toEqual(["saving", "saved"]);
  });

  it("queues a forced save behind an in-flight request and resolves with its result", async () => {
    const first = deferred();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (_id, payload) => ({ completed: payload.completed }));
    const { syncer } = setup({ save });
    const routine = syncer.sync({ lectureId: 1, positionSeconds: 40 });
    const markComplete = syncer.sync({ lectureId: 1, positionSeconds: 41, completed: true, force: true });
    // A routine update must not replace the queued explicit save.
    expect((await syncer.sync({ lectureId: 1, positionSeconds: 60 })).status).toBe("skipped");
    first.resolve({ completed: false });
    await routine;
    const result = await markComplete;
    expect(result).toEqual({ status: "saved", snapshot: { completed: true } });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toMatchObject({ position_seconds: 41, completed: true });
  });

  it("backs off on 429 using Retry-After, then retries the newest snapshot", async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429, headers: { "retry-after": "20" } } })
      .mockImplementation(async () => ({ ok: true }));
    const { syncer, timers, onStatus, advance } = setup({ save });
    const result = await syncer.sync({ lectureId: 1, positionSeconds: 30, force: true });
    expect(result.status).toBe("deferred");
    expect(onStatus).toHaveBeenLastCalledWith({ state: "throttled", message: "Progress saving paused. Retrying in 20s." });
    expect(timers[0].delay).toBe(20000);

    advance(5000);
    expect((await syncer.sync({ lectureId: 1, positionSeconds: 45, force: true })).status).toBe("deferred");
    expect(save).toHaveBeenCalledTimes(1);

    advance(15000);
    timers[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toMatchObject({ position_seconds: 45 });
  });

  it("reports other failures as errors", async () => {
    const save = vi.fn().mockRejectedValue({ response: { status: 500 } });
    const { syncer, onStatus } = setup({ save, describeError: () => "Server error" });
    expect((await syncer.sync({ lectureId: 1, positionSeconds: 5, force: true })).status).toBe("error");
    expect(onStatus).toHaveBeenLastCalledWith({ state: "error", message: "Server error" });
  });

  it("still sends the final save after dispose but stops UI callbacks", async () => {
    const { syncer, save, onSaved } = setup();
    syncer.dispose();
    expect((await syncer.sync({ lectureId: 1, positionSeconds: 70, force: true })).status).toBe("saved");
    expect(save).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
