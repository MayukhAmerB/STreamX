import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Room, createLocalAudioTrack, createLocalScreenTracks, createLocalVideoTrack } from "livekit-client";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import BroadcastViewerTheater from "../components/realtime/BroadcastViewerTheater";
import { listLiveClasses } from "../api/courses";
import {
  applyRealtimeOwncastChatModeration,
  createRealtimeOwncastChatLaunch,
  createRealtimeSession,
  deleteRealtimeRecording,
  endRealtimeSession,
  getRealtimeOwncastChatModeration,
  getRealtimeSession,
  getRealtimeHostToken,
  joinRealtimeSession,
  listRealtimeRecordings,
  listRealtimeSessions,
  startRealtimeRecording,
  startRealtimeStream,
  stopRealtimeRecording,
  stopRealtimeStream,
  uploadRealtimeBrowserRecording,
} from "../api/realtime";
import { useAuth } from "../hooks/useAuth";
import useAdaptiveRealtimeSessionPolling from "../hooks/useAdaptiveRealtimeSessionPolling";
import { ScreenityFallbackRecorder } from "../services/recording/ScreenityFallbackRecorder";
import { resolveBroadcastEmbedUrls } from "../utils/broadcastUrls";
import { apiData, apiMessage } from "../utils/api";
import { copyTextToClipboard } from "../utils/clipboard";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const initialForm = {
  title: "",
  description: "",
  linked_live_class_id: "",
  stream_service: "alsyed_stream",
  obs_stream_server_url: "",
  obs_stream_key: "",
  stream_embed_url: "",
  chat_embed_url: "",
  rtmp_target_url: "",
};
const STREAM_SERVICE_ALSYED = "alsyed_stream";
const STREAM_SERVICE_OBS = "obs_stream";

const defaultBroadcastProfile = {
  capture_width: 640,
  capture_height: 360,
  fps: 20,
  max_video_bitrate_kbps: 650,
};

const defaultBroadcastSource = "camera";

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function inferObsServerUrl() {
  if (typeof window === "undefined") {
    return "rtmp://your-server:1935/live";
  }
  const host = String(window.location.hostname || "").trim() || "localhost";
  return `rtmp://${host}:1935/live`;
}

function maskSecretValue(value) {
  const normalized = String(value || "");
  if (!normalized) return "";
  return "\u2022".repeat(Math.max(normalized.length, 12));
}

function canManageSession(session, user) {
  if (!session) return false;
  if (session.can_manage) return true;
  if (session.is_host) return true;
  return user?.is_admin === true;
}

function isObsStreamMode(session) {
  return String(session?.stream_service || "").trim().toLowerCase() === STREAM_SERVICE_OBS;
}

function getStreamServiceLabel(session) {
  return isObsStreamMode(session) ? "Alsyed OBS Stream" : "Alsyed Stream";
}

function resolveRecordingMode(recording) {
  const source = String(recording?.source || "").trim().toLowerCase();
  if (source === "browser_fallback") {
    return "screenity-fallback";
  }
  if (recording?.is_active) {
    return "livekit-egress";
  }
  return "";
}

function resolveRecordingPlaybackUrl(recording) {
  return String(recording?.playback_url || recording?.output_download_url || "").trim();
}

