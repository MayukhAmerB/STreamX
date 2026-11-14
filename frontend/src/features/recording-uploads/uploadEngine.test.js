import { describe, expect, it, vi } from "vitest";

import { backoffDelay, chunkRange, createChunkUploader, isFatalError } from "./uploadEngine";

const CHUNK = 10;

function fakeFile(size) {
  const bytes = new Uint8Array(size).map((_, index) => index % 251);
  return new Blob([bytes]);
}

function uploadOf(size, received = []) {
  return {
    id: "u-1",
    chunk_bytes: CHUNK,
    total_bytes: size,
    chunk_count: Math.ceil(size / CHUNK),
    received_chunks: received,
  };
}

function httpError(status, code = "") {
  const error = new Error(`HTTP ${status}`);
  error.response = { status, data: { message: `refused ${status}`, errors: code ? { code } : {} } };
  return error;
}

function fakeApi({ failures = {}, onPut } = {}) {
  const sent = [];
  let active = 0;
  let maxActive = 0;
  const api = {
    sent,
    get maxActive() {
      return maxActive;
    },
    putChunk: vi.fn(async (id, index, blob, { sha256, signal, onProgress }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await onPut?.(index, signal);
        if (signal?.aborted) {
          const abort = new Error("canceled");
          abort.name = "CanceledError";
          throw abort;
        }
        const queue = failures[index];
        if (queue?.length) throw queue.shift();
        onProgress?.(blob.size);
        sent.push({ index, size: blob.size, sha256 });
        return { data: { data: { index } } };
      } finally {
        active -= 1;
      }
    }),
    completeUpload: vi.fn(async () => ({ data: { data: { id: "u-1", status: "queued" } } })),
    abortUpload: vi.fn(async () => ({ data: { data: { status: "aborted" } } })),
  };
  return api;
}

const noSleep = vi.fn(async () => {});
const fixedHash = async () => "ab".repeat(32);

