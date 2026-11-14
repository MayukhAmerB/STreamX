// Host Studio publishing that survives the things that used to end a class:
//
// - One video track is published once (as the camera source) and camera <->
//   screen switches swap its media with replaceTrack, so the participant
//   egress feeding Owncast never sees the video track disappear. When the
//   browser's "Stop sharing" ends a screen share, the studio falls back to the
//   camera (or a blank frame) instead of unpublishing.
// - LiveKit Reconnecting/Reconnected/Disconnected events drive a visible link
//   state; an unexpected disconnect rejoins with a fresh token and republishes
//   the same camera/microphone, with backoff. A DUPLICATE_IDENTITY disconnect
//   means another tab took over, so this tab stops instead of fighting it.
// - While live, a heartbeat lets the backend verify the LiveKit egress and
//   restart a dead one, a beforeunload prompt guards the tab, and the
//   controller is a module singleton so leaving the page inside the app does
//   not cut the broadcast (a small badge links back to the studio).
// - Phase 2: the heartbeat reports the link state (publishing | reconnecting |
//   connected) and keeps running while the studio is connected, so the server
//   holds the class through a host reconnect ("Host reconnecting..." for
//   viewers) and knows the host is present. Go Live is asynchronous (202 +
//   polling). A reload of a live studio resumes the broadcast on its own.
import {
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  getEmptyVideoStreamTrack,
} from "livekit-client";

export const HOST_LINK = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  REPLACED: "replaced",
  FAILED: "failed",
});

export const HOST_SOURCE = Object.freeze({
  CAMERA: "camera",
  SCREEN: "screen",
  PLACEHOLDER: "placeholder",
});

export const RECONNECT_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000]);
export const HEARTBEAT_INTERVAL_MS = 10000;
export const STUDIO_PATH = "/broadcasting";
export const GO_LIVE_TIMEOUT_MS = 90000;
export const GO_LIVE_CANCELLED = "go_live_cancelled";

// Thrown by startLive() when the host pressed Cancel while it was starting.
export class GoLiveCancelledError extends Error {
  constructor() {
    super("Go Live cancelled.");
    this.name = "GoLiveCancelledError";
    this.code = GO_LIVE_CANCELLED;
  }
}
export const RESUME_STORAGE_KEY = "alsyed.hostStudio.resume";
export const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Stream states a reload may resume into (anything but ended/idle).
const RESUMABLE_STREAM_STATES = new Set(["live", "interrupted", "failed", "starting", "stopped"]);

// What the heartbeat tells the server about the host's link.
export const HOST_HEARTBEAT_STATE = Object.freeze({
  PUBLISHING: "publishing",
  RECONNECTING: "reconnecting",
  CONNECTED: "connected",
});

// Disconnects that a rejoin cannot fix.
const TERMINAL_DISCONNECT_REASONS = new Set([
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.ROOM_CLOSED,
].filter((value) => value !== undefined));

const INITIAL_STATE = Object.freeze({
  sessionId: null,
  link: HOST_LINK.IDLE,
  source: HOST_SOURCE.CAMERA,
  profile: null,
  live: false,
  egress: null,
  lastSession: null,
  lastHeartbeatAt: 0,
  reconnectAttempt: 0,
  // The server reports delivery failed while this studio is live: the page
  // shows a blocking banner with a one-tap Resume.
  deliveryFailed: false,
  goingLive: false,
  error: "",
  info: "",
});

function errorMessage(error, fallback) {
  const name = String(error?.name || "");
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permission to use the camera, microphone or screen was denied.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No usable camera or microphone was found.";
  }
  if (name === "NotReadableError") {
    return "The camera or microphone is in use by another application.";
  }
  return (
    error?.response?.data?.errors?.detail ||
    error?.response?.data?.message ||
    error?.message ||
    fallback
  );
}

function safeSessionStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function defaultDeps() {
  const hasWindow = typeof window !== "undefined";
  return {
    createRoom: (options) => new Room(options),
    createVideoTrack: (mediaStreamTrack) => new LocalVideoTrack(mediaStreamTrack, undefined, true),
    createAudioTrack: (mediaStreamTrack) => new LocalAudioTrack(mediaStreamTrack, undefined, true),
    getMediaDevices: () => (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined),
    getPlaceholderVideoTrack: () => getEmptyVideoStreamTrack(),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
    window: hasWindow ? window : null,
    document: typeof document !== "undefined" ? document : null,
    storage: safeSessionStorage(),
    now: () => Date.now(),
    sleep: null,
    // Supplied by the page (API calls).
    fetchToken: null,
    sendHeartbeat: null,
    startStream: null,
    // Cancel while starting: stream/stop/ (resolves with the session row).
    stopStream: null,
    // Async Go Live: POST answers 202 {state:"starting"}; GET is the poll.
    goLive: null,
    getGoLiveStatus: null,
  };
}

function isEnded(track) {
  return !track || track.readyState === "ended";
}

export function videoConstraints(profile) {
  return {
    width: { ideal: profile.capture_width },
    height: { ideal: profile.capture_height },
    frameRate: { ideal: profile.fps, max: profile.fps },
  };
}

export class HostStudioController {
  constructor(deps = {}) {
    this.deps = { ...defaultDeps(), ...deps };
    this.state = { ...INITIAL_STATE };
    this.listeners = new Set();
    this.room = null;
    this.audioTrack = null;
    this.videoTrack = null;
    this.rawAudio = null;
    this.rawVideo = null;
    this.rawVideoIsPlaceholder = false;
    this.previewElement = null;
    this.wantConnected = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.heartbeatInFlight = null;
    this.queue = Promise.resolve();
    this.indicator = null;
    this.handleBeforeUnload = this.handleBeforeUnload.bind(this);
    this.handlePageHide = this.handlePageHide.bind(this);
    this.handleOnline = this.handleOnline.bind(this);
    this.windowListenersBound = false;
    // The Go Live in progress ({ sessionId, cancelled }), for cancelGoLive().
    this.goLiveAttempt = null;
  }

  // ---- state -------------------------------------------------------------

  configure(deps = {}) {
    Object.assign(this.deps, deps);
  }

