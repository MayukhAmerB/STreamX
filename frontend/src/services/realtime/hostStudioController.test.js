import { describe, expect, it, vi } from "vitest";
import { DisconnectReason, RoomEvent, Track, TrackEvent } from "livekit-client";

import { GO_LIVE_CANCELLED, HOST_LINK, HOST_SOURCE, HostStudioController } from "./hostStudioController";

const profile = { capture_width: 640, capture_height: 360, fps: 20, max_video_bitrate_kbps: 650 };

function rawTrack(kind, label) {
  const listeners = {};
  return {
    kind,
    label,
    readyState: "live",
    stop: vi.fn(function stop() {
      this.readyState = "ended";
    }),
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    // What the browser does when the user clicks "Stop sharing" or unplugs a device.
    end() {
      this.readyState = "ended";
      listeners.ended?.();
    },
  };
}

function localTrack(raw) {
  const handlers = {};
  return {
    raw,
    isMuted: false,
    replaceTrack: vi.fn(async function replaceTrack(next) {
      this.raw = next;
      return this;
    }),
    unmute: vi.fn(async function unmute() {
      this.isMuted = false;
    }),
    on(event, handler) {
      handlers[event] = handler;
    },
    emit(event) {
      handlers[event]?.();
    },
  };
}

function fakeRoom() {
  const handlers = {};
  const room = {
    options: null,
    published: [],
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on(event, handler) {
      handlers[event] = handler;
      return room;
    },
    emit(event, ...args) {
      handlers[event]?.(...args);
    },
    localParticipant: {
      publishTrack: vi.fn(async (track, options) => {
        room.published.push({ track, options });
      }),
    },
  };
  return room;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    getItem: vi.fn((key) => (key in values ? values[key] : null)),
    setItem: vi.fn((key, value) => {
      values[key] = String(value);
    }),
    removeItem: vi.fn((key) => {
      delete values[key];
    }),
  };
}

const clock = { now: 1_000_000 };

function setup(overrides = {}) {
  const rooms = [];
  const timers = [];
  const cameraTracks = [];
  const screenTracks = [];
  let cameraAvailable = true;
  const mediaDevices = {
    getUserMedia: vi.fn(async (constraints) => {
      if (constraints.audio) {
        const track = rawTrack("audio", "mic");
        return { getAudioTracks: () => [track], getVideoTracks: () => [] };
      }
      if (!cameraAvailable) {
        const error = new Error("Device in use");
        error.name = "NotReadableError";
        throw error;
      }
      const track = rawTrack("video", `camera-${cameraTracks.length + 1}`);
      cameraTracks.push(track);
      return { getAudioTracks: () => [], getVideoTracks: () => [track] };
    }),
    getDisplayMedia: vi.fn(async () => {
      const track = rawTrack("video", `screen-${screenTracks.length + 1}`);
      screenTracks.push(track);
      return { getAudioTracks: () => [], getVideoTracks: () => [track] };
    }),
  };
  const placeholder = rawTrack("video", "placeholder");
  const deps = {
    createRoom: vi.fn((options) => {
      const room = fakeRoom();
      room.options = options;
      rooms.push(room);
      return room;
    }),
    createVideoTrack: vi.fn((raw) => localTrack(raw)),
    createAudioTrack: vi.fn((raw) => localTrack(raw)),
    getMediaDevices: () => mediaDevices,
    getPlaceholderVideoTrack: () => placeholder,
    setTimeout: vi.fn((callback, ms) => {
      timers.push({ callback, ms });
      return timers.length;
    }),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(() => 99),
    clearInterval: vi.fn(),
    window: null,
    document: null,
    fetchToken: vi.fn(async () => ({ url: "wss://livekit.test", token: `token-${rooms.length + 1}`, profile })),
    sendHeartbeat: vi.fn(async () => ({
      session: { id: 7, status: "live", stream_status: "live" },
      egress: { running: true, status: "EGRESS_ACTIVE", error: "" },
      restarted: false,
    })),
    startStream: vi.fn(async () => ({ id: 7, status: "live", stream_status: "live" })),
    storage: memoryStorage(),
    now: () => clock.now,
    sleep: vi.fn(async (ms) => {
      clock.now += ms;
    }),
    ...overrides,
  };
  const controller = new HostStudioController(deps);
  return {
    controller,
    deps,
    rooms,
    timers,
    cameraTracks,
    screenTracks,
    placeholder,
    mediaDevices,
    setCameraAvailable(value) {
      cameraAvailable = value;
    },
  };
}

