import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Room, createLocalAudioTrack, createLocalVideoTrack } from "livekit-client";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { listLiveClasses } from "../api/courses";
import {
  createRealtimeSession,
  deleteRealtimeRecording,
  endRealtimeSession,
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
import { ScreenityFallbackRecorder } from "../services/recording/ScreenityFallbackRecorder";
import { apiData, apiMessage } from "../utils/api";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const initialForm = {
  title: "",
  description: "",
  linked_live_class_id: "",
  stream_embed_url: "",
  chat_embed_url: "",
  rtmp_target_url: "",
};

const defaultBroadcastProfile = {
  capture_width: 640,
  capture_height: 360,
  fps: 20,
  max_video_bitrate_kbps: 650,
};

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function deriveEmbedUrl(baseUrl, targetPath) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.pathname = targetPath;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function canManageSession(session, user) {
  if (!session) return false;
  if (session.can_manage) return true;
  if (session.is_host) return true;
  return user?.is_admin === true;
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
  "Chat-first audience mode",
  "Supports up to 50,000 viewers",
];

const broadcastWorkflow = [
  {
    step: "Create",
    detail: "Open a broadcast session and configure optional stream/chat embed links.",
  },
  {
    step: "Publish",
    detail: "Connect camera and microphone in Host Studio, then start live delivery.",
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
  const [deleteState, setDeleteState] = useState({ loadingId: null, error: "", info: "" });
  const [streamControlState, setStreamControlState] = useState({
    loadingId: null,
    error: "",
    info: "",
  });
  const [shareState, setShareState] = useState({ error: "", info: "" });

  const [studioSession, setStudioSession] = useState(null);
  const [studioProfile, setStudioProfile] = useState(defaultBroadcastProfile);
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
  const previewVideoRef = useRef(null);
  const fallbackRecorderRef = useRef(null);

  const highlightedSessionId = searchParams.get("session");

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
    setStudioProfile(defaultBroadcastProfile);
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
        meeting_capacity: 200,
        max_audience: 50000,
        allow_overflow_broadcast: true,
        stream_embed_url: form.stream_embed_url,
        chat_embed_url: form.chat_embed_url,
        rtmp_target_url: form.rtmp_target_url,
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
    setStudioSession(session);
    setStudioState((prev) => ({ ...prev, error: "", info: "Host studio selected." }));
  };

  const getSessionStreamUrl = (session) => {
    const explicitUrl = (session?.stream_embed_url || "").trim();
    if (explicitUrl) {
      return explicitUrl;
    }
    if (activeBroadcast?.session?.id === session?.id) {
      return (activeBroadcast?.broadcast?.stream_embed_url || "").trim();
    }
    return "";
  };

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
      await navigator.clipboard.writeText(value);
      setShareState({ error: "", info: successMessage });
    } catch {
      setShareState({ error: errorMessage, info: "" });
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

  const handleConnectCamera = async () => {
    if (!studioSession) return;
    setStudioState({ connecting: true, connected: false, actionLoading: false, error: "", info: "Connecting camera..." });

    try {
      disconnectStudio();
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

      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
      });
      await room.connect(tokenData.livekit_url, tokenData.token);

      const [videoTrack, audioTrack] = await Promise.all([
        createLocalVideoTrack({
          facingMode: "user",
          resolution: {
            width: profile.capture_width,
            height: profile.capture_height,
          },
          frameRate: profile.fps,
        }),
        createLocalAudioTrack(),
      ]);
      if (videoTrack?.mediaStreamTrack && "contentHint" in videoTrack.mediaStreamTrack) {
        videoTrack.mediaStreamTrack.contentHint = "detail";
      }

      await room.localParticipant.publishTrack(videoTrack, {
        simulcast: false,
        videoEncoding: {
          maxBitrate: profile.max_video_bitrate_kbps * 1000,
          maxFramerate: profile.fps,
        },
        degradationPreference: "maintain-resolution",
      });
      await room.localParticipant.publishTrack(audioTrack);

      if (previewVideoRef.current) {
        videoTrack.attach(previewVideoRef.current);
      }

      roomRef.current = room;
      localVideoTrackRef.current = videoTrack;
      localAudioTrackRef.current = audioTrack;
      setStudioProfile(profile);

      setStudioState({
        connecting: false,
        connected: true,
        actionLoading: false,
        error: "",
        info: `Camera connected (${profile.capture_width}x${profile.capture_height} @ ${profile.fps}fps, ${profile.max_video_bitrate_kbps}kbps). Click Start Live to begin streaming. If admin changes profile, reconnect camera to apply.`,
      });
    } catch (err) {
      disconnectStudio();
      setStudioState({
        connecting: false,
        connected: false,
        actionLoading: false,
        error: apiMessage(err, "Unable to access camera/microphone for browser publishing."),
        info: "",
      });
    }
  };

  const handleStartLive = async () => {
    if (!studioSession) return;
    if (!studioState.connected) {
      setStudioState((prev) => ({ ...prev, error: "Connect camera first before starting live." }));
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
        info: "You are live. Viewers can watch from the broadcast player.",
      }));
      await handleJoin(studioSession.id);
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
    if (!highlightedSessionId || !isAuthenticated || activeBroadcast) {
      return;
    }
    const sessionId = Number(highlightedSessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return;
    }
    handleJoin(sessionId);
  }, [highlightedSessionId, isAuthenticated]);

  const studioStreamUrl = getSessionStreamUrl(studioSession);
  const activeStreamUrl = useMemo(() => {
    const direct = String(activeBroadcast?.broadcast?.stream_embed_url || "").trim();
    if (direct) return direct;
    return deriveEmbedUrl(activeBroadcast?.broadcast?.chat_embed_url, "/embed/video");
  }, [activeBroadcast]);
  const activeChatUrl = useMemo(() => {
    const direct = String(activeBroadcast?.broadcast?.chat_embed_url || "").trim();
    if (direct) return direct;
    return deriveEmbedUrl(activeBroadcast?.broadcast?.stream_embed_url, "/embed/chat/readwrite");
  }, [activeBroadcast]);

  return (
    <PageShell title="" subtitle="">
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
                Hosts publish directly from browser camera and microphone. Live delivery is managed
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

      {studioSession?.is_host ? (
        <section className="mb-6 rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-reference text-xl font-semibold text-white">Host Studio</h3>
              <p className="mt-1 text-xs text-[#949494]">Session: {studioSession.title}</p>
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
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="overflow-hidden rounded-2xl border border-black bg-black">
              <video
                ref={previewVideoRef}
                autoPlay
                muted
                playsInline
                className="h-[220px] w-full object-cover sm:h-[280px] lg:h-[320px]"
              />
            </div>
            <div className="rounded-2xl border border-black panel-gradient p-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <Button onClick={handleConnectCamera} loading={studioState.connecting || studioState.actionLoading}>
                  {studioState.connected ? "Reconnect Camera" : "Connect Camera"}
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

              {studioState.error ? <p className="mt-3 text-xs text-red-300">{studioState.error}</p> : null}
              {studioState.info ? <p className="mt-3 text-xs text-zinc-300">{studioState.info}</p> : null}
              {studioRecordingState.error ? <p className="mt-2 text-xs text-red-300">{studioRecordingState.error}</p> : null}
              {studioRecordingState.info ? <p className="mt-2 text-xs text-zinc-300">{studioRecordingState.info}</p> : null}
              <p className="mt-2 text-[11px] text-[#A4A4A4]">
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
              {studioSession.livekit_egress_error ? (
                <p className="mt-2 text-xs text-amber-300">Egress: {studioSession.livekit_egress_error}</p>
              ) : null}
            </div>
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

          <div className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
            <div className="overflow-hidden rounded-2xl border border-black bg-black">
              {activeStreamUrl ? (
                <iframe
                  title="Broadcast Stream"
                  src={activeStreamUrl}
                  className="h-[260px] w-full sm:h-[340px] lg:h-[440px]"
                  allow="autoplay; fullscreen"
                />
              ) : (
                <div className="flex h-[260px] items-center justify-center px-6 text-center text-sm text-[#BBBBBB] sm:h-[340px] lg:h-[440px]">
                  Stream URL not configured for this session.
                </div>
              )}
            </div>
            <div className="overflow-hidden rounded-2xl border border-black panel-gradient">
              {activeChatUrl ? (
                <iframe
                  title="Broadcast Chat"
                  src={activeChatUrl}
                  className="h-[260px] w-full sm:h-[340px] lg:h-[440px]"
                  allow="clipboard-read; clipboard-write"
                />
              ) : (
                <div className="flex h-[260px] items-center justify-center px-6 text-center text-sm text-[#BBBBBB] sm:h-[340px] lg:h-[440px]">
                  Chat URL not configured for this session.
                </div>
              )}
            </div>
          </div>
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
                          <Button variant="secondary" className="w-full" onClick={() => handleOpenStudio(session)}>
                            Open Host Studio
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