function owncastMessagePreview(body) {
  return String(body || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "No message body";
}

function formatModerationTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function owncastIdentityLabel(identity) {
  return (
    identity?.owncast_display_name ||
    identity?.platform_full_name ||
    identity?.platform_email ||
    identity?.owncast_user_id ||
    "Unknown user"
  );
}

const broadcastMarketingCards = [
  {
    title: "Cybersecurity Townhalls",
    description: "Run high-impact security briefings, incident retrospectives, and weekly intel updates.",
  },
  {
    title: "Live Product Demonstrations",
    description: "Deliver guided walkthroughs with stable one-to-many delivery and built-in chat.",
  },
  {
    title: "Expert Q&A Sessions",
    description: "Host moderated sessions where viewers engage through live messaging.",
  },
];

const broadcastHeroHighlights = [
  "Host directly from browser",
  "Camera + screen share",
  "Chat-first audience mode",
  "Supports up to 500 viewers",
];

const broadcastWorkflow = [
  {
    step: "Create",
    detail: "Open a broadcast session and configure optional stream/chat embed links.",
  },
  {
    step: "Publish",
    detail: "Connect camera or share screen with microphone in Host Studio, then start live delivery.",
  },
  {
    step: "Engage",
    detail: "Viewers watch the stream and interact through chat-only participation.",
  },
];

export default function BroadcastingPage() {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const [sessions, setSessions] = useState([]);
  const [liveClassOptions, setLiveClassOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [form, setForm] = useState(initialForm);
  const [createState, setCreateState] = useState({ loading: false, error: "", success: "" });

  const [joinState, setJoinState] = useState({ loadingId: null, error: "", info: "" });
  const [activeBroadcast, setActiveBroadcast] = useState(() => location.state?.autoJoinPayload || null);
  const [activeBroadcastChatLaunch, setActiveBroadcastChatLaunch] = useState({
    sessionId: null,
    sourceUrl: "",
    url: "",
    loading: false,
  });
  const [deleteState, setDeleteState] = useState({ loadingId: null, error: "", info: "" });
  const [streamControlState, setStreamControlState] = useState({
    loadingId: null,
    error: "",
    info: "",
  });
  const [shareState, setShareState] = useState({ error: "", info: "" });
  const [chatModerationState, setChatModerationState] = useState({
    sessionId: null,
    loading: false,
    actionLoading: "",
    error: "",
    info: "",
    data: null,
  });
  const [ipBanInput, setIpBanInput] = useState("");
  const [isStudioObsKeyVisible, setIsStudioObsKeyVisible] = useState(false);

  const [studioSession, setStudioSession] = useState(null);
  const [studioProfile, setStudioProfile] = useState(defaultBroadcastProfile);
  const [studioVideoSource, setStudioVideoSource] = useState(defaultBroadcastSource);
  const [studioState, setStudioState] = useState({
    connecting: false,
    connected: false,
    actionLoading: false,
    error: "",
    info: "",
  });
  const [studioRecordingState, setStudioRecordingState] = useState({
    loading: false,
    error: "",
    info: "",
    active: null,
    latestCompleted: null,
    mode: "",
  });

  const roomRef = useRef(null);
  const localVideoTrackRef = useRef(null);
  const localAudioTrackRef = useRef(null);
  const connectedStudioSessionIdRef = useRef(null);
  const previewVideoRef = useRef(null);
  const fallbackRecorderRef = useRef(null);

  const highlightedSessionId = searchParams.get("session");

  useEffect(() => {
    setForm((prev) => {
      if (prev.stream_service !== STREAM_SERVICE_OBS) return prev;
      return {
        ...prev,
        obs_stream_server_url: prev.obs_stream_server_url || inferObsServerUrl(),
      };
    });
  }, []);

  const loadSessions = async () => {
    try {
      const response = await listRealtimeSessions({ status: "all" });
      const data = apiData(response, []);
      const rows = Array.isArray(data)
        ? data.filter((item) => item.status !== "ended" && item.session_type === "broadcasting")
        : [];
      setSessions(rows);
      setError("");
    } catch (err) {
      setError(apiMessage(err, "Unable to load broadcasting sessions."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listLiveClasses();
        if (!active) return;
        const payload = apiData(response, []);
        const rows = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.results)
            ? payload.results
            : [];
        setLiveClassOptions(
          [...rows].sort((a, b) => {
            const monthDelta = Number(a?.month_number || 0) - Number(b?.month_number || 0);
            if (monthDelta !== 0) return monthDelta;
            return String(a?.title || "").localeCompare(String(b?.title || ""));
          })
        );
      } catch {
        if (!active) return;
        setLiveClassOptions([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!studioSession?.id) {
      setStudioRecordingState({
        loading: false,
        error: "",
        info: "",
        active: null,
        latestCompleted: null,
        mode: "",
      });
      return undefined;
    }
    (async () => {
      try {
        const response = await listRealtimeRecordings(studioSession.id);
        if (!active) return;
        const payload = apiData(response, []);
        const rows = Array.isArray(payload) ? payload : [];
        const activeRecording = rows.find((item) => item?.is_active) || null;
        const latestCompleted = rows.find((item) => item?.status === "completed") || null;
        setStudioRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: "",
          active: activeRecording,
          latestCompleted,
          mode: resolveRecordingMode(activeRecording),
        }));
      } catch {
        if (!active) return;
        setStudioRecordingState((prev) => ({ ...prev, loading: false }));
      }
    })();
    return () => {
      active = false;
    };
  }, [studioSession?.id]);

  const orderedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const statusWeight = { live: 1, scheduled: 2, ended: 3 };
      const aWeight = statusWeight[a.status] || 4;
      const bWeight = statusWeight[b.status] || 4;
      if (aWeight !== bWeight) return aWeight - bWeight;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [sessions]);

  const syncSessionRow = (updated) => {
    if (!updated?.id) return;
    setSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    if (studioSession?.id === updated.id) {
      setStudioSession(updated);
    }
  };

  const stopLocalMedia = () => {
    if (localVideoTrackRef.current) {
      localVideoTrackRef.current.detach();
      localVideoTrackRef.current.stop();
      localVideoTrackRef.current = null;
    }
    if (localAudioTrackRef.current) {
      localAudioTrackRef.current.stop();
      localAudioTrackRef.current = null;
    }
  };

  const stopFallbackRecorder = () => {
    const recorder = fallbackRecorderRef.current;
    if (recorder?.isRecording) {
      recorder.stop().catch(() => {
        // best-effort cleanup on session switch/unmount
      });
    }
    fallbackRecorderRef.current = null;
  };

  const disconnectStudio = () => {
    stopFallbackRecorder();
    stopLocalMedia();
    if (roomRef.current) {
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = null;
    }
    connectedStudioSessionIdRef.current = null;
    setStudioProfile(defaultBroadcastProfile);
    setStudioVideoSource(defaultBroadcastSource);
    setStudioState((prev) => ({ ...prev, connected: false }));
  };

  useEffect(() => {
    return () => {
      disconnectStudio();
    };
  }, []);

  const handleCreate = async (event) => {
    event.preventDefault();
    if (!form.linked_live_class_id) {
      setCreateState({ loading: false, error: "Select the linked live class for this broadcast.", success: "" });
      return;
    }
    setCreateState({ loading: true, error: "", success: "" });

    try {
      const payload = {
        title: form.title,
        description: form.description,
        linked_live_class_id: Number(form.linked_live_class_id),
        session_type: "broadcasting",
        stream_service: form.stream_service,
        obs_stream_key: "",
        meeting_capacity: 200,
        max_audience: 500,
        allow_overflow_broadcast: true,
        stream_embed_url: form.stream_service === STREAM_SERVICE_ALSYED ? form.stream_embed_url : "",
        chat_embed_url: form.stream_service === STREAM_SERVICE_ALSYED ? form.chat_embed_url : "",
        rtmp_target_url:
          form.stream_service === STREAM_SERVICE_ALSYED ? form.rtmp_target_url : form.obs_stream_server_url,
      };
      const response = await createRealtimeSession(payload);
      const created = apiData(response, null);
      if (created) {
        setSessions((prev) => [created, ...prev]);
        setStudioSession(created);
      }
      setForm(initialForm);
      setCreateState({ loading: false, error: "", success: "Broadcast created. Open Host Studio to go live." });
    } catch (err) {
      setCreateState({ loading: false, error: apiMessage(err, "Unable to create broadcast."), success: "" });
    }
  };

  const handleJoin = async (sessionId) => {
    setJoinState({ loadingId: sessionId, error: "", info: "" });

    try {
      const response = await joinRealtimeSession(sessionId, {
        display_name: user?.full_name || "",
        // Keep this page in viewer/broadcast context even for moderators.
        prefer_broadcast: true,
      });
      const data = apiData(response, {});
      if (data.mode === "meeting") {
        setJoinState({
          loadingId: null,
          error: "",
          info: "Session is in meeting mode. Use the Meeting tab for two-way participation.",
        });
        return;
      }
      setActiveBroadcast(data);
      setJoinState({ loadingId: null, error: "", info: "Broadcast joined." });
      await loadSessions();
    } catch (err) {
      setJoinState({ loadingId: null, error: apiMessage(err, "Unable to join broadcast."), info: "" });
    }
  };

  const handleOpenStudio = (session) => {
    const obsMode = isObsStreamMode(session);
    if (obsMode) {
      disconnectStudio();
    }
    setIsStudioObsKeyVisible(false);
    setStudioSession(session);
    setStudioState((prev) => ({
      ...prev,
      error: "",
      connected: obsMode ? false : prev.connected,
      info: obsMode
        ? "OBS mode selected. Configure OBS with server URL + stream key, then click Start Live."
        : "Host studio selected.",
    }));
  };

  const loadChatModeration = async (sessionId = studioSession?.id) => {
    if (!sessionId) return;
    setChatModerationState((prev) => ({
      ...prev,
      sessionId,
      loading: true,
      error: "",
      info: "",
    }));
    try {
      const response = await getRealtimeOwncastChatModeration(sessionId);
      const data = apiData(response, {});
      setChatModerationState((prev) => ({
        ...prev,
        sessionId,
        loading: false,
        data,
        error: "",
        info: "Chat control state refreshed.",
      }));
    } catch (err) {
      setChatModerationState((prev) => ({
        ...prev,
        sessionId,
        loading: false,
        error: apiMessage(err, "Unable to load Owncast chat controls."),
        info: "",
      }));
    }
  };

  const handleOpenChatControl = async (session) => {
    handleOpenStudio(session);
    await loadChatModeration(session.id);
  };

  const applyChatModerationAction = async (action, payload = {}, successMessage = "Chat action applied.") => {
    const sessionId = chatModerationState.sessionId || studioSession?.id;
    if (!sessionId) return;
    setChatModerationState((prev) => ({
      ...prev,
      sessionId,
      actionLoading: action,
      error: "",
      info: "",
    }));
    try {
      const response = await applyRealtimeOwncastChatModeration(sessionId, { action, ...payload });
      const data = apiData(response, {});
      setChatModerationState((prev) => ({
        ...prev,
        sessionId,
        actionLoading: "",
        data,
        error: "",
        info: successMessage,
      }));
    } catch (err) {
      setChatModerationState((prev) => ({
        ...prev,
        sessionId,
        actionLoading: "",
        error: apiMessage(err, "Unable to apply Owncast chat moderation action."),
        info: "",
      }));
    }
  };

  const handleTimeoutOwncastUser = async (identity) => {
    const minutesInput = window.prompt(
      `Timeout ${owncastIdentityLabel(identity)} for how many minutes?`,
      "10"
    );
    if (minutesInput === null) return;
    const minutes = Number(minutesInput);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      setChatModerationState((prev) => ({
        ...prev,
        error: "Timeout must be between 1 and 1440 minutes.",
        info: "",
      }));
      return;
    }
    await applyChatModerationAction(
      "timeout_user",
      {
        owncast_user_id: identity.owncast_user_id,
        duration_seconds: Math.round(minutes * 60),
      },
      `Timed out ${owncastIdentityLabel(identity)} for ${minutes} minute${minutes === 1 ? "" : "s"}.`
    );
  };

  const handleBanOwncastUser = async (identity) => {
    if (!window.confirm(`Ban ${owncastIdentityLabel(identity)} from Owncast chat?`)) return;
    await applyChatModerationAction(
      "ban_user",
      { owncast_user_id: identity.owncast_user_id },
      `${owncastIdentityLabel(identity)} was banned from chat.`
    );
  };

  const handleBanOwncastIp = async () => {
    const ipAddress = String(ipBanInput || "").trim();
    if (!ipAddress) {
      setChatModerationState((prev) => ({ ...prev, error: "Enter an IP address to ban.", info: "" }));
      return;
    }
    await applyChatModerationAction("ban_ip", { ip_address: ipAddress }, `IP ${ipAddress} was banned.`);
    setIpBanInput("");
  };

  const getSessionStreamUrl = (session) => {
    const fallbackPayload =
      activeBroadcast?.session?.id === session?.id ? activeBroadcast?.broadcast : null;
    const urls = resolveBroadcastEmbedUrls({
      streamEmbedUrl: session?.stream_embed_url || fallbackPayload?.stream_embed_url,
      chatEmbedUrl: session?.chat_embed_url || fallbackPayload?.chat_embed_url,
    });
    return urls.streamEmbedUrl;
  };

  const getSessionChatUrl = (session) => {
    const fallbackPayload =
      activeBroadcast?.session?.id === session?.id ? activeBroadcast?.broadcast : null;
    const urls = resolveBroadcastEmbedUrls({
      streamEmbedUrl: session?.stream_embed_url || fallbackPayload?.stream_embed_url,
      chatEmbedUrl: session?.chat_embed_url || fallbackPayload?.chat_embed_url,
    });
    return urls.writableChatEmbedUrl || urls.chatEmbedUrl;
  };

  const getObsStreamServerUrl = (session) =>
    String(session?.obs_stream_server_url || "").trim();

  const getObsStreamKey = (session) => String(session?.obs_stream_key || "").trim();

  const buildJoinLink = (session) => {
    if (session?.join_url) {
      return session.join_url;
    }
    const sessionId = session?.id;
    if (!sessionId) {
      return "";
    }
    if (typeof window === "undefined") {
      return `/join-live?session=${sessionId}`;
    }
    return `${window.location.origin}/join-live?session=${sessionId}`;
  };

  const copyText = async (value, successMessage, errorMessage) => {
    try {
      await copyTextToClipboard(value);
      setShareState({ error: "", info: successMessage });
    } catch (err) {
      setShareState({ error: apiMessage(err, errorMessage), info: "" });
    }
  };

  const handleCopyJoinLink = async (session) => {
    await copyText(buildJoinLink(session), "Join link copied.", "Unable to copy join link.");
  };

  const handleCopyStreamLink = async (session) => {
    const streamUrl = getSessionStreamUrl(session);
    if (!streamUrl) {
      setShareState({
        error: "Stream URL is not ready yet. Start live or configure a custom stream URL.",
        info: "",
      });
      return;
    }
    await copyText(streamUrl, "Stream URL copied.", "Unable to copy stream URL.");
  };

  const preparePersonalizedChatUrl = async (session) => {
    if (!session?.id) {
      throw new Error("Broadcast session is not ready yet.");
    }
    const launchResponse = await createRealtimeOwncastChatLaunch(session.id);
    const launchData = apiData(launchResponse, {});
    const launchUrl = String(launchData?.launch_url || "").trim();
    if (!launchUrl) {
      throw new Error("Personalized chat launch URL was not returned.");
    }
    return launchUrl;
  };

  const handleCopyChatLink = async (session) => {
    if (!getSessionChatUrl(session)) {
      setShareState({
        error: "Broadcast chat URL is not configured for this session.",
        info: "",
      });
      return;
    }
    try {
      const launchUrl = await preparePersonalizedChatUrl(session);
      await copyText(launchUrl, "Verified chat link copied.", "Unable to copy verified chat link.");
    } catch (err) {
      setShareState({
        error: apiMessage(err, "Unable to prepare verified chat link."),
        info: "",
      });
    }
  };

  const handleOpenBroadcastChat = (session) => {
    if (!getSessionChatUrl(session)) {
      setShareState({
        error: "Broadcast chat URL is not configured for this session.",
        info: "",
      });
      return;
    }
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setShareState({
        error: "Popup blocked by browser. Allow popups and use 'Copy Chat Link' if needed.",
        info: "",
      });
      return;
    }
    try {
      popup.opener = null;
    } catch {
      // Best effort only; keep the verified chat popup isolated from this window.
    }
    setShareState({ error: "", info: "Preparing verified broadcast chat..." });

    (async () => {
      try {
        const launchUrl = await preparePersonalizedChatUrl(session);
        if (!popup.closed) {
          popup.location.replace(launchUrl);
        }
        setShareState({ error: "", info: "Verified broadcast chat opened in a new tab." });
      } catch (err) {
        try {
          popup.close();
        } catch {
          // Best effort only; the blank popup may already be closed.
        }
        setShareState({
          error: apiMessage(err, "Unable to prepare verified chat launch."),
          info: "",
        });
      }
    })();
  };

  const handleCopyObsServerUrl = async (session) => {
    const serverUrl = getObsStreamServerUrl(session);
    if (!serverUrl) {
      setShareState({ error: "OBS server URL is not available for this session.", info: "" });
      return;
    }
    await copyText(serverUrl, "OBS server URL copied.", "Unable to copy OBS server URL.");
  };

  const handleCopyObsStreamKey = async (session) => {
    const streamKey = getObsStreamKey(session);
    if (!streamKey) {
      setShareState({ error: "OBS stream key is not available for this session.", info: "" });
      return;
    }
    await copyText(streamKey, "OBS stream key copied.", "Unable to copy OBS stream key.");
  };

  const handleDeleteSession = async (session) => {
    const confirmed = window.confirm(`Delete "${session.title}"? This will end the live session.`);
    if (!confirmed) {
      return;
    }

    setDeleteState({ loadingId: session.id, error: "", info: "" });
    try {
      await endRealtimeSession(session.id);
      setSessions((prev) => prev.filter((row) => row.id !== session.id));
      if (studioSession?.id === session.id) {
        disconnectStudio();
        setStudioSession(null);
      }
      if (activeBroadcast?.session?.id === session.id) {
        setActiveBroadcast(null);
      }
      setDeleteState({ loadingId: null, error: "", info: "Session deleted." });
    } catch (err) {
      setDeleteState({ loadingId: null, error: apiMessage(err, "Unable to delete session."), info: "" });
    }
  };

  const handleStopSessionStream = async (session) => {
    if (!session?.id) {
      return;
    }
    setStreamControlState({ loadingId: session.id, error: "", info: "" });
    try {
      const response = await stopRealtimeStream(session.id);
      const updated = apiData(response, null);
      if (updated) {
        syncSessionRow(updated);
        if (activeBroadcast?.session?.id === session.id) {
          setActiveBroadcast((prev) =>
            prev
              ? {
                  ...prev,
                  session: { ...prev.session, ...updated },
                  broadcast: {
                    ...prev.broadcast,
                    stream_status: updated.stream_status || prev.broadcast?.stream_status,
                  },
                }
              : prev
          );
        }
      }
      setStreamControlState({ loadingId: null, error: "", info: "Broadcast stream stopped." });
    } catch (err) {
      setStreamControlState({
        loadingId: null,
        error: apiMessage(err, "Unable to stop broadcast stream."),
        info: "",
      });
    }
  };

  const handleConnectSource = async (source = defaultBroadcastSource) => {
    if (!studioSession) return;
    if (isObsStreamMode(studioSession)) {
      setStudioState((prev) => ({
        ...prev,
        connecting: false,
        connected: false,
        actionLoading: false,
        error: "",
        info: "OBS mode is active. Publish from OBS using the server URL and stream key below.",
      }));
      return;
    }
    const nextSource = source === "screen" ? "screen" : "camera";
    const sourceLabel = nextSource === "screen" ? "screen share" : "camera";
    setStudioState({
      connecting: true,
      connected: false,
      actionLoading: false,
      error: "",
      info: `Connecting ${sourceLabel}...`,
    });

    try {
      if (
        roomRef.current &&
        connectedStudioSessionIdRef.current &&
        connectedStudioSessionIdRef.current !== studioSession.id
      ) {
        disconnectStudio();
      }

      const tokenResponse = await getRealtimeHostToken(studioSession.id);
      const tokenData = apiData(tokenResponse, {});
      const serverProfile = tokenData.broadcast_profile || {};
      const profile = {
        capture_width: clampNumber(
          serverProfile.capture_width,
          320,
          1920,
          defaultBroadcastProfile.capture_width
        ),
        capture_height: clampNumber(
          serverProfile.capture_height,
          180,
          1080,
          defaultBroadcastProfile.capture_height
        ),
        fps: clampNumber(serverProfile.fps, 10, 30, defaultBroadcastProfile.fps),
        max_video_bitrate_kbps: clampNumber(
          serverProfile.max_video_bitrate_kbps,
          200,
          4000,
          defaultBroadcastProfile.max_video_bitrate_kbps
        ),
      };

      let room = roomRef.current;
      if (!room) {
        room = new Room({
          adaptiveStream: false,
          dynacast: false,
        });
        await room.connect(tokenData.livekit_url, tokenData.token);
        roomRef.current = room;
        connectedStudioSessionIdRef.current = studioSession.id;
      }

      const previousVideoTrack = localVideoTrackRef.current;

      let videoTrack = null;
      if (nextSource === "screen") {
        const createdTracks = await createLocalScreenTracks({
          audio: false,
          resolution: {
            width: profile.capture_width,
            height: profile.capture_height,
            frameRate: profile.fps,
          },
        });
        videoTrack = createdTracks.find((track) => track.kind === "video") || null;
      } else {
        videoTrack = await createLocalVideoTrack({
          facingMode: "user",
          resolution: {
            width: profile.capture_width,
            height: profile.capture_height,
          },
          frameRate: profile.fps,
        });
      }
      if (!videoTrack) {
        throw new Error("No video track available from selected source.");
      }

      if (!localAudioTrackRef.current) {
        localAudioTrackRef.current = await createLocalAudioTrack();
        await room.localParticipant.publishTrack(localAudioTrackRef.current);
      }

      if (videoTrack?.mediaStreamTrack && "contentHint" in videoTrack.mediaStreamTrack) {
        videoTrack.mediaStreamTrack.contentHint = "detail";
      }

      if (previousVideoTrack) {
        try {
          await room.localParticipant.unpublishTrack(previousVideoTrack, true);
        } catch {
          // best effort cleanup before replacing video source
        }
        previousVideoTrack.detach();
        previousVideoTrack.stop();
      }

      await room.localParticipant.publishTrack(videoTrack, {
        simulcast: false,
        videoEncoding: {
          maxBitrate: profile.max_video_bitrate_kbps * 1000,
          maxFramerate: profile.fps,
        },
        degradationPreference: "maintain-resolution",
      });

      if (previewVideoRef.current) {
        videoTrack.attach(previewVideoRef.current);
      }

      localVideoTrackRef.current = videoTrack;
      setStudioProfile(profile);
      setStudioVideoSource(nextSource);

      if (nextSource === "screen" && videoTrack?.mediaStreamTrack?.addEventListener) {
        videoTrack.mediaStreamTrack.addEventListener(
          "ended",
          () => {
            if (localVideoTrackRef.current === videoTrack) {
              room.localParticipant.unpublishTrack(videoTrack, true).catch(() => {
                // no-op
              });
              videoTrack.detach();
              videoTrack.stop();
              localVideoTrackRef.current = null;
              if (previewVideoRef.current) {
                previewVideoRef.current.srcObject = null;
              }
              setStudioVideoSource(defaultBroadcastSource);
              setStudioState((prev) => ({
                ...prev,
                connected: false,
                error: "",
                info: "Screen share ended. Click Share Screen to present again, or switch to camera.",
              }));
            }
          },
          { once: true }
        );
      }

      setStudioState({
        connecting: false,
        connected: true,
        actionLoading: false,
        error: "",
        info: `${
          nextSource === "screen" ? "Screen share" : "Camera"
        } connected (${profile.capture_width}x${profile.capture_height} @ ${profile.fps}fps, ${profile.max_video_bitrate_kbps}kbps). Click Start Live to begin streaming. If admin changes profile, reconnect to apply.`,
      });
    } catch (err) {
      if (!roomRef.current) {
        disconnectStudio();
      }
      setStudioState({
        connecting: false,
        connected: Boolean(localVideoTrackRef.current && localAudioTrackRef.current && roomRef.current),
        actionLoading: false,
        error: apiMessage(err, "Unable to access selected media source for browser publishing."),
        info: "",
      });
    }
  };

  const handleConnectCamera = async () => {
    await handleConnectSource("camera");
  };

  const handleShareScreen = async () => {
    await handleConnectSource("screen");
  };

  const handleStartLive = async () => {
    if (!studioSession) return;
    const obsMode = isObsStreamMode(studioSession);
    if (!obsMode && !studioState.connected) {
      setStudioState((prev) => ({ ...prev, error: "Connect camera or screen share first before starting live." }));
      return;
    }

    setStudioState((prev) => ({ ...prev, actionLoading: true, error: "", info: "Starting live stream..." }));
    try {
      const response = await startRealtimeStream(studioSession.id);
      const updated = apiData(response, null);
      if (updated) {
        syncSessionRow(updated);
      }
      setStudioState((prev) => ({
        ...prev,
        actionLoading: false,
        error: "",
        info: obsMode
          ? obsStartInfoMessage
          : "You are live. Viewers can watch from the broadcast player.",
      }));
      if (!obsMode) {
        await handleJoin(studioSession.id);
      }
    } catch (err) {
      setStudioState((prev) => ({
        ...prev,
        actionLoading: false,
        error: apiMessage(err, "Unable to start live stream."),
        info: "",
      }));
    }
  };

  const handleStopLive = async () => {
    if (!studioSession) return;

    setStudioState((prev) => ({ ...prev, actionLoading: true, error: "", info: "Stopping live stream..." }));
    try {
      const response = await stopRealtimeStream(studioSession.id);
      const updated = apiData(response, null);
      if (updated) {
        syncSessionRow(updated);
      }
      setStudioState((prev) => ({
        ...prev,
        actionLoading: false,
        error: "",
        info: "Live stream stopped.",
      }));
    } catch (err) {
      setStudioState((prev) => ({
        ...prev,
        actionLoading: false,
        error: apiMessage(err, "Unable to stop live stream."),
        info: "",
      }));
    }
  };

  const handleStartRecording = async () => {
    if (!studioSession?.id) return;
    setStudioRecordingState((prev) => ({ ...prev, loading: true, error: "", info: "" }));
    try {
      const response = await startRealtimeRecording(studioSession.id);
      const recording = apiData(response, null);
      setStudioRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: "",
        info: "Broadcast recording started.",
        active: recording,
        mode: resolveRecordingMode(recording) || "livekit-egress",
      }));
    } catch (livekitErr) {
      try {
        const fallbackRecorder =
          fallbackRecorderRef.current || new ScreenityFallbackRecorder({ withMicrophone: true });
        fallbackRecorderRef.current = fallbackRecorder;
        if (!fallbackRecorder.isRecording) {
          await fallbackRecorder.start();
        }
        setStudioRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: "",
          info: "LiveKit recorder unavailable. Browser fallback recording started.",
          active: {
            id: "browser-fallback",
            status: "recording",
            is_active: true,
            source: "browser_fallback",
          },
          mode: "screenity-fallback",
        }));
      } catch (fallbackErr) {
        fallbackRecorderRef.current = null;
        setStudioRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: `${apiMessage(livekitErr, "Unable to start broadcast recording.")} ${apiMessage(
            fallbackErr,
            "Fallback recording failed."
          )}`,
          info: "",
          mode: "",
        }));
      }
    }
  };

  const handleStopRecording = async () => {
    if (!studioSession?.id) return;
    setStudioRecordingState((prev) => ({ ...prev, loading: true, error: "", info: "" }));
    if (studioRecordingState.mode === "screenity-fallback") {
      const fallbackRecorder = fallbackRecorderRef.current;
      if (!fallbackRecorder || !fallbackRecorder.isRecording) {
        setStudioRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: "No active fallback recording found.",
          info: "",
          active: null,
          mode: "",
        }));
        return;
      }
      try {
        const localRecording = await fallbackRecorder.stop();
        fallbackRecorderRef.current = null;

        const formData = new FormData();
        formData.append("video_file", localRecording.file, localRecording.file_name);
        if (localRecording.started_at) {
          formData.append("started_at", localRecording.started_at);
        }
        if (localRecording.ended_at) {
          formData.append("ended_at", localRecording.ended_at);
        }

        const uploadResponse = await uploadRealtimeBrowserRecording(studioSession.id, formData);
        const storedRecording = apiData(uploadResponse, null);
        setStudioRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: "",
          info: "Fallback recording uploaded and stored.",
          active: null,
          latestCompleted: storedRecording || prev.latestCompleted,
          mode: "",
        }));
      } catch (err) {
        setStudioRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: apiMessage(err, "Unable to stop/upload fallback broadcast recording."),
          info: "",
        }));
      }
      return;
    }

    try {
      const response = await stopRealtimeRecording(studioSession.id);
      const recording = apiData(response, null);
      setStudioRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: "",
        info: "Broadcast recording stopped and stored.",
        active: recording?.is_active ? recording : null,
        latestCompleted: recording?.status === "completed" ? recording : prev.latestCompleted,
        mode: recording?.is_active ? resolveRecordingMode(recording) : "",
      }));
    } catch (err) {
      setStudioRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: apiMessage(err, "Unable to stop broadcast recording."),
        info: "",
      }));
    }
  };

  const handleDeleteLatestRecording = async () => {
    const latest = studioRecordingState.latestCompleted;
    if (!studioSession?.id || !latest?.id) return;
    if (!window.confirm("Delete the latest broadcast recording permanently? This cannot be undone.")) {
      return;
    }
    setStudioRecordingState((prev) => ({ ...prev, loading: true, error: "", info: "" }));
    try {
      await deleteRealtimeRecording(latest.id);
      setStudioRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: "",
        info: "Latest broadcast recording deleted.",
        active: prev.active?.id === latest.id ? null : prev.active,
        latestCompleted: prev.latestCompleted?.id === latest.id ? null : prev.latestCompleted,
      }));
    } catch (err) {
      setStudioRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: apiMessage(err, "Unable to delete broadcast recording."),
        info: "",
      }));
    }
  };

  useEffect(() => {
    if (!highlightedSessionId || !isAuthenticated) {
      return;
    }
    const sessionId = Number(highlightedSessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return;
    }
    if (activeBroadcast?.session?.id === sessionId) {
      return;
    }
    handleJoin(sessionId);
  }, [activeBroadcast?.session?.id, highlightedSessionId, isAuthenticated]);

  useEffect(() => {
    if (!studioSession?.id) {
      return undefined;
    }

    let cancelled = false;
    const refreshStudioSession = async () => {
      try {
        const response = await getRealtimeSession(studioSession.id);
        const latestSession = apiData(response, null);
        if (!latestSession || cancelled) {
          return;
        }
        syncSessionRow(latestSession);
      } catch {
        // retain current studio state during transient refresh failures
      }
    };

    refreshStudioSession();
    const intervalId = window.setInterval(refreshStudioSession, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [studioSession?.id]);

  const applyActiveBroadcastSessionUpdate = useCallback((latestSession) => {
    if (!latestSession) {
      return;
    }
    syncSessionRow(latestSession);
    setActiveBroadcast((previous) => {
      if (!previous || previous.session?.id !== latestSession.id) {
        return previous;
      }
      return {
        ...previous,
        session: { ...previous.session, ...latestSession },
        broadcast: {
          ...previous.broadcast,
          stream_status: latestSession.stream_status || previous.broadcast?.stream_status || "",
        },
      };
    });
  }, [syncSessionRow]);

  const handleRefreshActiveBroadcast = useAdaptiveRealtimeSessionPolling({
    enabled: Boolean(activeBroadcast?.session?.id),
    sessionId: activeBroadcast?.session?.id,
    sessionStatus: activeBroadcast?.session?.status,
    streamStatus: activeBroadcast?.broadcast?.stream_status,
    onSessionData: applyActiveBroadcastSessionUpdate,
  });

  const studioStreamUrl = getSessionStreamUrl(studioSession);
  const studioChatUrl = getSessionChatUrl(studioSession);
  const studioObsServerUrl = getObsStreamServerUrl(studioSession);
  const studioObsStreamKey = getObsStreamKey(studioSession);
  const isObsStudioMode = isObsStreamMode(studioSession);
  const activeBroadcastUrls = useMemo(
    () =>
      resolveBroadcastEmbedUrls({
        streamEmbedUrl: activeBroadcast?.broadcast?.stream_embed_url,
        chatEmbedUrl: activeBroadcast?.broadcast?.chat_embed_url,
      }),
    [activeBroadcast]
  );
  const activeStreamUrl = activeBroadcastUrls.streamEmbedUrl;
  const activeChatUrl =
    activeBroadcastUrls.writableChatEmbedUrl || activeBroadcastUrls.chatEmbedUrl;
  const shouldUsePersonalizedActiveChat =
    Boolean(activeBroadcast?.session?.id) && Boolean(activeChatUrl);
  const resolvedActiveChatUrl =
    shouldUsePersonalizedActiveChat &&
    activeBroadcastChatLaunch.sessionId === activeBroadcast?.session?.id &&
    activeBroadcastChatLaunch.sourceUrl === activeChatUrl
      ? activeBroadcastChatLaunch.url
      : shouldUsePersonalizedActiveChat
        ? ""
        : activeChatUrl;
  const activeChatFallbackMessage = shouldUsePersonalizedActiveChat
    ? activeBroadcastChatLaunch.loading
      ? "Preparing your verified chat session..."
      : "Verified chat could not be prepared. Refresh the page or sign in again."
    : "Chat URL not configured for this session.";
  const activeBroadcastStatusMessage =
    activeBroadcast?.session?.status === "ended"
      ? "This broadcast session has ended."
      : String(activeBroadcast?.broadcast?.stream_status || "").trim().toLowerCase() === "starting"
        ? "The host is reconnecting OBS. Keep chat open and the video will resume here when the stream is back."
      : activeBroadcast?.broadcast?.stream_status &&
          String(activeBroadcast.broadcast.stream_status).trim().toLowerCase() !== "live"
        ? "The video stream is temporarily offline. Keep chat open while the host reconnects OBS."
        : "";

  useEffect(() => {
    if (!shouldUsePersonalizedActiveChat) {
      setActiveBroadcastChatLaunch({ sessionId: null, sourceUrl: "", url: "", loading: false });
      return undefined;
    }

    const sessionId = activeBroadcast.session.id;
    if (!isAuthenticated) {
      setActiveBroadcastChatLaunch({ sessionId, sourceUrl: activeChatUrl, url: "", loading: false });
      return undefined;
    }

    let cancelled = false;
    setActiveBroadcastChatLaunch({ sessionId, sourceUrl: activeChatUrl, url: "", loading: true });
    createRealtimeOwncastChatLaunch(sessionId)
      .then((response) => {
        if (cancelled) return;
        const data = apiData(response, {});
        const launchUrl = String(data?.launch_url || "").trim();
        setActiveBroadcastChatLaunch({
          sessionId,
          sourceUrl: activeChatUrl,
          url: launchUrl,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setActiveBroadcastChatLaunch({ sessionId, sourceUrl: activeChatUrl, url: "", loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [activeBroadcast?.session?.id, activeChatUrl, isAuthenticated, shouldUsePersonalizedActiveChat]);

  const normalizedStudioStreamStatus = String(studioSession?.stream_status || "").trim().toLowerCase();
  const obsStartActionLabel =
    isObsStudioMode && ["starting", "live", "stopped", "failed"].includes(normalizedStudioStreamStatus)
      ? "Resume OBS"
      : "Start Live";
  const obsStartInfoMessage =
    "OBS stream is ready. If OBS warned that the connection dropped, start streaming again in OBS using the same server URL and key. Viewers stay in the same session.";
  const chatModerationData =
    chatModerationState.sessionId === studioSession?.id ? chatModerationState.data || {} : {};
  const chatModerationIdentities = Array.isArray(chatModerationData.identities)
    ? chatModerationData.identities
    : [];
  const chatModerationMessages = Array.isArray(chatModerationData.recent_messages)
    ? chatModerationData.recent_messages
    : [];
  const chatModerationIpBans = Array.isArray(chatModerationData.ip_bans)
    ? chatModerationData.ip_bans
    : [];

  return (
    <PageShell title="" subtitle="" containerClassName="xl:max-w-[86rem] 2xl:max-w-[92rem]">
      <section className="relative mb-6 overflow-hidden rounded-[30px] border border-black bg-[#080808] shadow-[0_26px_70px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.16]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/88 via-black/78 to-[#111111]/94" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_12%,rgba(192,192,192,0.12),transparent_36%)]" />
        </div>

        <div className="relative space-y-6 p-5 sm:p-6">
          <div className="grid gap-6 lg:grid-cols-[1.08fr_0.92fr]">
            <div>
              <div className="inline-flex items-center rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#DBDBDB]">
                BROADCAST MODE
              </div>
              <h1 className="mt-4 max-w-3xl font-reference text-3xl font-semibold leading-tight text-white sm:text-4xl">
                One-to-many live streams with built-in viewer chat
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-[#BBBBBB]">
                Hosts publish directly from browser camera, screen share, and microphone. Live delivery is managed
                through LiveKit + Owncast while viewers engage in chat-only mode.
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                {broadcastHeroHighlights.map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-black bg-[#131313]/88 px-3 py-1 text-xs text-[#DADADA]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-black panel-gradient p-4 shadow-[0_16px_40px_rgba(0,0,0,0.28)] backdrop-blur-sm sm:p-5">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9A9A9A]">
                Start A Broadcast
              </div>
              {isAuthenticated ? (
                <form onSubmit={handleCreate} className="mt-3 space-y-3">
                  <input
                    className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                    placeholder="Broadcast title"
                    value={form.title}
                    onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                    required
                  />
                  <textarea
                    className="min-h-[86px] w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                    placeholder="Broadcast context"
                    value={form.description}
                    onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  />
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-[#949494]">
                      Linked Live Class
                    </label>
                    <select
                      className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                      value={form.linked_live_class_id}
                      onChange={(e) => setForm((prev) => ({ ...prev, linked_live_class_id: e.target.value }))}
                      required
                    >
                      <option value="">Select live class...</option>
                      {liveClassOptions.map((item) => (
                        <option key={item.id} value={item.id}>
                          {`Month ${item.month_number}: ${item.title}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-[#949494]">
                      Streaming Service
                    </label>
                    <select
                      className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                      value={form.stream_service}
                      onChange={(e) => {
                        const nextService = e.target.value;
                        setForm((prev) => {
                          if (nextService !== STREAM_SERVICE_OBS) {
                            return { ...prev, stream_service: nextService };
                          }
                          return {
                            ...prev,
                            stream_service: nextService,
                            obs_stream_server_url: prev.obs_stream_server_url || inferObsServerUrl(),
                          };
                        });
                      }}
                    >
                      <option value={STREAM_SERVICE_ALSYED}>Alsyed Stream (Browser Host Studio)</option>
                      <option value={STREAM_SERVICE_OBS}>Alsyed OBS Stream (OBS Ingest)</option>
                    </select>
                  </div>
                  {form.stream_service === STREAM_SERVICE_ALSYED ? (
                    <>
                      <input
                        className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                        placeholder="Stream embed URL (optional)"
                        value={form.stream_embed_url}
                        onChange={(e) => setForm((prev) => ({ ...prev, stream_embed_url: e.target.value }))}
                      />
                      <input
                        className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                        placeholder="Chat embed URL (optional)"
                        value={form.chat_embed_url}
                        onChange={(e) => setForm((prev) => ({ ...prev, chat_embed_url: e.target.value }))}
                      />
                      <input
                        className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                        placeholder="RTMP target URL (optional)"
                        value={form.rtmp_target_url}
                        onChange={(e) => setForm((prev) => ({ ...prev, rtmp_target_url: e.target.value }))}
                      />
                    </>
                  ) : (
                    <>
                      <input
                        className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                        placeholder="OBS server URL (rtmp://your-host:1935/live)"
                        value={form.obs_stream_server_url}
                        onChange={(e) => setForm((prev) => ({ ...prev, obs_stream_server_url: e.target.value }))}
                      />
                      <p className="text-xs text-[#AFAFAF]">
                        OBS stream key is fixed and managed by server policy. Create the session, then copy key from Host Studio.
                      </p>
                    </>
                  )}
                  <Button type="submit" className="w-full" loading={createState.loading}>
                    Create Broadcast
                  </Button>
                  {createState.error ? <p className="text-xs text-red-300">{createState.error}</p> : null}
                  {createState.success ? <p className="text-xs text-zinc-300">{createState.success}</p> : null}
                </form>
              ) : (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-[#CBCBCB]">Login to start or join broadcast sessions.</p>
                  <Link to="/login" state={{ from: "/broadcasting" }} className="inline-block">
                    <Button>Login</Button>
                  </Link>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-black panel-gradient p-4 sm:p-5">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
              Broadcast Workflow
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {broadcastWorkflow.map((item, index) => (
                <article key={item.step} className="rounded-xl border border-black panel-gradient p-3">
                  <div className="text-xs font-semibold text-[#DCDCDC]">{`0${index + 1}  ${item.step}`}</div>
                  <p className="mt-2 text-xs leading-6 text-[#B9B9B9]">{item.detail}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      {canManageSession(studioSession, user) ? (
        <section className="mb-6 rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-reference text-xl font-semibold text-white">Host Studio</h3>
              <p className="mt-1 text-xs text-[#949494]">Session: {studioSession.title}</p>
              <p className="mt-1 text-[11px] text-[#B8B8B8]">
                Service: {getStreamServiceLabel(studioSession)}
              </p>
            </div>
            <span className="rounded-full border border-black bg-[#171717] px-3 py-1 text-xs uppercase tracking-[0.12em] text-[#CDCDCD]">
              {studioSession.stream_status || "idle"}
            </span>
          </div>

          <div className="mb-4 rounded-xl border border-black panel-gradient px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-[#949494]">Share Links</div>
            <div className="mt-2 space-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-[#949494]">Join URL</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="max-w-full truncate rounded-md bg-[#0E0E0E] px-2 py-1 text-xs text-[#DFDFDF]">
                    {buildJoinLink(studioSession)}
                  </code>
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5 text-xs"
                    onClick={() => handleCopyJoinLink(studioSession)}
                  >
                    Copy
                  </Button>
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-[#949494]">Stream URL</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="max-w-full truncate rounded-md bg-[#0E0E0E] px-2 py-1 text-xs text-[#DFDFDF]">
                    {studioStreamUrl || "Stream URL becomes available after joining the broadcast or setting custom URL."}
                  </code>
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5 text-xs"
                    onClick={() => handleCopyStreamLink(studioSession)}
                    disabled={!studioStreamUrl}
                  >
                    Copy
                  </Button>
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.12em] text-[#949494]">Broadcast Chat URL</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="max-w-full truncate rounded-md bg-[#0E0E0E] px-2 py-1 text-xs text-[#DFDFDF]">
                    {studioChatUrl || "Broadcast chat URL unavailable for this session."}
                  </code>
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5 text-xs"
                    onClick={() => handleOpenBroadcastChat(studioSession)}
                    disabled={!studioChatUrl}
                  >
                    Open Broadcast Chat
                  </Button>
                  <Button
                    variant="secondary"
                    className="px-3 py-1.5 text-xs"
                    onClick={() => handleCopyChatLink(studioSession)}
                    disabled={!studioChatUrl}
                  >
                    Copy Chat Link
                  </Button>
                </div>
              </div>
              {isObsStudioMode ? (
                <>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.12em] text-[#949494]">OBS Server URL</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <code className="max-w-full truncate rounded-md bg-[#0E0E0E] px-2 py-1 text-xs text-[#DFDFDF]">
                        {studioObsServerUrl || "OBS server URL unavailable"}
                      </code>
                      <Button
                        variant="secondary"
                        className="px-3 py-1.5 text-xs"
                        onClick={() => handleCopyObsServerUrl(studioSession)}
                        disabled={!studioObsServerUrl}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.12em] text-[#949494]">OBS Stream Key</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <code className="max-w-full truncate rounded-md bg-[#0E0E0E] px-2 py-1 text-xs text-[#DFDFDF]">
                        {studioObsStreamKey
                          ? isStudioObsKeyVisible
                            ? studioObsStreamKey
                            : maskSecretValue(studioObsStreamKey)
                          : "OBS stream key unavailable"}
                      </code>
                      <Button
                        variant="secondary"
                        className="px-3 py-1.5 text-xs"
                        onClick={() => setIsStudioObsKeyVisible((prev) => !prev)}
                        disabled={!studioObsStreamKey}
                      >
                        {isStudioObsKeyVisible ? "Hide" : "View"}
                      </Button>
                      <Button
                        variant="secondary"
                        className="px-3 py-1.5 text-xs"
                        onClick={() => handleCopyObsStreamKey(studioSession)}
                        disabled={!studioObsStreamKey}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="overflow-hidden rounded-2xl border border-black bg-black">
              {isObsStudioMode ? (
                studioStreamUrl ? (
                  <iframe
                    title="OBS Broadcast Monitor"
                    src={studioStreamUrl}
                    className="h-[220px] w-full sm:h-[280px] lg:h-[320px]"
                    allow="autoplay; fullscreen"
                  />
                ) : (
                  <div className="flex h-[220px] items-center justify-center px-6 text-center text-sm text-[#BBBBBB] sm:h-[280px] lg:h-[320px]">
                    Stream preview appears here after OBS starts publishing.
                  </div>
                )
              ) : (
                <video
                  ref={previewVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="h-[220px] w-full object-cover sm:h-[280px] lg:h-[320px]"
                />
              )}
            </div>
            <div className="rounded-2xl border border-black panel-gradient p-4">
              {!isObsStudioMode ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Button onClick={handleConnectCamera} loading={studioState.connecting || studioState.actionLoading}>
                      {studioState.connected && studioVideoSource === "camera" ? "Reconnect Camera" : "Connect Camera"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={handleShareScreen}
                      loading={studioState.connecting}
                      disabled={studioState.actionLoading}
                    >
                      {studioState.connected && studioVideoSource === "screen" ? "Reshare Screen" : "Share Screen"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={disconnectStudio}
                      disabled={!studioState.connected || studioState.actionLoading}
                    >
                      Disconnect
                    </Button>
                    <Button
                      onClick={handleStartLive}
                      disabled={studioSession.stream_status === "live" || studioState.actionLoading}
                      loading={studioState.actionLoading && studioSession.stream_status !== "live"}
                    >
                      Start Live
                    </Button>
                    <Button
                      variant="danger"
                      onClick={handleStopLive}
                      disabled={studioSession.stream_status !== "live" || studioState.actionLoading}
                    >
                      Stop Live
                    </Button>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Button
                      variant="secondary"
                      onClick={handleStartRecording}
                      loading={studioRecordingState.loading}
                      disabled={Boolean(studioRecordingState.active)}
                    >
                      Start Recording
                    </Button>
                    <Button
                      variant="danger"
                      onClick={handleStopRecording}
                      loading={studioRecordingState.loading}
                      disabled={!studioRecordingState.active}
                    >
                      Stop Recording
                    </Button>
                  </div>
                </>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    onClick={handleStartLive}
                    disabled={studioState.actionLoading}
                    loading={studioState.actionLoading}
                  >
                    {obsStartActionLabel}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={handleStopLive}
                    disabled={studioSession.stream_status !== "live" || studioState.actionLoading}
                  >
                    Stop Live
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => handleCopyObsStreamKey(studioSession)}
                    disabled={!studioObsStreamKey}
                  >
                    Copy OBS Key
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setIsStudioObsKeyVisible((prev) => !prev)}
                    disabled={!studioObsStreamKey}
                  >
                    {isStudioObsKeyVisible ? "Hide OBS Key" : "View OBS Key"}
                  </Button>
                </div>
              )}

              {studioState.error ? <p className="mt-3 text-xs text-red-300">{studioState.error}</p> : null}
              {studioState.info ? <p className="mt-3 text-xs text-zinc-300">{studioState.info}</p> : null}
              {!isObsStudioMode ? (
                <>
                  {studioRecordingState.error ? <p className="mt-2 text-xs text-red-300">{studioRecordingState.error}</p> : null}
                  {studioRecordingState.info ? <p className="mt-2 text-xs text-zinc-300">{studioRecordingState.info}</p> : null}
                  <p className="mt-2 text-[11px] text-[#A4A4A4]">
                    Active source: {studioVideoSource === "screen" ? "Screen share" : "Camera"}.
                  </p>
                  <p className="mt-1 text-[11px] text-[#A4A4A4]">
                    Active profile: {studioProfile.capture_width}x{studioProfile.capture_height} at{" "}
                    {studioProfile.fps}fps, max {studioProfile.max_video_bitrate_kbps} kbps.
                  </p>
                  <p className="mt-1 text-[11px] text-[#A4A4A4]">
                    Recording status: {studioRecordingState.active?.status || "idle"}
                    {studioRecordingState.active
                      ? ` (${studioRecordingState.mode === "screenity-fallback" ? "browser fallback" : "livekit"})`
                      : ""}
                    .
                  </p>
                  {resolveRecordingPlaybackUrl(studioRecordingState.latestCompleted) ? (
                    <a
                      href={resolveRecordingPlaybackUrl(studioRecordingState.latestCompleted)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex rounded-full border border-black bg-[#1B1B1B] px-3 py-1.5 text-xs text-[#DFDFDF] hover:bg-[#252525]"
                    >
                      Open Last Recording
                    </a>
                  ) : null}
                  <Button
                    variant="danger"
                    className="mt-2 inline-flex px-3 py-1.5 text-xs"
                    onClick={handleDeleteLatestRecording}
                    loading={studioRecordingState.loading}
                    disabled={!studioRecordingState.latestCompleted?.id || Boolean(studioRecordingState.active)}
                  >
                    Delete Last Recording
                  </Button>
                </>
              ) : (
                <p className="mt-2 text-[11px] text-[#A4A4A4]">
                  OBS mode: publish from OBS using the server URL and key, then monitor playback from this panel. If
                  OBS shows a disconnect warning, keep this session open and use {obsStartActionLabel.toLowerCase()} to
                  re-prepare the same stream without ending the class.
                </p>
              )}
              {studioSession.livekit_egress_error ? (
                <p className="mt-2 text-xs text-amber-300">
                  {isObsStudioMode ? "Stream" : "Egress"}: {studioSession.livekit_egress_error}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-black panel-gradient p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.14em] text-[#949494]">Owncast Chat Control</div>
                <p className="mt-1 text-xs leading-5 text-[#BEBEBE]">
                  Ban or timeout chat users, grant moderator status, hide messages, and manage IP bans from the verified handle map.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  className="px-3 py-1.5 text-xs"
                  onClick={() => loadChatModeration(studioSession.id)}
                  loading={chatModerationState.loading}
                >
                  Refresh
                </Button>
                <Button
                  variant="secondary"
                  className="px-3 py-1.5 text-xs"
                  onClick={() => applyChatModerationAction("sync_handles", {}, "Owncast handles synced.")}
                  loading={chatModerationState.actionLoading === "sync_handles"}
                >
                  Sync Handles
                </Button>
              </div>
            </div>

            {chatModerationState.error ? (
              <p className="mt-3 rounded-xl border border-red-300/30 bg-red-200/10 px-3 py-2 text-xs text-red-200">
                {chatModerationState.error}
              </p>
            ) : null}
            {chatModerationState.info ? (
              <p className="mt-3 rounded-xl border border-black bg-[#121212] px-3 py-2 text-xs text-[#D9D9D9]">
                {chatModerationState.info}
              </p>
            ) : null}

            {chatModerationState.sessionId === studioSession?.id && chatModerationState.data ? (
              <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_1fr_0.8fr]">
                <div className="rounded-xl border border-black bg-[#0D0D0D]/80 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-[#949494]">Mapped Handles</div>
                    <span className="text-[11px] text-[#A7A7A7]">{chatModerationIdentities.length} users</span>
                  </div>
                  <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                    {chatModerationIdentities.length > 0 ? (
                      chatModerationIdentities.map((identity) => (
                        <article key={identity.id || identity.owncast_user_id} className="rounded-lg border border-black bg-[#151515] p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="text-sm font-semibold text-white">{owncastIdentityLabel(identity)}</div>
                              <div className="mt-1 text-[11px] text-[#A8A8A8]">
                                {identity.platform_email || "No platform email"} | {identity.platform_role || "role unknown"}
                              </div>
                              <div className="mt-1 text-[11px] text-[#7F7F7F]">Owncast ID: {identity.owncast_user_id || "-"}</div>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {identity.is_moderator ? (
                                <span className="rounded-full border border-black bg-[#242424] px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-[#E7E7E7]">
                                  Moderator
                                </span>
                              ) : null}
                              {identity.is_disabled ? (
                                <span className="rounded-full border border-red-300/30 bg-red-200/10 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-red-200">
                                  Disabled
                                </span>
                              ) : null}
                              {identity.is_timeout_active ? (
                                <span className="rounded-full border border-amber-300/30 bg-amber-200/10 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-amber-200">
                                  Timeout
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {identity.timeout_until ? (
                            <div className="mt-2 text-[11px] text-[#A8A8A8]">
                              Timeout until: {formatModerationTime(identity.timeout_until)}
                            </div>
                          ) : null}
                          <div className="mt-3 flex flex-wrap gap-2">
                            {identity.is_disabled ? (
                              <Button
                                variant="secondary"
                                className="px-2.5 py-1 text-[11px]"
                                onClick={() =>
                                  applyChatModerationAction(
                                    "unban_user",
                                    { owncast_user_id: identity.owncast_user_id },
                                    `${owncastIdentityLabel(identity)} was unbanned.`
                                  )
                                }
                                loading={chatModerationState.actionLoading === "unban_user"}
                              >
                                Unban
                              </Button>
                            ) : (
                              <>
                                <Button
                                  variant="danger"
                                  className="px-2.5 py-1 text-[11px]"
                                  onClick={() => handleBanOwncastUser(identity)}
                                  loading={chatModerationState.actionLoading === "ban_user"}
                                >
                                  Ban
                                </Button>
                                <Button
                                  variant="secondary"
                                  className="px-2.5 py-1 text-[11px]"
                                  onClick={() => handleTimeoutOwncastUser(identity)}
                                  loading={chatModerationState.actionLoading === "timeout_user"}
                                >
                                  Timeout
                                </Button>
                              </>
                            )}
                            <Button
                              variant="secondary"
                              className="px-2.5 py-1 text-[11px]"
                              onClick={() =>
                                applyChatModerationAction(
                                  identity.is_moderator ? "revoke_moderator" : "grant_moderator",
                                  { owncast_user_id: identity.owncast_user_id },
                                  identity.is_moderator ? "Owncast moderator removed." : "Owncast moderator granted."
                                )
                              }
                              loading={
                                chatModerationState.actionLoading === "grant_moderator" ||
                                chatModerationState.actionLoading === "revoke_moderator"
                              }
                            >
                              {identity.is_moderator ? "Remove Mod" : "Make Mod"}
                            </Button>
                          </div>
                        </article>
                      ))
                    ) : (
                      <p className="rounded-lg border border-black bg-[#151515] px-3 py-2 text-xs text-[#AFAFAF]">
                        No mapped Owncast handles yet. Ask viewers to join chat through the verified chat link, then sync handles.
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-black bg-[#0D0D0D]/80 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-[#949494]">Recent Messages</div>
                    <span className="text-[11px] text-[#A7A7A7]">{chatModerationMessages.length} latest</span>
                  </div>
                  <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                    {chatModerationMessages.length > 0 ? (
                      chatModerationMessages.map((message) => {
                        const messageUser = message.user || {};
                        const isHidden = Boolean(message.hidden_at);
                        return (
                          <article key={message.id} className="rounded-lg border border-black bg-[#151515] p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-xs font-semibold text-white">
                                {messageUser.display_name || "Owncast user"}
                              </div>
                              <span className="text-[10px] text-[#888888]">{formatModerationTime(message.timestamp)}</span>
                            </div>
                            <p className="mt-2 text-xs leading-5 text-[#CFCFCF]">{owncastMessagePreview(message.body)}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="text-[11px] text-[#8F8F8F]">Message ID: {message.id}</span>
                              {isHidden ? (
                                <span className="rounded-full border border-amber-300/30 bg-amber-200/10 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-amber-200">
                                  Hidden
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                variant={isHidden ? "secondary" : "danger"}
                                className="px-2.5 py-1 text-[11px]"
                                onClick={() =>
                                  applyChatModerationAction(
                                    isHidden ? "show_messages" : "hide_messages",
                                    { message_ids: [message.id] },
                                    isHidden ? "Message restored." : "Message hidden."
                                  )
                                }
                                loading={
                                  chatModerationState.actionLoading === "hide_messages" ||
                                  chatModerationState.actionLoading === "show_messages"
                                }
                              >
                                {isHidden ? "Show Message" : "Hide Message"}
                              </Button>
                            </div>
                          </article>
                        );
                      })
                    ) : (
                      <p className="rounded-lg border border-black bg-[#151515] px-3 py-2 text-xs text-[#AFAFAF]">
                        No recent Owncast messages returned yet.
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-black bg-[#0D0D0D]/80 p-3">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-[#949494]">IP Bans</div>
                  <p className="mt-2 text-xs leading-5 text-[#BEBEBE]">
                    Use IP bans only for abuse. Owncast also blocks known IPs automatically when a user is banned.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-xl border border-black bg-[#101010] px-3 py-2 text-xs text-white outline-none focus:border-[#999999]"
                      placeholder="IP address"
                      value={ipBanInput}
                      onChange={(event) => setIpBanInput(event.target.value)}
                    />
                    <Button
                      variant="danger"
                      className="px-3 py-1.5 text-xs"
                      onClick={handleBanOwncastIp}
                      loading={chatModerationState.actionLoading === "ban_ip"}
                    >
                      Ban
                    </Button>
                  </div>
                  <div className="mt-3 max-h-[250px] space-y-2 overflow-y-auto pr-1">
                    {chatModerationIpBans.length > 0 ? (
                      chatModerationIpBans.map((row) => {
                        const ipAddress = String(row.ipAddress || row.ip_address || row.value || "").trim();
                        return (
                          <article key={`${ipAddress}-${row.createdAt || row.created_at || ""}`} className="rounded-lg border border-black bg-[#151515] p-3">
                            <div className="text-xs font-semibold text-white">{ipAddress || "Unknown IP"}</div>
                            <div className="mt-1 text-[11px] text-[#8F8F8F]">
                              Added: {formatModerationTime(row.createdAt || row.created_at)}
                            </div>
                            <Button
                              variant="secondary"
                              className="mt-3 px-2.5 py-1 text-[11px]"
                              onClick={() =>
                                applyChatModerationAction(
                                  "unban_ip",
                                  { ip_address: ipAddress },
                                  `IP ${ipAddress} was unbanned.`
                                )
                              }
                              disabled={!ipAddress}
                              loading={chatModerationState.actionLoading === "unban_ip"}
                            >
                              Unban IP
                            </Button>
                          </article>
                        );
                      })
                    ) : (
                      <p className="rounded-lg border border-black bg-[#151515] px-3 py-2 text-xs text-[#AFAFAF]">
                        No Owncast IP bans returned.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-xl border border-black bg-[#121212] px-3 py-2 text-xs text-[#BEBEBE]">
                Open Chat Control or refresh to load current Owncast moderation state.
              </p>
            )}
          </div>
        </section>
      ) : null}

      {joinState.error ? (
        <div className="mb-4 rounded-xl border border-red-300/30 bg-red-200/10 px-4 py-3 text-sm text-red-200">
          {joinState.error}
        </div>
      ) : null}

      {joinState.info ? (
        <div className="mb-4 rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
          {joinState.info}
        </div>
      ) : null}

      {deleteState.error ? (
        <div className="mb-4 rounded-xl border border-red-300/30 bg-red-200/10 px-4 py-3 text-sm text-red-200">
          {deleteState.error}
        </div>
      ) : null}

      {deleteState.info ? (
        <div className="mb-4 rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
          {deleteState.info}
        </div>
      ) : null}

      {streamControlState.error ? (
        <div className="mb-4 rounded-xl border border-red-300/30 bg-red-200/10 px-4 py-3 text-sm text-red-200">
          {streamControlState.error}
        </div>
      ) : null}

      {streamControlState.info ? (
        <div className="mb-4 rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
          {streamControlState.info}
        </div>
      ) : null}

      {shareState.error ? (
        <div className="mb-4 rounded-xl border border-red-300/30 bg-red-200/10 px-4 py-3 text-sm text-red-200">
          {shareState.error}
        </div>
      ) : null}

      {shareState.info ? (
        <div className="mb-4 rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
          {shareState.info}
        </div>
      ) : null}

      {activeBroadcast ? (
        <section className="mb-6 rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-[#DFDFDF]">Viewing: {activeBroadcast.session?.title}</span>
            <span className="rounded-full border border-black bg-[#171717] px-3 py-1 text-xs uppercase tracking-[0.12em] text-[#CDCDCD]">
              Live Broadcast
            </span>
          </div>

          <div className="mb-4 rounded-xl border border-black panel-gradient px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-[#949494]">Stream URL</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="max-w-full truncate rounded-md bg-[#0E0E0E] px-2 py-1 text-xs text-[#DFDFDF]">
                {activeStreamUrl || "Stream URL not configured for this session."}
              </code>
              <Button
                variant="secondary"
                className="px-3 py-1.5 text-xs"
                onClick={() => handleCopyStreamLink(activeBroadcast?.session)}
                disabled={!activeStreamUrl}
              >
                Copy
              </Button>
            </div>
          </div>

          <BroadcastViewerTheater
            title={activeBroadcast.session?.title}
            streamUrl={activeStreamUrl}
            chatUrl={resolvedActiveChatUrl}
            chatFallbackMessage={activeChatFallbackMessage}
            streamStatus={activeBroadcast.broadcast?.stream_status}
            sessionStatus={activeBroadcast.session?.status}
            showHeaderMeta={false}
            withContainer={false}
            statusMessage={activeBroadcastStatusMessage}
            onRefreshStream={handleRefreshActiveBroadcast}
          />
        </section>
      ) : null}

      <section className="rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-reference text-xl font-semibold text-white">Broadcast Sessions</h3>
            <p className="mt-1 text-xs text-[#949494]">Create events, publish live, and manage audience access.</p>
          </div>
          <span className="text-xs text-[#949494]">
            {loading ? "Loading..." : `${orderedSessions.length} session${orderedSessions.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {isAuthenticated ? (
          <>
            {error ? (
              <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
                {error}
              </div>
            ) : null}
            {orderedSessions.length > 0 ? (
              <div className="space-y-3">
                {orderedSessions.map((session) => (
                  <article
                    key={session.id}
                    className="grid gap-3 rounded-2xl border border-black panel-gradient p-4 shadow-[0_14px_34px_rgba(0,0,0,0.22)] md:grid-cols-[1fr_auto] md:items-center"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-reference text-lg text-white">{session.title}</h4>
                        <span className="rounded-full border border-black bg-[#171717] px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[#CDCDCD]">
                          {session.stream_status === "live" ? "Live" : "Ready"}
                        </span>
                        <span className="rounded-full border border-black bg-[#171717] px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[#CDCDCD]">
                          {getStreamServiceLabel(session)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                        {session.description || "Large-audience broadcast session with moderated chat."}
                      </p>
                      {canManageSession(session, user) ? (
                        <div className="mt-3 rounded-lg border border-black panel-gradient px-3 py-2">
                          <div className="text-[10px] uppercase tracking-[0.12em] text-[#949494]">Join URL</div>
                          <code className="mt-1 block truncate text-xs text-[#DFDFDF]">{buildJoinLink(session)}</code>
                        </div>
                      ) : null}
                    </div>
                    <div className="grid w-full gap-2 sm:grid-cols-2 md:w-[260px] md:grid-cols-1">
                      <Button
                        className="w-full"
                        loading={joinState.loadingId === session.id}
                        onClick={() => handleJoin(session.id)}
                      >
                        Join Broadcast
                      </Button>
                      {canManageSession(session, user) ? (
                        <>
                          <Link to={`/join-live?session=${session.id}`} className="block w-full">
                            <Button variant="secondary" className="w-full">
                              Open Stage Control
                            </Button>
                          </Link>
                          <Button variant="secondary" className="w-full" onClick={() => handleOpenStudio(session)}>
                            Open Host Studio
                          </Button>
                          <Button
                            variant="secondary"
                            className="w-full"
                            onClick={() => handleOpenChatControl(session)}
                            loading={chatModerationState.loading && chatModerationState.sessionId === session.id}
                          >
                            Open Chat Control
                          </Button>
                          <Button
                            variant="danger"
                            className="w-full"
                            onClick={() => handleStopSessionStream(session)}
                            loading={streamControlState.loadingId === session.id}
                          >
                            Stop Broadcast
                          </Button>
                          <Button
                            variant="danger"
                            className="w-full"
                            onClick={() => handleDeleteSession(session)}
                            loading={deleteState.loadingId === session.id}
                          >
                            Delete Session
                          </Button>
                          <Button variant="secondary" className="w-full" onClick={() => handleCopyJoinLink(session)}>
                            Copy Join Link
                          </Button>
                        </>
                      ) : (
                        <Button variant="secondary" className="w-full" disabled>
                          Viewer Mode
                        </Button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
                No broadcast sessions available yet. Create one from the panel above.
              </div>
            )}
          </>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-3">
              {broadcastMarketingCards.map((card) => (
                <article
                  key={card.title}
                  className="rounded-2xl border border-black panel-gradient p-4 shadow-[0_14px_34px_rgba(0,0,0,0.22)]"
                >
                  <h4 className="font-reference text-lg text-white">{card.title}</h4>
                  <p className="mt-2 text-sm text-[#BBBBBB]">{card.description}</p>
                </article>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
              {loading
                ? "Preparing live event details..."
                : "Sign in to access broadcast sessions. Public view intentionally shows a marketing overview."}
              {error ? " Live session data is currently unavailable." : ""}
            </div>
          </>
        )}
      </section>
    </PageShell>
  );
}
