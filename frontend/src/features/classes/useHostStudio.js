// Host studio controller wiring (moved from the old BroadcastingPage without
// behaviour change). Publishing lives in a module-level controller so it
// survives this page unmounting mid-class; the page only renders its state.
// OWNER: WS-D1.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getRealtimeGoLiveStatus,
  getRealtimeHostToken,
  getRealtimePreflight,
  getRealtimeSession,
  goLiveRealtimeStream,
  startRealtimeStream,
  stopRealtimeStream,
} from "../../api/realtime";
import { sendRealtimeStreamHeartbeat } from "../../api/realtimeLive";
import {
  GO_LIVE_CANCELLED,
  HOST_LINK,
  HOST_SOURCE,
  getHostStudioController,
} from "../../services/realtime/hostStudioController";
import { apiData, apiMessage } from "../../utils/api";
import {
  OBS_START_INFO_MESSAGE,
  confirmCopy,
  defaultBroadcastProfile,
  defaultBroadcastSource,
  isObsStreamMode,
  normalizeBroadcastProfile,
  normalizedStreamStatus,
} from "./classesModel";

const STUDIO_REFRESH_MS = 8000;

export default function useHostStudio({ session, onSession, confirm, onWentLive }) {
  const studioController = useMemo(() => getHostStudioController(), []);
  const [studioLink, setStudioLink] = useState(() => studioController.getSnapshot());
  const [studioState, setStudioState] = useState({ actionLoading: false, error: "", info: "" });
  const [preflight, setPreflight] = useState(null);
  const sessionId = session?.id ?? null;
  const obsMode = isObsStreamMode(session);

  const linked = Boolean(sessionId) && studioLink.sessionId === sessionId;
  const connected = linked && [HOST_LINK.CONNECTED, HOST_LINK.RECONNECTING].includes(studioLink.link);
  const connecting = linked && studioLink.link === HOST_LINK.CONNECTING;
  const profile = (linked && studioLink.profile) || defaultBroadcastProfile;
  const videoSource = linked ? studioLink.source : defaultBroadcastSource;

  const attachPreview = useCallback((element) => studioController.attachPreview(element), [studioController]);

  // Configure the controller and follow its state for as long as the studio is on screen.
  useEffect(() => {
    studioController.configure({
      fetchToken: async (id) => {
        const tokenData = apiData(await getRealtimeHostToken(id), {});
        if (!tokenData.token || !tokenData.livekit_url) {
          throw new Error("Browser publishing is not available for this session.");
        }
        return {
          url: tokenData.livekit_url,
          token: tokenData.token,
          profile: normalizeBroadcastProfile(tokenData.broadcast_profile || {}),
        };
      },
      sendHeartbeat: (id, payload) => sendRealtimeStreamHeartbeat(id, payload),
      startStream: async (id) => apiData(await startRealtimeStream(id), null),
      // Cancel while Go Live is still starting.
      stopStream: async (id) => apiData(await stopRealtimeStream(id), null),
      // Phase 2: Go Live answers 202 and the studio polls until live.
      goLive: (id) => goLiveRealtimeStream(id),
      getGoLiveStatus: (id) => getRealtimeGoLiveStatus(id),
    });
    const unsubscribe = studioController.subscribe(setStudioLink);
    return () => {
      unsubscribe();
      // Leaving the page must not cut a live class: the controller keeps
      // publishing (with a badge linking back) until Stop Live or Disconnect.
      if (!studioController.getSnapshot().live) studioController.disconnect();
    };
  }, [studioController]);

  // Opening an OBS class releases a browser connection that is not live
  // (the old "Open Host Studio" did the same).
  useEffect(() => {
    if (!sessionId || !obsMode) return;
    if (!studioController.getSnapshot().live) studioController.disconnect();
  }, [sessionId, obsMode, studioController]);

  // The page reloaded while this tab was live: resume this class's broadcast
  // (camera; a screen share needs a click).
  useEffect(() => {
    if (!sessionId || obsMode || studioController.getSnapshot().sessionId !== null) return undefined;
    const candidate = studioController.readResumeCandidate();
    if (!candidate || String(candidate.sessionId) !== String(sessionId)) return undefined;
    let cancelled = false;
    getRealtimeSession(sessionId)
      .then(async (response) => {
        const latest = apiData(response, null);
        if (cancelled || !latest) return;
        try {
          await studioController.resumeAfterReload(latest);
        } catch (err) {
          setStudioState((prev) => ({
            ...prev,
            error: apiMessage(err, "The broadcast could not resume on its own. Connect your camera and Go Live."),
          }));
        }
      })
      .catch(() => studioController.clearResume());
    return () => {
      cancelled = true;
    };
  }, [sessionId, obsMode, studioController]);

  // Phase 2: latest pre-class readiness probe (instructors and admins).
  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    getRealtimePreflight()
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch(() => {
        // Optional notice only; never blocks going live.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Heartbeats carry the latest session row (stream status, egress errors).
  useEffect(() => {
    const latest = studioLink.lastSession;
    if (latest?.id && latest.id === sessionId) onSession(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow heartbeat rows only
  }, [studioLink.lastSession]);

  // Refresh the class every 8 s. OBS classes: the open studio tells the
  // server the host is present, so a paused class (OBS stopped for a break)
  // is never auto-ended as abandoned.
  const obsPresence = Boolean(sessionId && obsMode && session?.status !== "ended");
  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    const refresh = async () => {
      if (obsPresence) sendRealtimeStreamHeartbeat(sessionId, { state: "connected", publishing: false }).catch(() => {});
      try {
        const latest = apiData(await getRealtimeSession(sessionId), null);
        if (latest && !cancelled) onSession(latest);
      } catch {
        // retain current studio state during transient refresh failures
      }
    };
    refresh();
    const intervalId = window.setInterval(refresh, STUDIO_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSession is a state setter wrapper
  }, [sessionId, obsPresence]);

  const disconnect = async ({ confirmIfLive = false } = {}) => {
    if (confirmIfLive && studioController.getSnapshot().live) {
      const ok = await confirm({
        title: "Disconnect while live?",
        objectName: session?.title,
        body: "Disconnecting stops your video and audio for every viewer.",
        confirmLabel: "Disconnect",
        danger: true,
      });
      if (!ok) return;
    }
    await studioController.disconnect();
  };

  const connectSource = async (source = defaultBroadcastSource) => {
    if (!session) return;
    if (obsMode) {
      setStudioState((prev) => ({
        ...prev,
        actionLoading: false,
        error: "",
        info: "OBS mode is active. Publish from OBS using the server URL and stream key below.",
      }));
      return;
    }
    const nextSource = source === "screen" ? HOST_SOURCE.SCREEN : HOST_SOURCE.CAMERA;
    const sourceLabel = nextSource === HOST_SOURCE.SCREEN ? "Screen share" : "Camera";
    const current = studioController.getSnapshot();
    if (current.live && current.sessionId !== sessionId) {
      const ok = await confirm({
        title: "You are live in another broadcast",
        objectName: session.title,
        body: "Connecting here stops your video and audio in that broadcast.",
        confirmLabel: "Connect here",
        danger: true,
      });
      if (!ok) return;
    }
    setStudioState((prev) => ({ ...prev, error: "", info: "" }));
    try {
      await studioController.connect(sessionId, nextSource);
      const active = studioController.getSnapshot().profile || defaultBroadcastProfile;
      const alreadyLive = normalizedStreamStatus(session) === "live";
      if (alreadyLive) {
        // Rejoining a class that is still marked live (e.g. after a reload): the
        // heartbeat verifies the egress and restarts it for this connection.
        studioController.setLive(sessionId, true);
      }
      setStudioState((prev) => ({
        ...prev,
        error: "",
        info: alreadyLive
          ? `${sourceLabel} connected. This class is live: delivery to viewers is being checked and resumed.`
          : `${sourceLabel} connected (${active.capture_width}x${active.capture_height} @ ${active.fps}fps, ${active.max_video_bitrate_kbps}kbps). Press Go Live to begin streaming. You can switch between camera and screen while live.`,
      }));
    } catch (err) {
      const snapshot = studioController.getSnapshot();
      const stillPublishing = snapshot.sessionId === sessionId && snapshot.link === HOST_LINK.CONNECTED;
      // The studio status already shows its own error while linked to this session.
      const shownByStudio = snapshot.sessionId === sessionId && !stillPublishing && Boolean(snapshot.error);
      let message = apiMessage(err, "Unable to access selected media source for browser publishing.");
      if (nextSource === HOST_SOURCE.SCREEN && err?.name === "NotAllowedError") {
        message = stillPublishing
          ? "Screen sharing was cancelled. Your previous source is still being broadcast."
          : "Screen sharing was cancelled or blocked by the browser.";
      } else if (!stillPublishing && snapshot.error) {
        message = snapshot.error;
      }
      setStudioState((prev) => ({ ...prev, error: shownByStudio ? "" : message, info: "" }));
    }
  };

  const startLive = async () => {
    if (!session) return;
    if (!obsMode && !connected) {
      setStudioState((prev) => ({ ...prev, error: "Connect camera or screen share first before starting live." }));
      return;
    }
    const wasLive = normalizedStreamStatus(session) === "live";
    setStudioState((prev) => ({
      ...prev,
      actionLoading: true,
      error: "",
      info: wasLive ? "Checking live delivery..." : "Starting live stream...",
    }));
    try {
      let response = null;
      let updated = null;
      if (obsMode) {
        response = await startRealtimeStream(sessionId);
        updated = apiData(response, null);
      } else {
        // Phase 2: asynchronous Go Live (202 + polling) inside the controller.
        updated = await studioController.startLive(sessionId);
      }
      if (updated) onSession(updated);
      const serverMessage = String(response?.data?.message || "").trim();
      setStudioState((prev) => ({
        ...prev,
        actionLoading: false,
        error: "",
        info: obsMode
          ? serverMessage.toLowerCase().includes("already live")
            ? "OBS is already live. Nothing needed to change."
            : OBS_START_INFO_MESSAGE
          : wasLive
            ? serverMessage || "Live delivery checked."
            : "You are live. Viewers can watch from the broadcast player.",
      }));
      if (!obsMode && !wasLive) await onWentLive?.(sessionId);
    } catch (err) {
      if (err?.code === GO_LIVE_CANCELLED) {
        setStudioState((prev) => ({ ...prev, actionLoading: false, error: "", info: "Go Live cancelled. Press Go Live when you are ready." }));
        return;
      }
      setStudioState((prev) => ({ ...prev, actionLoading: false, error: apiMessage(err, "Unable to start live stream."), info: "" }));
    }
  };

  // Stop a Go Live that is still starting (the server stops the queued start).
  const cancelGoLive = async () => {
    try {
      const stopped = await studioController.cancelGoLive();
      if (stopped) onSession(stopped);
    } catch (err) {
      setStudioState((prev) => ({ ...prev, error: apiMessage(err, "Unable to cancel Go Live. Press Stop Live.") }));
    }
  };

  const resumeDelivery = async () => {
    setStudioState((prev) => ({ ...prev, error: "", info: "Resuming the broadcast..." }));
    try {
      const updated = await studioController.resumeDelivery();
      if (updated) onSession(updated);
      setStudioState((prev) => ({ ...prev, info: "The broadcast resumed. Viewers are reconnecting." }));
    } catch (err) {
      if (err?.code === GO_LIVE_CANCELLED) {
        setStudioState((prev) => ({ ...prev, error: "", info: "Resume cancelled." }));
        return;
      }
      setStudioState((prev) => ({
        ...prev,
        info: "",
        error: apiMessage(err, "The broadcast could not resume. Check your connection and try again."),
      }));
    }
  };

  const stopLive = async ({ afterStop } = {}) => {
    if (!session) return;
    if (!(await confirm(confirmCopy("stop-live", session)))) return;
    setStudioState((prev) => ({ ...prev, actionLoading: true, error: "", info: "Stopping live stream..." }));
    try {
      const updated = apiData(await stopRealtimeStream(sessionId), null);
      studioController.setLive(sessionId, false);
      if (updated) onSession(updated);
      afterStop?.();
      setStudioState((prev) => ({ ...prev, actionLoading: false, error: "", info: "Live stream stopped." }));
    } catch (err) {
      setStudioState((prev) => ({ ...prev, actionLoading: false, error: apiMessage(err, "Unable to stop live stream."), info: "" }));
    }
  };

  const setInfo = (info) => setStudioState((prev) => ({ ...prev, info, error: "" }));
  const setError = (error) => setStudioState((prev) => ({ ...prev, error, info: "" }));

  return {
    studioLink,
    studioState,
    preflight,
    linked,
    connected,
    connecting,
    profile,
    videoSource,
    obsMode,
    attachPreview,
    connectCamera: () => connectSource("camera"),
    shareScreen: () => connectSource("screen"),
    disconnect,
    startLive,
    cancelGoLive,
    resumeDelivery,
    stopLive,
    setInfo,
    setError,
  };
}
