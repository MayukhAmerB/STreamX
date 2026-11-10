import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fire, renderTree, textOf } from "../test-utils/renderTree";
import ProtectedPlaybackSurface from "./ProtectedPlaybackSurface";

// The watermark reads the signed-in user; it is covered by its own page tests.
vi.mock("./PlaybackWatermark", () => ({ default: () => null }));

/** Minimal HTMLVideoElement stand-in that fires the events the surface listens to. */
function createFakeVideo({ duration = 1080, paused = true } = {}) {
  const listeners = {};
  const video = {
    duration,
    currentTime: 0,
    paused,
    muted: false,
    volume: 1,
    playbackRate: 1,
    play: vi.fn(async () => {
      video.paused = false;
      video.emit("play");
    }),
    pause: vi.fn(() => {
      video.paused = true;
      video.emit("pause");
    }),
    addEventListener(name, listener) {
      (listeners[name] ||= new Set()).add(listener);
    },
    removeEventListener(name, listener) {
      listeners[name]?.delete(listener);
    },
    emit(name) {
      [...(listeners[name] || [])].forEach((listener) => listener({ type: name }));
    },
  };
  return video;
}

const surfaceOf = (view) => view.find((node) => node.props["data-protected-playback-surface"] === "true");
const controlsVisible = (view) => surfaceOf(view).props["data-controls-visible"];
const button = (view, label) =>
  view.find((node) => node.type === "button" && node.props["aria-label"] === label);