describe("upload engine", () => {
  it("sends only the chunks the server lacks, at most 3 at a time, then completes", async () => {
    const api = fakeApi({ onPut: () => new Promise((resolve) => setTimeout(resolve, 5)) });
    const updates = [];
    const uploader = createChunkUploader({
      upload: uploadOf(95, [0, 4]),
      file: fakeFile(95),
      api,
      hashChunk: fixedHash,
      sleep: noSleep,
      onUpdate: (snapshot) => updates.push(snapshot),
    });
    const result = await uploader.start();
    expect(result.data.data.status).toBe("queued");
    expect(api.sent.map((item) => item.index).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    expect(api.sent.find((item) => item.index === 9).size).toBe(5);
    expect(api.sent.every((item) => item.sha256 === "ab".repeat(32))).toBe(true);
    expect(api.maxActive).toBe(3);
    expect(api.completeUpload).toHaveBeenCalledTimes(1);
    const last = updates[updates.length - 1];
    expect(last.phase).toBe("processing");
    expect(last.resumedBytes).toBe(20);
    expect(last.sentBytes).toBe(95);
    expect(last.percent).toBe(100);
  });

  it("retries a dropped connection with backoff and loses nothing", async () => {
    const network = () => Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
    const api = fakeApi({ failures: { 1: [network(), network(), httpError(503)] } });
    const phases = [];
    const sleep = vi.fn(async () => {});
    const uploader = createChunkUploader({
      upload: uploadOf(30),
      file: fakeFile(30),
      api,
      hashChunk: null,
      sleep,
      random: () => 0,
      onUpdate: (snapshot) => phases.push(snapshot.phase),
    });
    await uploader.start();
    expect(api.sent.map((item) => item.index).sort()).toEqual([0, 1, 2]);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000, 2000]);
    expect(phases).toContain("retrying");
    expect(phases[phases.length - 1]).toBe("processing");
  });

  it("stops on a refusal no retry can fix", async () => {
    const api = fakeApi({ failures: { 0: [httpError(409, "chunk_conflict")] } });
    const uploader = createChunkUploader({ upload: uploadOf(20), file: fakeFile(20), api, hashChunk: null, sleep: noSleep });
    await expect(uploader.start()).rejects.toThrow("refused 409");
    expect(api.completeUpload).not.toHaveBeenCalled();
  });

  it("re-sends a chunk that arrived damaged, but not forever", async () => {
    const damaged = () => httpError(422, "chunk_checksum_mismatch");
    const api = fakeApi({ failures: { 0: [damaged()] } });
    const uploader = createChunkUploader({ upload: uploadOf(10), file: fakeFile(10), api, hashChunk: null, sleep: noSleep });
    await uploader.start();
    expect(api.sent.map((item) => item.index)).toEqual([0]);

    const always = fakeApi({ failures: { 0: Array.from({ length: 10 }, damaged) } });
    const stuck = createChunkUploader({ upload: uploadOf(10), file: fakeFile(10), api: always, hashChunk: null, sleep: noSleep });
    await expect(stuck.start()).rejects.toThrow(/keeps arriving damaged/);
  });

  it("pauses (aborting chunks in flight) and resumes", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const api = fakeApi({
      onPut: (index, signal) =>
        new Promise((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", resolve);
          gate.then(resolve);
        }),
    });
    const phases = [];
    const uploader = createChunkUploader({
      upload: uploadOf(20),
      file: fakeFile(20),
      api,
      hashChunk: null,
      sleep: noSleep,
      onUpdate: (snapshot) => phases.push(snapshot.phase),
    });
    const done = uploader.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    uploader.pause();
    expect(phases[phases.length - 1]).toBe("paused");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(api.sent).toEqual([]);
    release();
    uploader.resume();
    await done;
    expect(api.sent.map((item) => item.index).sort()).toEqual([0, 1]);
  });

  it("cancel aborts and deletes the upload on the server", async () => {
    const api = fakeApi({ onPut: (index, signal) => new Promise((resolve) => signal?.addEventListener("abort", resolve)) });
    const uploader = createChunkUploader({ upload: uploadOf(20), file: fakeFile(20), api, hashChunk: null, sleep: noSleep });
    const done = uploader.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await uploader.cancel();
    expect(await done).toBeNull();
    expect(api.abortUpload).toHaveBeenCalledWith("u-1");
    expect(api.completeUpload).not.toHaveBeenCalled();
  });

  it("sends chunks the server reports missing at complete", async () => {
    const api = fakeApi();
    api.completeUpload
      .mockRejectedValueOnce(
        Object.assign(httpError(409, "chunks_missing"), {
          response: { status: 409, data: { errors: { code: "chunks_missing", missing_chunks: [1] } } },
        })
      )
      .mockResolvedValueOnce({ data: { data: { status: "queued" } } });
    const uploader = createChunkUploader({ upload: uploadOf(20), file: fakeFile(20), api, hashChunk: null, sleep: noSleep });
    await uploader.start();
    expect(api.sent.map((item) => item.index)).toEqual([0, 1, 1]);
    expect(api.completeUpload).toHaveBeenCalledTimes(2);
  });

  it("reports speed and time left from recent progress", async () => {
    let clock = 0;
    const api = fakeApi({
      onPut: async () => {
        clock += 1000;
      },
    });
    const updates = [];
    const uploader = createChunkUploader({
      upload: uploadOf(40),
      file: fakeFile(40),
      api,
      hashChunk: null,
      concurrency: 1,
      sleep: noSleep,
      now: () => clock,
      onUpdate: (snapshot) => updates.push(snapshot),
    });
    await uploader.start();
    const mid = updates.find((item) => item.sentBytes === 20 && item.speedBytesPerSecond > 0);
    expect(mid.speedBytesPerSecond).toBeCloseTo(10, 0);
    expect(mid.etaSeconds).toBe(2);
  });

  it("classifies errors and grows the backoff to a cap", () => {
    expect(isFatalError(httpError(409, "chunk_conflict"))).toBe(true);
    expect(isFatalError(httpError(422, "chunk_checksum_mismatch"))).toBe(false);
    expect(isFatalError(httpError(503))).toBe(false);
    expect(isFatalError(httpError(429))).toBe(false);
    expect(isFatalError(new Error("Network Error"))).toBe(false);
    expect(backoffDelay(1, () => 1)).toBe(1000);
    expect(backoffDelay(4, () => 1)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(30000);
    expect(chunkRange(uploadOf(25), 2)).toEqual({ start: 20, end: 25, size: 5 });
  });
});
