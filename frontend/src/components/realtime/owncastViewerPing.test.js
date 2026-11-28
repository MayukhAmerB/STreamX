import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNCAST_PING_INTERVAL_MS,
  isVideoPlaying,
  owncastPingUrl,
  owncastViewerTag,
  sendOwncastPing,
  startOwncastViewerPing,
} from "./owncastViewerPing";

function fakeVideo(state = {}) {
  const listeners = {};
  return {
    paused: false,
    ended: false,
    readyState: 4,
    ...state,
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
    removeEventListener: (name) => {
      delete listeners[name];
    },
    listeners,
  };
}

describe("live viewer count pings", () => {
  afterEach(() => vi.useRealTimers());

  it("tags each student once, and anonymous players randomly", () => {
    expect(owncastViewerTag(251)).toBe("u251");
    expect(owncastViewerTag(null, () => 0.5)).toMatch(/^t[0-9a-z]+$/);
  });

  it("pings next to the same-origin playlist with a safe viewer tag", () => {
    const base = "https://alsyedinitiative.com/join-live";
    expect(owncastPingUrl("/hls/stream.m3u8", "u251", base)).toBe(
      "https://alsyedinitiative.com/live-stream-ping/?viewer=u251"
    );
    expect(owncastPingUrl("/hls/stream.m3u8", "bad tag:1", base)).toBe("https://alsyedinitiative.com/live-stream-ping/");
    expect(owncastPingUrl("", "u1", base)).toBe("");
  });

  it("counts only a player that is really playing", () => {
    expect(isVideoPlaying(fakeVideo())).toBe(true);
    expect(isVideoPlaying(fakeVideo({ paused: true }))).toBe(false);
    expect(isVideoPlaying(fakeVideo({ ended: true }))).toBe(false);
    expect(isVideoPlaying(fakeVideo({ readyState: 1 }))).toBe(false);
    expect(isVideoPlaying(null)).toBe(false);
  });

  it("pings at once, every 4 s while playing, never while paused, and stops", () => {
    vi.useFakeTimers();
    const video = fakeVideo();
    const send = vi.fn();
    const stop = startOwncastViewerPing({ url: "/live-stream-ping/?viewer=u1", getVideo: () => video, send });
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(OWNCAST_PING_INTERVAL_MS * 2);
    expect(send).toHaveBeenCalledTimes(3);
    video.paused = true;
    vi.advanceTimersByTime(OWNCAST_PING_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(3);
    video.paused = false;
    video.listeners.playing();
    expect(send).toHaveBeenCalledTimes(4);
    stop();
    vi.advanceTimersByTime(OWNCAST_PING_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(4);
    expect(video.listeners.playing).toBeUndefined();
  });

  it("sends the stream cookie and swallows failures", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("offline")));
    sendOwncastPing("/live-stream-ping/", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/live-stream-ping/", expect.objectContaining({ credentials: "include", cache: "no-store" }));
    await Promise.resolve();
    expect(() => sendOwncastPing("", fetchImpl)).not.toThrow();
  });
});