describe("HostStudioController", () => {
  it("publishes the microphone and a single camera-source video track", async () => {
    const { controller, rooms } = setup();

    await controller.connect(7, HOST_SOURCE.CAMERA);

    expect(controller.getSnapshot().link).toBe(HOST_LINK.CONNECTED);
    expect(rooms).toHaveLength(1);
    const [room] = rooms;
    expect(room.options).toMatchObject({ stopLocalTrackOnUnpublish: false, disconnectOnPageLeave: false });
    expect(room.connect).toHaveBeenCalledWith("wss://livekit.test", "token-1");
    expect(room.published).toHaveLength(2);
    expect(room.published[1].options.source).toBe(Track.Source.Camera);
    expect(room.published[1].options.videoEncoding.maxBitrate).toBe(650000);
    expect(controller.isPublishing()).toBe(true);
  });

  it("switches camera to screen by replacing the media on the published track", async () => {
    const { controller, rooms, cameraTracks, screenTracks } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);

    await controller.connect(7, HOST_SOURCE.SCREEN);

    const [room] = rooms;
    expect(rooms).toHaveLength(1);
    expect(room.published).toHaveLength(2);
    const videoTrack = room.published[1].track;
    expect(videoTrack.replaceTrack).toHaveBeenCalledWith(screenTracks[0], true);
    expect(cameraTracks[0].stop).toHaveBeenCalled();
    expect(controller.getSnapshot().source).toBe(HOST_SOURCE.SCREEN);
  });

  it("falls back to the camera when the browser's Stop sharing ends the screen share", async () => {
    const { controller, rooms, screenTracks, cameraTracks } = setup();
    await controller.connect(7, HOST_SOURCE.SCREEN);
    const videoTrack = rooms[0].published[1].track;
    // LiveKit mutes a user-provided camera-source track whose media ended.
    videoTrack.isMuted = true;

    screenTracks[0].end();
    await flush();

    expect(videoTrack.replaceTrack).toHaveBeenLastCalledWith(cameraTracks[0], true);
    expect(videoTrack.unmute).toHaveBeenCalled();
    expect(rooms[0].published).toHaveLength(2);
    expect(controller.getSnapshot().source).toBe(HOST_SOURCE.CAMERA);
    expect(controller.getSnapshot().info).toMatch(/still live/);
  });

  it("keeps the track published with a blank frame when no camera is available", async () => {
    const { controller, rooms, screenTracks, placeholder, setCameraAvailable } = setup();
    await controller.connect(7, HOST_SOURCE.SCREEN);
    setCameraAvailable(false);

    screenTracks[0].end();
    await flush();

    expect(rooms[0].published[1].track.replaceTrack).toHaveBeenLastCalledWith(placeholder, true);
    expect(controller.getSnapshot().source).toBe(HOST_SOURCE.PLACEHOLDER);
    expect(controller.getSnapshot().error).toMatch(/blank screen/);
    expect(placeholder.stop).not.toHaveBeenCalled();
  });

  it("unmutes a publication that LiveKit muted after the media was already swapped", async () => {
    const { controller, rooms } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    const videoTrack = rooms[0].published[1].track;

    videoTrack.isMuted = true;
    videoTrack.emit(TrackEvent.Muted);
    await flush();

    expect(videoTrack.unmute).toHaveBeenCalled();
  });

  it("rejoins with a fresh token after an unexpected disconnect and republishes the same media", async () => {
    const { controller, rooms, timers, deps, cameraTracks } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);
    await flush();
    deps.sendHeartbeat.mockClear();

    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);

    expect(controller.getSnapshot().link).toBe(HOST_LINK.RECONNECTING);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1000);
    timers[0].callback();
    await flush();

    expect(rooms).toHaveLength(2);
    expect(deps.fetchToken).toHaveBeenCalledTimes(2);
    expect(rooms[1].connect).toHaveBeenCalledWith("wss://livekit.test", "token-2");
    expect(rooms[1].published[1].track.raw).toBe(cameraTracks[0]);
    expect(controller.getSnapshot().link).toBe(HOST_LINK.CONNECTED);
    expect(deps.sendHeartbeat).toHaveBeenCalledWith(7, { publishing: true, state: "publishing" });
  });

  it("restarts live delivery after a rejoin when the stream was marked failed meanwhile", async () => {
    const { controller, rooms, timers, deps } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);
    await flush();
    deps.sendHeartbeat.mockResolvedValue({
      session: { id: 7, status: "live", stream_status: "failed" },
      egress: null,
      restarted: false,
    });

    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.UNKNOWN_REASON);
    timers[0].callback();
    await flush();

    expect(deps.startStream).toHaveBeenCalledWith(7);
  });

  it("backs off between failed rejoin attempts", async () => {
    const { controller, rooms, timers, deps } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    deps.fetchToken.mockRejectedValueOnce(new Error("offline"));

    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);
    timers[0].callback();
    await flush();

    expect(timers).toHaveLength(2);
    expect(timers[1].ms).toBe(2000);
    expect(controller.getSnapshot().link).toBe(HOST_LINK.RECONNECTING);
  });

  it("stops instead of fighting when another tab takes over the same identity", async () => {
    const { controller, rooms, timers, cameraTracks } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);

    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.DUPLICATE_IDENTITY);

    expect(controller.getSnapshot().link).toBe(HOST_LINK.REPLACED);
    expect(controller.getSnapshot().live).toBe(false);
    expect(timers).toHaveLength(0);
    expect(cameraTracks[0].stop).toHaveBeenCalled();
  });

  it("shows LiveKit's own reconnect attempts as a reconnecting link", async () => {
    const { controller, rooms } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);

    rooms[0].emit(RoomEvent.Reconnecting);
    expect(controller.getSnapshot().link).toBe(HOST_LINK.RECONNECTING);
    expect(controller.isPublishing()).toBe(false);

    rooms[0].emit(RoomEvent.Reconnected);
    expect(controller.getSnapshot().link).toBe(HOST_LINK.CONNECTED);
  });

  it("sends heartbeats while live and stops when the stream is stopped elsewhere", async () => {
    const { controller, deps } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);

    controller.setLive(7, true);
    await flush();

    expect(deps.setInterval).toHaveBeenCalledTimes(1);
    expect(deps.sendHeartbeat).toHaveBeenCalledWith(7, { publishing: true, state: "publishing" });
    expect(controller.getSnapshot().egress).toEqual({ running: true, status: "EGRESS_ACTIVE", error: "" });

    deps.sendHeartbeat.mockResolvedValueOnce({
      session: { id: 7, status: "live", stream_status: "stopped" },
      egress: null,
      restarted: false,
    });
    await controller.heartbeatNow();

    expect(controller.getSnapshot().live).toBe(false);
    // Phase 2: the studio is still connected, so the presence heartbeat keeps
    // running (the server must not auto-end a class whose host is present).
    expect(deps.clearInterval).not.toHaveBeenCalled();
    await controller.disconnect();
    expect(deps.clearInterval).toHaveBeenCalledWith(99);
  });

  it("asks before the tab closes while live", async () => {
    const { controller } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    const event = { preventDefault: vi.fn(), returnValue: undefined };

    controller.handleBeforeUnload(event);
    expect(event.preventDefault).not.toHaveBeenCalled();

    controller.setLive(7, true);
    controller.handleBeforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe("");
  });

  it("disconnect stops all media and resets the studio", async () => {
    const { controller, rooms, cameraTracks } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);

    await controller.disconnect();

    expect(rooms[0].disconnect).toHaveBeenCalled();
    expect(cameraTracks[0].stop).toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ link: HOST_LINK.IDLE, sessionId: null, live: false });
    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
    expect(controller.getSnapshot().link).toBe(HOST_LINK.IDLE);
  });

  it("reports a denied camera without leaving a half-open room", async () => {
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    const { controller, rooms, mediaDevices } = setup();
    mediaDevices.getUserMedia.mockRejectedValueOnce(denied);

    await expect(controller.connect(7, HOST_SOURCE.CAMERA)).rejects.toThrow("denied");

    expect(rooms).toHaveLength(0);
    expect(controller.getSnapshot().link).toBe(HOST_LINK.IDLE);
    expect(controller.getSnapshot().error).toMatch(/Permission/);
  });
});