  getSnapshot() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    this.syncDetachedIndicator();
    return () => {
      this.listeners.delete(listener);
      this.syncDetachedIndicator();
    };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => {
      try {
        listener(this.state);
      } catch {
        // A broken listener must not stop publishing.
      }
    });
    this.syncWindowListeners();
    this.syncHeartbeat();
    this.syncDetachedIndicator();
  }

  // What the heartbeat reports: "reconnecting" while LiveKit (or this
  // controller) is rejoining, so the server holds the class instead of
  // failing delivery for every viewer.
  hostLinkState() {
    if (this.isPublishing()) return HOST_HEARTBEAT_STATE.PUBLISHING;
    if (
      this.state.link === HOST_LINK.RECONNECTING ||
      this.reconnectTimer !== null ||
      (this.wantConnected && !this.room)
    ) {
      return HOST_HEARTBEAT_STATE.RECONNECTING;
    }
    return HOST_HEARTBEAT_STATE.CONNECTED;
  }

  isPublishing() {
    return Boolean(
      this.room &&
        this.state.link === HOST_LINK.CONNECTED &&
        this.videoTrack &&
        !isEnded(this.rawVideo)
    );
  }

  // Serialise connect/switch/disconnect so overlapping clicks cannot race.
  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---- media -------------------------------------------------------------

  async acquireAudio() {
    const mediaDevices = this.deps.getMediaDevices();
    if (!mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot capture a microphone.");
    }
    const stream = await mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const [track] = stream.getAudioTracks();
    if (!track) throw new Error("No microphone track available.");
    if (typeof track.addEventListener === "function") {
      track.addEventListener("ended", () => this.handleAudioEnded(track), { once: true });
    }
    return track;
  }

  async acquireVideo(source, profile) {
    const mediaDevices = this.deps.getMediaDevices();
    const constraints = videoConstraints(profile);
    let stream;
    if (source === HOST_SOURCE.SCREEN) {
      if (!mediaDevices?.getDisplayMedia) {
        throw new Error("This browser cannot share the screen.");
      }
      stream = await mediaDevices.getDisplayMedia({ video: constraints, audio: false });
    } else {
      if (!mediaDevices?.getUserMedia) {
        throw new Error("This browser cannot capture a camera.");
      }
      stream = await mediaDevices.getUserMedia({ video: { ...constraints, facingMode: "user" }, audio: false });
    }
    const [track] = stream.getVideoTracks();
    if (!track) throw new Error("No video track available from the selected source.");
    if ("contentHint" in track) {
      track.contentHint = source === HOST_SOURCE.SCREEN ? "detail" : "motion";
    }
    return track;
  }

  stopRawTrack(track, isPlaceholder = false) {
    if (!track || isPlaceholder) return;
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }

  setRawVideo(track, { placeholder = false } = {}) {
    const previous = this.rawVideo;
    const previousWasPlaceholder = this.rawVideoIsPlaceholder;
    this.rawVideo = track;
    this.rawVideoIsPlaceholder = placeholder;
    if (track && !placeholder && typeof track.addEventListener === "function") {
      track.addEventListener("ended", () => this.handleVideoEnded(track), { once: true });
    }
    this.attachPreview(this.previewElement);
    if (previous && previous !== track) {
      this.stopRawTrack(previous, previousWasPlaceholder);
    }
  }

  stopMedia() {
    this.stopRawTrack(this.rawVideo, this.rawVideoIsPlaceholder);
    this.stopRawTrack(this.rawAudio);
    this.rawVideo = null;
    this.rawVideoIsPlaceholder = false;
    this.rawAudio = null;
    this.attachPreview(this.previewElement);
  }

  attachPreview(element) {
    this.previewElement = element || null;
    if (!element) return;
    if (!this.rawVideo || typeof MediaStream === "undefined") {
      element.srcObject = null;
      return;
    }
    const current = element.srcObject;
    const currentTrack = current?.getVideoTracks?.()[0];
    if (currentTrack !== this.rawVideo) {
      element.srcObject = new MediaStream([this.rawVideo]);
    }
  }

  // LiveKit mutes a user-provided camera/microphone track when its media
  // ends. The studio swaps in new media itself, so a muted publication with
  // live media is always unwanted: unmute it, or the egress shows nothing.
  async ensureUnmuted(track, rawTrack) {
    if (!track || !track.isMuted || isEnded(rawTrack)) return;
    try {
      await track.unmute();
    } catch {
      // Track was unpublished meanwhile; the next (re)publish starts unmuted.
    }
  }

  watchMute(track, getRawTrack) {
    if (typeof track?.on !== "function") return;
    track.on(TrackEvent.Muted, () => {
      this.ensureUnmuted(track, getRawTrack());
    });
  }

  // ---- room --------------------------------------------------------------

  publishOptions() {
    const profile = this.state.profile;
    return {
      // Always the camera source: the egress follows one track whatever is shown.
      source: Track.Source.Camera,
      simulcast: false,
      videoEncoding: {
        maxBitrate: profile.max_video_bitrate_kbps * 1000,
        maxFramerate: profile.fps,
      },
      degradationPreference: "maintain-resolution",
    };
  }

  bindRoom(room) {
    const isCurrent = () => this.room === room;
    const onReconnecting = () => {
      if (!isCurrent()) return;
      this.setState({ link: HOST_LINK.RECONNECTING, info: "Connection lost. Reconnecting..." });
    };
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.SignalReconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, () => {
      if (!isCurrent()) return;
      this.setState({ link: HOST_LINK.CONNECTED, error: "", info: "Reconnected. Your broadcast continued." });
      this.afterReconnect();
    });
    room.on(RoomEvent.Disconnected, (reason) => this.handleDisconnected(room, reason));
  }

  async openRoom(tokenData) {
    const room = this.deps.createRoom({
      adaptiveStream: false,
      dynacast: false,
      // The studio owns its camera/mic so it can republish them after a rejoin.
      stopLocalTrackOnUnpublish: false,
      // beforeunload is handled here (with a confirm) and pagehide disconnects.
      disconnectOnPageLeave: false,
    });
    this.bindRoom(room);
    this.room = room;
    try {
      await room.connect(tokenData.url, tokenData.token);
      if (this.room !== room) throw new Error("Studio connection was replaced.");
      this.audioTrack = this.deps.createAudioTrack(this.rawAudio);
      this.watchMute(this.audioTrack, () => this.rawAudio);
      await room.localParticipant.publishTrack(this.audioTrack, { source: Track.Source.Microphone });
      this.videoTrack = this.deps.createVideoTrack(this.rawVideo);
      this.watchMute(this.videoTrack, () => this.rawVideo);
      await room.localParticipant.publishTrack(this.videoTrack, this.publishOptions());
    } catch (error) {
      if (this.room === room) {
        this.room = null;
        this.audioTrack = null;
        this.videoTrack = null;
      }
      try {
        await room.disconnect(false);
      } catch {
        // already closed
      }
      throw error;
    }
  }

  handleDisconnected(room, reason) {
    if (room !== this.room) return;
    this.room = null;
    this.audioTrack = null;
    this.videoTrack = null;
    if (!this.wantConnected) return;

    if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
      this.wantConnected = false;
      this.stopHeartbeat();
      this.stopMedia();
      this.setState({
        link: HOST_LINK.REPLACED,
        live: false,
        error:
          "This Host Studio was opened in another tab or device, which took over the broadcast. " +
          "This tab stopped sending video.",
        info: "",
      });
      return;
    }
    if (TERMINAL_DISCONNECT_REASONS.has(reason)) {
      this.wantConnected = false;
      this.stopHeartbeat();
      this.stopMedia();
      this.setState({
        link: HOST_LINK.FAILED,
        live: false,
        error: "The live room was closed or you were removed from it. Reconnect to continue.",
        info: "",
      });
      return;
    }
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (!this.wantConnected || this.reconnectTimer !== null) return;
    const attempt = this.state.reconnectAttempt;
    const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.setState({
      link: HOST_LINK.RECONNECTING,
      reconnectAttempt: attempt + 1,
      info: `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`,
    });
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = null;
      this.enqueue(() => this.reconnectNow()).catch(() => this.scheduleReconnect());
    }, delay);
  }

  cancelReconnect() {
    if (this.reconnectTimer !== null) {
      this.deps.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async reconnectNow() {
    if (!this.wantConnected || this.room) return;
    const sessionId = this.state.sessionId;
    const tokenData = await this.deps.fetchToken(sessionId);
    if (!this.wantConnected || this.state.sessionId !== sessionId) return;
    if (tokenData.profile) this.setState({ profile: tokenData.profile });
    if (isEnded(this.rawAudio)) {
      this.rawAudio = await this.acquireAudio();
    }
    if (isEnded(this.rawVideo)) {
      await this.replaceVideoWithFallback();
    }
    await this.openRoom(tokenData);
    this.setState({
      link: HOST_LINK.CONNECTED,
      reconnectAttempt: 0,
      error: "",
      info: "Reconnected. Your broadcast resumed.",
    });
    await this.afterReconnect();
  }

  async afterReconnect() {
    if (!this.state.live) return;
    // The egress may have ended while we were away: the heartbeat (and the
    // server's live reconciler) restart a dead one. A stream the server marked
    // failed, or stopped after the reconnect grace period, is started again
    // because this studio never pressed Stop.
    const sessionId = this.state.sessionId;
    const data = await this.heartbeatNow({ fromReconnect: true });
    const streamStatus = String(data?.session?.stream_status || "").toLowerCase();
    const sessionStatus = String(data?.session?.status || "").toLowerCase();
    // A timer heartbeat already in flight may have seen "stopped" and cleared
    // `live`; this studio was live before the drop, so it still resumes.
    if (!data?.session || sessionStatus === "ended" || !this.wantConnected || this.state.sessionId !== sessionId) {
      return;
    }
    if (streamStatus === "failed" || streamStatus === "stopped") {
      try {
        await this.startLive(this.state.sessionId);
      } catch (error) {
        this.setState({ error: errorMessage(error, "Live delivery could not be restarted. Press Start Live.") });
      }
    }
  }

  // ---- public actions ----------------------------------------------------

  connect(sessionId, source = HOST_SOURCE.CAMERA) {
    return this.enqueue(() => this.connectNow(sessionId, source));
  }

  async connectNow(sessionId, source) {
    if (!this.deps.fetchToken) throw new Error("Host Studio is not configured.");
    if (this.state.sessionId !== null && this.state.sessionId !== sessionId) {
      await this.disconnectNow();
    }
    if (this.room && this.state.sessionId === sessionId) {
      await this.switchSourceNow(source);
      return;
    }
    this.cancelReconnect();
    this.wantConnected = true;
    const label = source === HOST_SOURCE.SCREEN ? "screen share" : "camera";
    this.setState({
      sessionId,
      link: HOST_LINK.CONNECTING,
      reconnectAttempt: 0,
      error: "",
      info: `Connecting ${label}...`,
    });
    try {
      const tokenData = await this.deps.fetchToken(sessionId);
      this.setState({ profile: tokenData.profile });
      const rawVideo = await this.acquireVideo(source, tokenData.profile);
      this.setRawVideo(rawVideo);
      if (isEnded(this.rawAudio)) {
        this.rawAudio = await this.acquireAudio();
      }
      await this.openRoom(tokenData);
      this.setState({ link: HOST_LINK.CONNECTED, source, error: "", info: "" });
    } catch (error) {
      if (!this.room) {
        this.wantConnected = false;
        this.stopMedia();
        this.setState({
          link: HOST_LINK.IDLE,
          sessionId: this.state.live ? sessionId : null,
          error: errorMessage(error, "Unable to start browser publishing."),
          info: "",
        });
      }
      throw error;
    }
  }

  switchSource(source) {
    return this.enqueue(() => this.switchSourceNow(source));
  }

  async switchSourceNow(source) {
    const rawVideo = await this.acquireVideo(source, this.state.profile);
    if (this.videoTrack) {
      await this.videoTrack.replaceTrack(rawVideo, true);
    }
    this.setRawVideo(rawVideo);
    await this.ensureUnmuted(this.videoTrack, rawVideo);
    this.setState({
      source,
      error: "",
      info: source === HOST_SOURCE.SCREEN ? "Now sharing your screen." : "Now showing your camera.",
    });
  }

  async replaceVideoWithFallback() {
    let nextSource = HOST_SOURCE.CAMERA;
    let next;
    try {
      next = await this.acquireVideo(HOST_SOURCE.CAMERA, this.state.profile);
    } catch {
      next = this.deps.getPlaceholderVideoTrack();
      nextSource = HOST_SOURCE.PLACEHOLDER;
    }
    if (this.videoTrack) await this.videoTrack.replaceTrack(next, true);
    this.setRawVideo(next, { placeholder: nextSource === HOST_SOURCE.PLACEHOLDER });
    await this.ensureUnmuted(this.videoTrack, next);
    return nextSource;
  }

  handleAudioEnded(track) {
    if (track !== this.rawAudio || !this.wantConnected) return;
    this.enqueue(async () => {
      if (track !== this.rawAudio || !this.wantConnected) return;
      try {
        const microphone = await this.acquireAudio();
        if (this.audioTrack) await this.audioTrack.replaceTrack(microphone, true);
        this.rawAudio = microphone;
        await this.ensureUnmuted(this.audioTrack, microphone);
        this.setState({ info: "The microphone reconnected." });
      } catch (error) {
        this.setState({
          error: `The microphone stopped: ${errorMessage(error, "reconnect it and press Connect Camera.")}`,
        });
      }
    }).catch(() => {});
  }

  handleVideoEnded(track) {
    if (track !== this.rawVideo || !this.wantConnected) return;
    const wasScreen = this.state.source === HOST_SOURCE.SCREEN;
    this.enqueue(async () => {
      if (track !== this.rawVideo || !this.wantConnected) return;
      const nextSource = await this.replaceVideoWithFallback();
      if (nextSource === HOST_SOURCE.CAMERA) {
        this.setState({
          source: HOST_SOURCE.CAMERA,
          error: "",
          info: wasScreen
            ? "Screen sharing ended. Switched back to your camera; you are still live."
            : "The camera restarted.",
        });
      } else {
        this.setState({
          source: HOST_SOURCE.PLACEHOLDER,
          info: "",
          error:
            "Your video source stopped and the camera is unavailable. Viewers still hear you but see a " +
            "blank screen. Connect the camera or share your screen to continue.",
        });
      }
    }).catch(() => {});
  }

  disconnect() {
    return this.enqueue(() => this.disconnectNow());
  }

  async disconnectNow() {
    this.wantConnected = false;
    this.cancelReconnect();
    this.stopHeartbeat();
    this.clearResume();
    const room = this.room;
    this.room = null;
    this.audioTrack = null;
    this.videoTrack = null;
    if (room) {
      try {
        await room.disconnect(false);
      } catch {
        // already closed
      }
    }
    this.stopMedia();
    this.setState({ ...INITIAL_STATE });
  }

  // ---- live state + heartbeat -------------------------------------------

  setLive(sessionId, live) {
    if (live) {
      if (this.state.sessionId !== null && this.state.sessionId !== sessionId) return;
      this.setState({ live: true, sessionId });
      this.persistResume(sessionId);
      this.startHeartbeat();
      this.heartbeatNow();
    } else if (this.state.sessionId === sessionId || sessionId === undefined) {
      this.clearResume();
      // The heartbeat keeps running as a presence signal while the studio is
      // still connected; syncHeartbeat (in setState) stops it otherwise.
      this.setState({ live: false, egress: null, deliveryFailed: false });
    }
  }

  // ---- async Go Live ------------------------------------------------------

  sleep(ms) {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => {
      this.deps.setTimeout(resolve, ms);
    });
  }

  // Go Live without holding a request open on LiveKit: POST answers 202 and
  // the studio polls until the server reports live (or failed).
  async startLiveSynchronously(sessionId) {
    if (!this.deps.startStream) throw new Error("Host Studio is not configured.");
    const session = await this.deps.startStream(sessionId);
    this.setLive(sessionId, true);
    if (session) this.setState({ lastSession: session, deliveryFailed: false });
    return session;
  }

  // Bounded: the poll ends live, failed, cancelled or after GO_LIVE_TIMEOUT_MS.
  // When the server reports the queued job stalled (no worker picked it up)
  // or the wait runs out, the studio starts the egress on the request path
  // (stream/start/) once; a 409 there means a worker took the job meanwhile,
  // so the studio keeps polling for one more timeout window.
  async startLive(sessionId) {
    if (!this.deps.goLive || !this.deps.getGoLiveStatus) {
      return this.startLiveSynchronously(sessionId);
    }
    const attempt = { sessionId, cancelled: false };
    this.goLiveAttempt = attempt;
    this.setState({ goingLive: true, error: "", deliveryFailed: false });
    const throwIfCancelled = () => {
      if (attempt.cancelled) throw new GoLiveCancelledError();
    };
    try {
      let deadline = this.deps.now() + GO_LIVE_TIMEOUT_MS;
      let triedSynchronous = false;
      let data;
      try {
        data = await this.deps.goLive(sessionId);
      } catch (error) {
        // Async Go Live switched off (or an older backend): use stream/start/.
        const status = Number(error?.response?.status || 0);
        if (status === 404 || status === 405) return await this.startLiveSynchronously(sessionId);
        throw error;
      }
      throwIfCancelled();
      while (data && (data.state === "starting" || data.state === "queued")) {
        const timedOut = this.deps.now() > deadline;
        if ((data.stalled || timedOut) && !triedSynchronous && this.deps.startStream) {
          // The queued job is not running (worker down or backlogged): start
          // the egress on the request path instead of leaving the host stuck.
          triedSynchronous = true;
          try {
            const session = await this.startLiveSynchronously(sessionId);
            if (attempt.cancelled) {
              this.setLive(sessionId, false);
              throw new GoLiveCancelledError();
            }
            return session;
          } catch (error) {
            if (Number(error?.response?.status || 0) !== 409) throw error;
            deadline = this.deps.now() + GO_LIVE_TIMEOUT_MS;
          }
        } else if (timedOut) {
          throw new Error("Going live is taking longer than expected. Check your connection and press Go Live again.");
        }
        await this.sleep(Math.max(250, Number(data.poll_after_ms) || 1000));
        throwIfCancelled();
        data = await this.deps.getGoLiveStatus(sessionId);
        throwIfCancelled();
      }
      if (data?.session) this.setState({ lastSession: data.session });
      if (data?.state === "live") {
        this.setLive(sessionId, true);
        return data.session || null;
      }
      throw new Error(data?.error || "The live stream could not start. Press Go Live again.");
    } finally {
      if (this.goLiveAttempt === attempt) this.goLiveAttempt = null;
      this.setState({ goingLive: false });
    }
  }

  // Cancel a Go Live that is still starting: the poll stops and the server
  // stops the stream (starting -> stopped), so a queued job starts nothing.
  // Resolves with the stopped session row (or null when nothing was starting).
  async cancelGoLive() {
    const attempt = this.goLiveAttempt;
    if (!attempt) return null;
    attempt.cancelled = true;
    if (!this.deps.stopStream) return null;
    const session = await this.deps.stopStream(attempt.sessionId);
    if (session) this.setState({ lastSession: session });
    return session || null;
  }

  // One-tap "Resume broadcast" after the server marked delivery failed.
  resumeDelivery() {
    const sessionId = this.state.sessionId;
    if (sessionId === null) return Promise.resolve(null);
    return this.startLive(sessionId);
  }

  // ---- resume after a reload ----------------------------------------------

  persistResume(sessionId) {
    try {
      this.deps.storage?.setItem(RESUME_STORAGE_KEY, JSON.stringify({ sessionId, at: this.deps.now() }));
    } catch {
      // Storage unavailable (private mode): resume just will not happen.
    }
  }

  clearResume() {
    try {
      this.deps.storage?.removeItem(RESUME_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  readResumeCandidate() {
    try {
      const raw = this.deps.storage?.getItem(RESUME_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.sessionId === undefined || parsed.sessionId === null) return null;
      if (this.deps.now() - Number(parsed.at || 0) > RESUME_MAX_AGE_MS) {
        this.clearResume();
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  // Called by the studio page after a reload with the session row it loaded.
  // Reconnects the camera (a screen share needs a click) and resumes the
  // broadcast this tab was publishing before the reload.
  async resumeAfterReload(session) {
    const candidate = this.readResumeCandidate();
    if (!candidate || !session || String(candidate.sessionId) !== String(session.id)) return false;
    if (this.room) return false;
    const status = String(session.status || "").toLowerCase();
    const streamStatus = String(session.stream_status || "").toLowerCase();
    if (status !== "live" || !RESUMABLE_STREAM_STATES.has(streamStatus)) {
      this.clearResume();
      return false;
    }
    await this.connect(session.id, HOST_SOURCE.CAMERA);
    if (streamStatus === "live" || streamStatus === "interrupted") {
      // The heartbeat (publishing) lets the server restart the egress.
      this.setLive(session.id, true);
    } else {
      await this.startLive(session.id);
    }
    this.setState({
      info: "The page reloaded while you were live. Your camera reconnected and the broadcast resumed.",
    });
    return true;
  }

  // Presence heartbeat: while live, and while the studio is connected to a
  // session (so the server knows the host is still there during a pause).
  syncHeartbeat() {
    const shouldRun =
      Boolean(this.deps.sendHeartbeat) &&
      this.state.sessionId !== null &&
      (this.state.live || this.wantConnected);
    if (shouldRun) this.startHeartbeat();
    else this.stopHeartbeat();
  }

  startHeartbeat() {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = this.deps.setInterval(() => {
      this.heartbeatNow();
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      this.deps.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  heartbeatNow({ fromReconnect = false } = {}) {
    if (
      this.state.sessionId === null ||
      !this.deps.sendHeartbeat ||
      !(this.state.live || this.wantConnected)
    ) {
      return Promise.resolve(null);
    }
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    const sessionId = this.state.sessionId;
    this.heartbeatInFlight = (async () => {
      try {
        const publishing = this.isPublishing();
        const data = await this.deps.sendHeartbeat(sessionId, {
          publishing,
          state: this.hostLinkState(),
        });
        if (!data || this.state.sessionId !== sessionId) return data;
        const session = data.session || null;
        const status = String(session?.status || "").toLowerCase();
        const streamStatus = String(session?.stream_status || "").toLowerCase();
        const patch = {
          egress: data.egress ?? null,
          lastSession: session,
          lastHeartbeatAt: this.deps.now(),
          deliveryFailed: Boolean(this.state.live && streamStatus === "failed"),
        };
        if (data.restarted) {
          patch.info = "Live delivery had stopped and was restarted automatically.";
        }
        this.setState(patch);
        if (status === "ended") {
          this.setLive(sessionId, false);
        } else if (
          streamStatus === "stopped" &&
          !fromReconnect &&
          this.state.live &&
          this.state.link === HOST_LINK.CONNECTED
        ) {
          // Stopped from another tab or by an admin while this studio was
          // connected. (After a reconnect, afterReconnect resumes instead.)
          this.setLive(sessionId, false);
        }
        return data;
      } catch {
        return null;
      } finally {
        this.heartbeatInFlight = null;
      }
    })();
    return this.heartbeatInFlight;
  }

  // ---- window integration -----------------------------------------------

  shouldGuardUnload() {
    return Boolean(this.state.live && this.wantConnected);
  }

  handleBeforeUnload(event) {
    if (!this.shouldGuardUnload()) return undefined;
    event.preventDefault();
    // Legacy browsers need returnValue set to show the prompt.
    event.returnValue = "";
    return "";
  }

  handlePageHide() {
    const room = this.room;
    if (!room) return;
    this.wantConnected = false;
    this.room = null;
    try {
      room.disconnect(true);
    } catch {
      // page is going away
    }
  }

  handleOnline() {
    if (this.reconnectTimer === null || !this.wantConnected) return;
    this.cancelReconnect();
    this.enqueue(() => this.reconnectNow()).catch(() => this.scheduleReconnect());
  }

  syncWindowListeners() {
    const win = this.deps.window;
    if (!win) return;
    const shouldBind = this.wantConnected || this.state.live;
    if (shouldBind && !this.windowListenersBound) {
      win.addEventListener("beforeunload", this.handleBeforeUnload);
      win.addEventListener("pagehide", this.handlePageHide);
      win.addEventListener("online", this.handleOnline);
      this.windowListenersBound = true;
    } else if (!shouldBind && this.windowListenersBound) {
      win.removeEventListener("beforeunload", this.handleBeforeUnload);
      win.removeEventListener("pagehide", this.handlePageHide);
      win.removeEventListener("online", this.handleOnline);
      this.windowListenersBound = false;
    }
  }

  // While live with no studio page on screen, show a small badge so the host
  // knows the broadcast is still running and can get back to it.
  syncDetachedIndicator() {
    const doc = this.deps.document;
    const win = this.deps.window;
    if (!doc?.body) return;
    const shouldShow = this.state.live && this.listeners.size === 0;
    if (!shouldShow) {
      if (this.indicator) {
        this.indicator.remove();
        this.indicator = null;
      }
      return;
    }
    if (!this.indicator) {
      const link = doc.createElement("a");
      link.href = STUDIO_PATH;
      link.setAttribute("role", "status");
      // Stable hook for the app shell, which lifts the badge above the phone tab bar.
      link.setAttribute("data-host-live-badge", "");
      link.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;align-items:center;gap:8px;" +
        "padding:10px 14px;border-radius:9999px;background:#7f1d1d;color:#fff;font:600 13px/1.2 system-ui,sans-serif;" +
        "text-decoration:none;box-shadow:0 10px 30px rgba(0,0,0,0.45);";
      link.addEventListener("click", (event) => {
        if (!win?.history?.pushState) return;
        event.preventDefault();
        // Let React Router render the studio without a full reload (a reload ends the broadcast).
        win.history.pushState({}, "", STUDIO_PATH);
        if (typeof PopStateEvent === "function") {
          win.dispatchEvent(new PopStateEvent("popstate"));
        }
      });
      doc.body.appendChild(link);
      this.indicator = link;
    }
    const reconnecting = this.state.link === HOST_LINK.RECONNECTING;
    this.indicator.textContent = reconnecting
      ? "● Live: reconnecting... Return to Host Studio"
      : "● You are live. Return to Host Studio";
  }
}

let sharedController = null;

export function getHostStudioController() {
  if (!sharedController) {
    sharedController = new HostStudioController();
  }
  return sharedController;
}
