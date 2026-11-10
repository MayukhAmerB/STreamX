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
    // Supplied by the page (API calls).
    fetchToken: null,
    sendHeartbeat: null,
    startStream: null,
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
    this.syncDetachedIndicator();
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
    // The egress may have ended while we were away: the heartbeat restarts a
    // dead one, and Start Live revives a stream already marked failed.
    const data = await this.heartbeatNow();
    const streamStatus = String(data?.session?.stream_status || "").toLowerCase();
    if (!this.state.live || !this.deps.startStream || !data?.session) return;
    if (streamStatus === "failed") {
      try {
        const session = await this.deps.startStream(this.state.sessionId);
        if (session) this.setState({ lastSession: session, error: "" });
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
      this.startHeartbeat();
      this.heartbeatNow();
    } else if (this.state.sessionId === sessionId || sessionId === undefined) {
      this.stopHeartbeat();
      this.setState({ live: false, egress: null });
    }
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

  heartbeatNow() {
    if (!this.state.live || this.state.sessionId === null || !this.deps.sendHeartbeat) {
      return Promise.resolve(null);
    }
    if (this.heartbeatInFlight) return this.heartbeatInFlight;
    const sessionId = this.state.sessionId;
    this.heartbeatInFlight = (async () => {
      try {
        const data = await this.deps.sendHeartbeat(sessionId, { publishing: this.isPublishing() });
        if (!data || this.state.sessionId !== sessionId) return data;
        const session = data.session || null;
        const patch = { egress: data.egress ?? null, lastSession: session, lastHeartbeatAt: Date.now() };
        if (data.restarted) {
          patch.info = "Live delivery had stopped and was restarted automatically.";
        }
        this.setState(patch);
        const status = String(session?.status || "").toLowerCase();
        const streamStatus = String(session?.stream_status || "").toLowerCase();
        if (status === "ended" || streamStatus === "stopped") {
          // Stopped from another tab or by an admin.
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