describe("HostStudioController (Phase 2: grace, async Go Live, resume)", () => {
  it("reports a reconnecting link in the heartbeat instead of 'not publishing'", async () => {
    const { controller, rooms, deps } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);
    await flush();
    deps.sendHeartbeat.mockClear();

    rooms[0].emit(RoomEvent.Reconnecting);
    await controller.heartbeatNow();

    expect(deps.sendHeartbeat).toHaveBeenCalledWith(7, { publishing: false, state: "reconnecting" });
  });

  it("reports reconnecting while its own rejoin is pending", async () => {
    const { controller, rooms, deps } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);
    await flush();
    deps.sendHeartbeat.mockClear();

    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);
    await controller.heartbeatNow();

    expect(deps.sendHeartbeat).toHaveBeenCalledWith(7, { publishing: false, state: "reconnecting" });
  });

  it("sends a presence heartbeat while connected but not live", async () => {
    const { controller, deps } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);

    expect(deps.setInterval).toHaveBeenCalledTimes(1);
    await controller.heartbeatNow();
    expect(deps.sendHeartbeat).toHaveBeenCalledWith(7, { publishing: true, state: "publishing" });
    expect(controller.getSnapshot().live).toBe(false);
  });

  it("goes live asynchronously: 202 then polls until the server reports live", async () => {
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 1000 }));
    const getGoLiveStatus = vi
      .fn()
      .mockResolvedValueOnce({ state: "starting", poll_after_ms: 1000 })
      .mockResolvedValueOnce({ state: "live", session: { id: 7, status: "live", stream_status: "live" } });
    const { controller, deps } = setup({ goLive, getGoLiveStatus });
    await controller.connect(7, HOST_SOURCE.CAMERA);

    const session = await controller.startLive(7);

    expect(goLive).toHaveBeenCalledWith(7);
    expect(getGoLiveStatus).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(1000);
    expect(session).toMatchObject({ stream_status: "live" });
    expect(controller.getSnapshot()).toMatchObject({ live: true, goingLive: false });
    expect(deps.startStream).not.toHaveBeenCalled();
  });

  it("falls back to the synchronous start when async Go Live is switched off", async () => {
    const off = Object.assign(new Error("Not Found"), { response: { status: 404 } });
    const goLive = vi.fn(async () => {
      throw off;
    });
    const { controller, deps } = setup({ goLive, getGoLiveStatus: vi.fn() });
    await controller.connect(7, HOST_SOURCE.CAMERA);

    await controller.startLive(7);

    expect(deps.startStream).toHaveBeenCalledWith(7);
    expect(controller.getSnapshot()).toMatchObject({ live: true, goingLive: false });
  });

  it("surfaces a failed Go Live and is not left 'going live'", async () => {
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 500 }));
    const getGoLiveStatus = vi.fn(async () => ({ state: "failed", error: "participant not found" }));
    const { controller } = setup({ goLive, getGoLiveStatus });
    await controller.connect(7, HOST_SOURCE.CAMERA);

    await expect(controller.startLive(7)).rejects.toThrow("participant not found");
    expect(controller.getSnapshot()).toMatchObject({ live: false, goingLive: false });
  });

  it("starts synchronously when the queued Go Live never runs (worker down)", async () => {
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 30000 }));
    const getGoLiveStatus = vi.fn(async () => ({ state: "starting", poll_after_ms: 30000 }));
    const { controller, deps } = setup({ goLive, getGoLiveStatus });
    await controller.connect(7, HOST_SOURCE.CAMERA);

    await controller.startLive(7);

    expect(getGoLiveStatus.mock.calls.length).toBeLessThanOrEqual(4);
    expect(deps.startStream).toHaveBeenCalledWith(7);
    expect(controller.getSnapshot()).toMatchObject({ live: true, goingLive: false });
  });

  it("gives up polling after the Go Live timeout when no synchronous start exists", async () => {
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 30000 }));
    const getGoLiveStatus = vi.fn(async () => ({ state: "starting", poll_after_ms: 30000 }));
    const { controller } = setup({ goLive, getGoLiveStatus, startStream: null });
    await controller.connect(7, HOST_SOURCE.CAMERA);

    await expect(controller.startLive(7)).rejects.toThrow(/longer than expected/);
    expect(getGoLiveStatus.mock.calls.length).toBeLessThanOrEqual(4);
    expect(controller.getSnapshot()).toMatchObject({ live: false, goingLive: false });
  });

  it("starts synchronously as soon as the server reports the queued job stalled", async () => {
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 1000 }));
    const getGoLiveStatus = vi.fn(async () => ({ state: "starting", stalled: true, poll_after_ms: 1000 }));
    const { controller, deps } = setup({ goLive, getGoLiveStatus });
    await controller.connect(7, HOST_SOURCE.CAMERA);

    await controller.startLive(7);

    expect(getGoLiveStatus).toHaveBeenCalledTimes(1); // no 90 s wait
    expect(deps.startStream).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ live: true, goingLive: false });
  });

  it("keeps polling when the synchronous fallback finds a worker already starting (409)", async () => {
    const busy = Object.assign(new Error("Live stream is already starting."), { response: { status: 409 } });
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 1000 }));
    const getGoLiveStatus = vi
      .fn()
      .mockResolvedValueOnce({ state: "starting", stalled: true, poll_after_ms: 1000 })
      .mockResolvedValueOnce({ state: "starting", poll_after_ms: 1000 })
      .mockResolvedValueOnce({ state: "live", session: { id: 7, status: "live", stream_status: "live" } });
    const { controller, deps } = setup({ goLive, getGoLiveStatus });
    deps.startStream.mockRejectedValueOnce(busy);
    await controller.connect(7, HOST_SOURCE.CAMERA);

    const session = await controller.startLive(7);

    expect(deps.startStream).toHaveBeenCalledTimes(1); // tried once, not in a loop
    expect(getGoLiveStatus).toHaveBeenCalledTimes(3);
    expect(session).toMatchObject({ stream_status: "live" });
    expect(controller.getSnapshot()).toMatchObject({ live: true, goingLive: false });
  });

  it("gives up after a second timeout window when the fallback is busy and nothing goes live", async () => {
    const busy = Object.assign(new Error("Live stream is already starting."), { response: { status: 409 } });
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 30000 }));
    const getGoLiveStatus = vi.fn(async () => ({ state: "starting", poll_after_ms: 30000 }));
    const { controller, deps } = setup({ goLive, getGoLiveStatus });
    deps.startStream.mockRejectedValue(busy);
    await controller.connect(7, HOST_SOURCE.CAMERA);

    await expect(controller.startLive(7)).rejects.toThrow(/longer than expected/);
    expect(deps.startStream).toHaveBeenCalledTimes(1);
    expect(getGoLiveStatus.mock.calls.length).toBeLessThanOrEqual(8);
    expect(controller.getSnapshot()).toMatchObject({ live: false, goingLive: false });
  });

  it("surfaces a non-409 error from the synchronous fallback", async () => {
    const broken = Object.assign(new Error("Unable to start live stream."), { response: { status: 400 } });
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 1000 }));
    const getGoLiveStatus = vi.fn(async () => ({ state: "starting", stalled: true, poll_after_ms: 1000 }));
    const { controller, deps } = setup({ goLive, getGoLiveStatus });
    deps.startStream.mockRejectedValueOnce(broken);
    await controller.connect(7, HOST_SOURCE.CAMERA);

    await expect(controller.startLive(7)).rejects.toThrow("Unable to start live stream.");
    expect(controller.getSnapshot()).toMatchObject({ live: false, goingLive: false });
  });

  it("cancels a Go Live that is still starting: the poll stops and the server stops the stream", async () => {
    let releasePoll;
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 1000 }));
    const getGoLiveStatus = vi.fn(
      () =>
        new Promise((resolve) => {
          releasePoll = () => resolve({ state: "starting", poll_after_ms: 1000 });
        }),
    );
    const stopStream = vi.fn(async () => ({ id: 7, status: "live", stream_status: "stopped" }));
    const { controller, deps } = setup({ goLive, getGoLiveStatus, stopStream });
    await controller.connect(7, HOST_SOURCE.CAMERA);

    const pending = controller.startLive(7);
    await vi.waitFor(() => expect(getGoLiveStatus).toHaveBeenCalledTimes(1));
    expect(controller.getSnapshot().goingLive).toBe(true);

    const stopped = await controller.cancelGoLive();
    releasePoll();

    await expect(pending).rejects.toMatchObject({ code: GO_LIVE_CANCELLED });
    expect(stopStream).toHaveBeenCalledWith(7);
    expect(stopped).toMatchObject({ stream_status: "stopped" });
    expect(getGoLiveStatus).toHaveBeenCalledTimes(1);
    expect(deps.startStream).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ live: false, goingLive: false });
    expect(await controller.cancelGoLive()).toBeNull(); // nothing left to cancel
  });

  it("does not report live when cancelled while the synchronous fallback was starting", async () => {
    let releaseStart;
    const goLive = vi.fn(async () => ({ state: "starting", poll_after_ms: 1000 }));
    const getGoLiveStatus = vi.fn(async () => ({ state: "starting", stalled: true, poll_after_ms: 1000 }));
    const stopStream = vi.fn(async () => ({ id: 7, status: "live", stream_status: "stopped" }));
    const { controller, deps } = setup({ goLive, getGoLiveStatus, stopStream });
    deps.startStream.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStart = () => resolve({ id: 7, status: "live", stream_status: "live" });
        }),
    );
    await controller.connect(7, HOST_SOURCE.CAMERA);

    const pending = controller.startLive(7);
    await vi.waitFor(() => expect(deps.startStream).toHaveBeenCalledTimes(1));
    await controller.cancelGoLive();
    releaseStart();

    await expect(pending).rejects.toMatchObject({ code: GO_LIVE_CANCELLED });
    expect(controller.getSnapshot()).toMatchObject({ live: false, goingLive: false });
  });

  it("flags failed delivery while live and resumes it with one call", async () => {
    const goLive = vi.fn(async () => ({ state: "live", session: { id: 7, status: "live", stream_status: "live" } }));
    const { controller, deps } = setup({ goLive, getGoLiveStatus: vi.fn() });
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);
    await flush();
    deps.sendHeartbeat.mockResolvedValueOnce({
      session: { id: 7, status: "live", stream_status: "failed" },
      egress: null,
      restarted: false,
    });
    await controller.heartbeatNow();
    expect(controller.getSnapshot().deliveryFailed).toBe(true);

    await controller.resumeDelivery();

    expect(goLive).toHaveBeenCalledWith(7);
    expect(controller.getSnapshot()).toMatchObject({ deliveryFailed: false, live: true });
  });

  it("after a rejoin, restarts a stream the server stopped during the grace period", async () => {
    const { controller, rooms, timers, deps } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);
    await flush();
    deps.sendHeartbeat.mockResolvedValue({
      session: { id: 7, status: "live", stream_status: "stopped" },
      egress: null,
      restarted: false,
    });
    deps.startStream.mockImplementation(async () => {
      deps.sendHeartbeat.mockResolvedValue({
        session: { id: 7, status: "live", stream_status: "live" },
        egress: { running: true, status: "EGRESS_ACTIVE", error: "" },
        restarted: false,
      });
      return { id: 7, status: "live", stream_status: "live" };
    });

    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);
    timers[0].callback();
    await flush();

    expect(deps.startStream).toHaveBeenCalledWith(7);
    expect(controller.getSnapshot().live).toBe(true);
  });

  it("does not resume a class the server ended", async () => {
    const { controller, rooms, timers, deps } = setup();
    await controller.connect(7, HOST_SOURCE.CAMERA);
    controller.setLive(7, true);
    await flush();
    deps.sendHeartbeat.mockResolvedValue({
      session: { id: 7, status: "ended", stream_status: "stopped" },
      egress: null,
      restarted: false,
    });

    rooms[0].emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);
    timers[0].callback();
    await flush();

    expect(deps.startStream).not.toHaveBeenCalled();
    expect(controller.getSnapshot().live).toBe(false);
  });

  it("remembers a live studio for a reload and forgets it on Stop", async () => {
    const storage = memoryStorage();
    const { controller } = setup({ storage });
    await controller.connect(7, HOST_SOURCE.CAMERA);

    controller.setLive(7, true);
    expect(controller.readResumeCandidate()).toMatchObject({ sessionId: 7 });

    controller.setLive(7, false);
    expect(controller.readResumeCandidate()).toBeNull();
  });

  it("resumes the broadcast after a reload: camera reconnects, heartbeat restarts delivery", async () => {
    const storage = memoryStorage({
      "alsyed.hostStudio.resume": JSON.stringify({ sessionId: 7, at: clock.now - 5_000 }),
    });
    const { controller, rooms, deps } = setup({ storage });

    const resumed = await controller.resumeAfterReload({ id: 7, status: "live", stream_status: "interrupted" });
    await flush();

    expect(resumed).toBe(true);
    expect(rooms).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({ live: true, sessionId: 7, source: HOST_SOURCE.CAMERA });
    expect(deps.sendHeartbeat).toHaveBeenCalledWith(7, { publishing: true, state: "publishing" });
    expect(deps.startStream).not.toHaveBeenCalled();
  });

  it("goes live again after a reload when the server had already failed delivery", async () => {
    const storage = memoryStorage({
      "alsyed.hostStudio.resume": JSON.stringify({ sessionId: 7, at: clock.now }),
    });
    const { controller, deps } = setup({ storage });

    await controller.resumeAfterReload({ id: 7, status: "live", stream_status: "failed" });

    expect(deps.startStream).toHaveBeenCalledWith(7);
    expect(controller.getSnapshot().live).toBe(true);
  });

  it("does not resume another session, an ended class or a stale record", async () => {
    const stale = memoryStorage({
      "alsyed.hostStudio.resume": JSON.stringify({ sessionId: 7, at: clock.now - 7 * 60 * 60 * 1000 }),
    });
    const fresh = () => memoryStorage({ "alsyed.hostStudio.resume": JSON.stringify({ sessionId: 7, at: clock.now }) });

    const a = setup({ storage: fresh() });
    expect(await a.controller.resumeAfterReload({ id: 8, status: "live", stream_status: "live" })).toBe(false);

    const ended = fresh();
    const b = setup({ storage: ended });
    expect(await b.controller.resumeAfterReload({ id: 7, status: "ended", stream_status: "stopped" })).toBe(false);
    expect(ended.values["alsyed.hostStudio.resume"]).toBeUndefined();

    const c = setup({ storage: stale });
    expect(await c.controller.resumeAfterReload({ id: 7, status: "live", stream_status: "live" })).toBe(false);
    expect(c.rooms).toHaveLength(0);
  });
});