async function renderSurface({ video = createFakeVideo(), ...props } = {}) {
  const videoRef = { current: video };
  const view = await renderTree(
    <ProtectedPlaybackSurface videoRef={videoRef} videoSessionKey="lesson-1" {...props}>
      <video />
    </ProtectedPlaybackSurface>
  );
  return { view, video };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Timers in the surface are scheduled through `window`.
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProtectedPlaybackSurface controls", () => {
  it("renders a single icon control bar with labelled buttons and the time", async () => {
    const { view } = await renderSurface();

    for (const label of ["Play", "Back 10 seconds", "Forward 10 seconds", "Mute", "Fullscreen"]) {
      expect(button(view, label), label).toBeTruthy();
    }
    expect(button(view, "Playback speed 1x. Change speed")).toBeTruthy();
    const seek = view.find((node) => node.type === "input" && node.props.type === "range");
    expect(seek.props["aria-label"]).toBe("Seek through video");
    expect(seek.props["aria-valuetext"]).toBe("0:00 of 18:00");
    expect(textOf(view.find((node) => node.props.className === "pps-time"))).toBe("0:00 / 18:00");
    // Icon-only: no text pills such as "-10s" or "1.5x" buttons any more.
    expect(view.text()).not.toContain("-10s");
    // The course player's F shortcut finds the fullscreen button by this marker.
    expect(button(view, "Fullscreen").props["data-playback-action"]).toBe("fullscreen");
  });

  it("plays and pauses the video from the bar", async () => {
    const { view, video } = await renderSurface();

    await fire(button(view, "Play"), "onClick");
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(button(view, "Pause")).toBeTruthy();

    await fire(button(view, "Pause"), "onClick");
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(button(view, "Play")).toBeTruthy();
  });

  it("cycles the speed with one compact button", async () => {
    const { view, video } = await renderSurface();

    await fire(button(view, "Playback speed 1x. Change speed"), "onClick");
    expect(video.playbackRate).toBe(1.5);
    await fire(button(view, "Playback speed 1.5x. Change speed"), "onClick");
    expect(video.playbackRate).toBe(2);
    await fire(button(view, "Playback speed 2x. Change speed"), "onClick");
    expect(video.playbackRate).toBe(1);
  });

  it("mutes, skips and seeks the video", async () => {
    const { view, video } = await renderSurface();
    video.currentTime = 100;

    await fire(button(view, "Mute"), "onClick");
    expect(video.muted).toBe(true);
    expect(button(view, "Unmute")).toBeTruthy();

    await fire(button(view, "Forward 10 seconds"), "onClick");
    expect(video.currentTime).toBe(110);
    await fire(button(view, "Back 10 seconds"), "onClick");
    expect(video.currentTime).toBe(100);

    const seek = view.find((node) => node.type === "input" && node.props.type === "range");
    await fire(seek, "onChange", { target: { value: "540" } });
    expect(video.currentTime).toBe(540);
  });

  it("fades the controls after 3 seconds of playback and brings them back on movement", async () => {
    const { view, video } = await renderSurface();
    expect(controlsVisible(view)).toBe("true");

    await fire(button(view, "Play"), "onClick");
    await act(() => {
      vi.advanceTimersByTime(2900);
    });
    expect(controlsVisible(view)).toBe("true");
    await act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(controlsVisible(view)).toBe("false");

    await fire(surfaceOf(view), "onPointerMove", { pointerType: "mouse" });
    expect(controlsVisible(view)).toBe("true");

    // Paused video: the controls stay.
    await act(async () => {
      video.pause();
    });
    await act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(controlsVisible(view)).toBe("true");
  });

  it("drops scrubbing, skipping and speed for live streams and shows LIVE", async () => {
    const { view } = await renderSurface({ live: true, video: createFakeVideo({ duration: Infinity }) });

    expect(view.find((node) => node.type === "input" && node.props.type === "range")).toBeNull();
    expect(button(view, "Back 10 seconds")).toBeNull();
    expect(button(view, "Forward 10 seconds")).toBeNull();
    expect(button(view, "Playback speed 1x. Change speed")).toBeNull();
    expect(textOf(view.find((node) => node.props.className === "pps-live"))).toBe("Live");
    expect(button(view, "Mute")).toBeTruthy();
    expect(button(view, "Fullscreen")).toBeTruthy();
  });

  it("detects a live stream from an infinite duration even without the prop", async () => {
    const { view } = await renderSurface({ video: createFakeVideo({ duration: Infinity }) });
    expect(surfaceOf(view).props["data-live"]).toBe("true");
  });

  it("shows no controls until the video element exists", async () => {
    const videoRef = { current: null };
    const view = await renderTree(
      <ProtectedPlaybackSurface videoRef={videoRef} videoSessionKey="live">
        <p>Preparing secure live video...</p>
      </ProtectedPlaybackSurface>
    );
    expect(view.find((node) => node.props.className === "pps-controls")).toBeNull();
    expect(button(view, "Play video")).toBeNull();
  });

  it("offers quality choices in an inline menu", async () => {
    const onQualityChange = vi.fn();
    const { view } = await renderSurface({
      showQualityControl: true,
      qualityOptions: [
        { value: "auto", label: "Auto" },
        { value: "720", label: "720p" },
      ],
      selectedQuality: "auto",
      onQualityChange,
      qualityControlMessage: "Auto picks the best quality for your connection.",
    });

    const trigger = button(view, "Quality: Auto");
    expect(trigger.props["aria-haspopup"]).toBe("menu");
    await fire(trigger, "onClick");
    const options = view.all((node) => node.props.role === "menuitemradio");
    expect(options.map(textOf)).toEqual(["Auto", "720p"]);
    expect(options[0].props["aria-checked"]).toBe("true");
    expect(view.text()).toContain("Auto picks the best quality");

    await fire(options[1], "onClick");
    expect(onQualityChange).toHaveBeenCalledWith("720");
    expect(view.find((node) => node.props.role === "menu")).toBeNull();
  });

  it("keeps a fullscreen icon button for embedded players without a video", async () => {
    const view = await renderTree(
      <ProtectedPlaybackSurface>
        <iframe title="Stream" />
      </ProtectedPlaybackSurface>
    );
    const fullscreen = button(view, "Fullscreen");
    expect(fullscreen.props["data-playback-action"]).toBe("fullscreen");
    expect(view.find((node) => node.props.className === "pps-controls")).toBeNull();
  });
});
