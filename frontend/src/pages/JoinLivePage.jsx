import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import BroadcastViewerTheater from "../components/realtime/BroadcastViewerTheater";
import MeetingRoomExperience from "../components/realtime/MeetingRoomExperience";
import { createRealtimeOwncastChatLaunch, joinRealtimeSession, listRealtimeSessions } from "../api/realtime";
import { useAuth } from "../hooks/useAuth";
import useAdaptiveRealtimeSessionPolling from "../hooks/useAdaptiveRealtimeSessionPolling";
import {
  clearPersistedMeetingSessionId,
  persistMeetingSessionId,
  readPersistedMeetingSessionId,
} from "../utils/activeMeetingStorage";
import { resolveBroadcastEmbedUrls } from "../utils/broadcastUrls";
import { apiData, apiMessage } from "../utils/api";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const modeOptions = [
  { key: "all", label: "All Sessions" },
  { key: "meeting", label: "Meetings" },
  { key: "broadcasting", label: "Broadcasts" },
];
const ACTIVE_BROADCAST_STORAGE_KEY = "streamx:join-live:active-broadcast";

function sanitizeBroadcastSession(session) {
  if (!session?.id) return null;
  return {
    id: session.id,
    title: session.title || "",
    slug: session.slug || "",
    session_type: session.session_type || "broadcasting",
    status: session.status || "",
    stream_status: session.stream_status || "",
  };
}

function sanitizeBroadcastPayload(payload) {
  if (!payload || payload.mode !== "broadcast") return null;
  const session = sanitizeBroadcastSession(payload.session);
  if (!session) return null;
  return {
    mode: "broadcast",
    session,
    broadcast: {
      stream_embed_url: payload.broadcast?.stream_embed_url || "",
      chat_embed_url: payload.broadcast?.chat_embed_url || "",
      max_audience: payload.broadcast?.max_audience ?? null,
      stream_status: payload.broadcast?.stream_status || session.stream_status || "",
    },
  };
}

function readPersistedBroadcastPayload() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_BROADCAST_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return sanitizeBroadcastPayload(parsed);
  } catch {
    return null;
  }
}

function persistBroadcastPayload(payload) {
  if (typeof window === "undefined") return;
  try {
    const sanitizedPayload = sanitizeBroadcastPayload(payload);
    if (sanitizedPayload) {
      window.localStorage.setItem(ACTIVE_BROADCAST_STORAGE_KEY, JSON.stringify(sanitizedPayload));
      return;
    }
    window.localStorage.removeItem(ACTIVE_BROADCAST_STORAGE_KEY);
  } catch {
    // best-effort browser persistence only
  }
}

function statusBadgeClass(status) {
  if (status === "live") {
    return "border-zinc-400/30 bg-zinc-400/10 text-zinc-200";
  }
  if (status === "scheduled") {
    return "border-amber-300/30 bg-amber-300/10 text-amber-200";
  }
  return "border-black bg-[#171717] text-[#CDCDCD]";
}

function sessionTypeLabel(sessionType) {
  return sessionType === "broadcasting" ? "Broadcast" : "Meeting";
}

export default function JoinLivePage() {
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const [searchParams] = useSearchParams();
  const authenticatedUserId = Number(user?.id || 0) || null;

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [joinState, setJoinState] = useState({ loadingId: null, error: "", info: "" });
  const [activeSession, setActiveSession] = useState(() => readPersistedBroadcastPayload());
  const [broadcastChatLaunch, setBroadcastChatLaunch] = useState({
    sessionId: null,
    sourceUrl: "",
    url: "",
    loading: false,
  });
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("all");
  const [autoJoinConsumed, setAutoJoinConsumed] = useState(false);
  const [meetingRestoreConsumed, setMeetingRestoreConsumed] = useState(false);

  const highlightedSessionId = useMemo(() => {
    const raw = searchParams.get("session");
    const value = Number(raw || 0);
    return Number.isInteger(value) && value > 0 ? value : null;
  }, [searchParams]);

  useEffect(() => {
    setAutoJoinConsumed(false);
  }, [highlightedSessionId]);

  const loadSessions = async () => {
    try {
      const response = await listRealtimeSessions({ status: "all" });
      const data = apiData(response, []);
      const rows = Array.isArray(data) ? data.filter((item) => item.status !== "ended") : [];
      setSessions(rows);
      setError("");
    } catch (err) {
      setError(apiMessage(err, "Unable to load live sessions."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  const orderedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const statusWeight = { live: 1, scheduled: 2, ended: 3 };
      const aWeight = statusWeight[a.status] || 4;
      const bWeight = statusWeight[b.status] || 4;
      if (aWeight !== bWeight) return aWeight - bWeight;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    return orderedSessions.filter((session) => {
      if (mode !== "all" && session.session_type !== mode) {
        return false;
      }
      if (!trimmed) {
        return true;
      }
      return (
        (session.title || "").toLowerCase().includes(trimmed) ||
        (session.description || "").toLowerCase().includes(trimmed) ||
        (session.host?.full_name || "").toLowerCase().includes(trimmed)
      );
    });
  }, [mode, orderedSessions, query]);

  const stats = useMemo(() => {
    const liveCount = orderedSessions.filter((session) => session.status === "live").length;
    const meetingCount = orderedSessions.filter((session) => session.session_type === "meeting").length;
    const broadcastCount = orderedSessions.filter(
      (session) => session.session_type === "broadcasting"
    ).length;
    return {
      total: orderedSessions.length,
      live: liveCount,
      meeting: meetingCount,
      broadcasting: broadcastCount,
    };
  }, [orderedSessions]);

  const handleJoin = async (sessionId) => {
    setJoinState({ loadingId: sessionId, error: "", info: "" });
    try {
      const response = await joinRealtimeSession(sessionId, {
        display_name: user?.full_name || "",
      });
      const data = apiData(response, null);
      const nextActiveSession = data?.mode === "broadcast" ? sanitizeBroadcastPayload(data) : data;
      setActiveSession(nextActiveSession);
      persistBroadcastPayload(nextActiveSession);
      persistMeetingSessionId(data?.mode === "meeting" ? data?.session?.id : null, authenticatedUserId);
      setJoinState({ loadingId: null, error: "", info: "Joined live session." });
      await loadSessions();
    } catch (err) {
      setJoinState({ loadingId: null, error: apiMessage(err, "Unable to join live session."), info: "" });
    }
  };

  const handleReconnectMeeting = async (sessionId) => {
    const response = await joinRealtimeSession(sessionId, {
      display_name: user?.full_name || "",
    });
    const data = apiData(response, null);
    const nextActiveSession = data?.mode === "broadcast" ? sanitizeBroadcastPayload(data) : data;
    setActiveSession(nextActiveSession);
    persistBroadcastPayload(nextActiveSession);
    persistMeetingSessionId(data?.mode === "meeting" ? data?.session?.id : null, authenticatedUserId);
    await loadSessions();
    return data;
  };

  useEffect(() => {
    if (!highlightedSessionId || autoJoinConsumed) {
      return;
    }
    if (activeSession?.session?.id === highlightedSessionId) {
      setAutoJoinConsumed(true);
      return;
    }
    setAutoJoinConsumed(true);
    handleJoin(highlightedSessionId);
  }, [activeSession?.session?.id, autoJoinConsumed, highlightedSessionId]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (
      meetingRestoreConsumed ||
      !isAuthenticated ||
      !authenticatedUserId ||
      highlightedSessionId ||
      activeSession?.mode === "broadcast"
    ) {
      return;
    }
    if (activeSession?.mode === "meeting" && activeSession?.session?.id) {
      setMeetingRestoreConsumed(true);
      return;
    }
    const persistedMeetingSessionId = readPersistedMeetingSessionId(authenticatedUserId);
    setMeetingRestoreConsumed(true);
    if (!persistedMeetingSessionId) {
      return;
    }
    handleReconnectMeeting(persistedMeetingSessionId).catch(() => {
      clearPersistedMeetingSessionId();
    });
  }, [
    activeSession?.mode,
    activeSession?.session?.id,
    authLoading,
    authenticatedUserId,
    highlightedSessionId,
    isAuthenticated,
    meetingRestoreConsumed,
  ]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (!activeSession) {
      persistBroadcastPayload(null);
      clearPersistedMeetingSessionId();
      return;
    }
    if (activeSession.mode === "broadcast") {
      persistBroadcastPayload(activeSession);
      clearPersistedMeetingSessionId();
      return;
    }
    if (activeSession.mode === "meeting") {
      persistBroadcastPayload(null);
      persistMeetingSessionId(activeSession.session?.id, authenticatedUserId);
      return;
    }
    persistBroadcastPayload(null);
    clearPersistedMeetingSessionId();
  }, [activeSession, authLoading, authenticatedUserId]);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    setMeetingRestoreConsumed(false);
  }, [authLoading, authenticatedUserId]);

  const applyActiveBroadcastSessionUpdate = useCallback((latestSession) => {
    if (!latestSession) {
      return;
    }
    setSessions((previous) => {
      const nextRows = previous.filter((item) => item.id !== latestSession.id);
      if (latestSession.status !== "ended") {
        nextRows.unshift(latestSession);
      }
      return nextRows;
    });
    setActiveSession((previous) => {
      if (!previous || previous.mode !== "broadcast" || previous.session?.id !== latestSession.id) {
        return previous;
      }
      const nextPayload = sanitizeBroadcastPayload({
        ...previous,
        session: { ...previous.session, ...latestSession },
        broadcast: {
          ...previous.broadcast,
          stream_status: latestSession.stream_status || previous.broadcast?.stream_status || "",
        },
      });
      if (!nextPayload) {
        persistBroadcastPayload(null);
        return null;
      }
      if (latestSession.status !== "ended") {
        persistBroadcastPayload(nextPayload);
      } else {
        persistBroadcastPayload(null);
      }
      return nextPayload;
    });
  }, []);

  const handleRefreshActiveBroadcast = useAdaptiveRealtimeSessionPolling({
    enabled: activeSession?.mode === "broadcast",
    sessionId: activeSession?.mode === "broadcast" ? activeSession?.session?.id : null,
    sessionStatus: activeSession?.session?.status,
    streamStatus: activeSession?.broadcast?.stream_status,
    onSessionData: applyActiveBroadcastSessionUpdate,
  });

  const activeBroadcastUrls = useMemo(() => {
    if (!activeSession || activeSession.mode !== "broadcast") {
      return { streamEmbedUrl: "", chatEmbedUrl: "", writableChatEmbedUrl: "" };
    }
    return resolveBroadcastEmbedUrls({
      streamEmbedUrl: activeSession.broadcast?.stream_embed_url,
      chatEmbedUrl: activeSession.broadcast?.chat_embed_url,
    });
  }, [activeSession]);

  const activeBroadcastStreamUrl = activeBroadcastUrls.streamEmbedUrl;
  const activeBroadcastChatUrl =
    activeBroadcastUrls.writableChatEmbedUrl || activeBroadcastUrls.chatEmbedUrl;
  const shouldUsePersonalizedBroadcastChat =
    activeSession?.mode === "broadcast" && Boolean(activeSession?.session?.id) && Boolean(activeBroadcastChatUrl);
  const activeBroadcastResolvedChatUrl =
    shouldUsePersonalizedBroadcastChat &&
    broadcastChatLaunch.sessionId === activeSession?.session?.id &&
    broadcastChatLaunch.sourceUrl === activeBroadcastChatUrl
      ? broadcastChatLaunch.url
      : shouldUsePersonalizedBroadcastChat
        ? ""
        : activeBroadcastChatUrl;
  const activeBroadcastChatFallbackMessage = shouldUsePersonalizedBroadcastChat
    ? broadcastChatLaunch.loading
      ? "Preparing your verified chat session..."
      : "Verified chat could not be prepared. Refresh the page or sign in again."
    : "Chat URL not configured for this session.";
  const activeBroadcastStatusMessage =
    activeSession?.mode === "broadcast"
      ? activeSession?.session?.status === "ended"
        ? "This broadcast session has ended."
        : String(activeSession?.broadcast?.stream_status || "").trim().toLowerCase() === "starting"
          ? "The host is reconnecting OBS. Keep chat open and the video will resume here when the stream is back."
        : activeSession?.broadcast?.stream_status &&
            String(activeSession.broadcast.stream_status).trim().toLowerCase() !== "live"
          ? "The video stream is temporarily offline. Keep chat open while the host reconnects OBS."
          : ""
      : "";

  useEffect(() => {
    if (!shouldUsePersonalizedBroadcastChat) {
      setBroadcastChatLaunch({ sessionId: null, sourceUrl: "", url: "", loading: false });
      return undefined;
    }

    const sessionId = activeSession.session.id;
    if (authLoading) {
      setBroadcastChatLaunch({ sessionId, sourceUrl: activeBroadcastChatUrl, url: "", loading: true });
      return undefined;
    }
    if (!isAuthenticated) {
      setBroadcastChatLaunch({ sessionId, sourceUrl: activeBroadcastChatUrl, url: "", loading: false });
      return undefined;
    }

    let cancelled = false;
    setBroadcastChatLaunch({ sessionId, sourceUrl: activeBroadcastChatUrl, url: "", loading: true });
    createRealtimeOwncastChatLaunch(sessionId)
      .then((response) => {
        if (cancelled) return;
        const data = apiData(response, {});
        const launchUrl = String(data?.launch_url || "").trim();
        setBroadcastChatLaunch({
          sessionId,
          sourceUrl: activeBroadcastChatUrl,
          url: launchUrl,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setBroadcastChatLaunch({ sessionId, sourceUrl: activeBroadcastChatUrl, url: "", loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeBroadcastChatUrl,
    activeSession?.mode,
    activeSession?.session?.id,
    authLoading,
    isAuthenticated,
    shouldUsePersonalizedBroadcastChat,
  ]);

  return (
    <PageShell
      title="Join Live"
      subtitle="Access all active meetings and broadcasts from one premium live operations screen."
      badge="LIVE ACCESS"
      decryptTitle
      containerClassName="xl:max-w-[86rem] 2xl:max-w-[92rem]"
    >
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

        <div className="relative grid gap-5 p-5 sm:p-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <h2 className="font-reference text-3xl font-semibold leading-tight text-white sm:text-4xl">
              Elegant unified entry for every live experience
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[#BBBBBB]">
              Join two-way meeting rooms, switch into stream mode when sessions scale, and keep users
              in one polished workflow.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-black bg-[#131313]/92 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-[#949494]">Live Now</div>
                <div className="mt-1 text-2xl font-semibold text-white">{stats.live}</div>
              </div>
              <div className="rounded-xl border border-black bg-[#131313]/92 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-[#949494]">Total Active</div>
                <div className="mt-1 text-2xl font-semibold text-white">{stats.total}</div>
              </div>
              <div className="rounded-xl border border-black bg-[#131313]/92 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-[#949494]">Meetings</div>
                <div className="mt-1 text-2xl font-semibold text-white">{stats.meeting}</div>
              </div>
              <div className="rounded-xl border border-black bg-[#131313]/92 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.14em] text-[#949494]">Broadcasts</div>
                <div className="mt-1 text-2xl font-semibold text-white">{stats.broadcasting}</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-black panel-gradient p-5 backdrop-blur-sm">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              Join Workflow
            </div>
            <div className="mt-3 space-y-2">
              {[
                "Find a live session or search by title/host.",
                "Join meeting mode for interactive class participation.",
                "When overflow triggers, continue in broadcast mode with chat.",
                "Stay in one page without losing session context.",
              ].map((item, index) => (
                <div
                  key={item}
                  className="flex items-start gap-3 rounded-xl border border-black panel-gradient px-3 py-3 text-sm text-[#C8C8C8]"
                >
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-black bg-[#151515] text-[10px] font-semibold text-[#D9D9D9]">
                    {index + 1}
                  </span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

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

      {activeSession?.mode === "meeting" ? (
        <MeetingRoomExperience
          payload={activeSession}
          onLeave={() => {
            clearPersistedMeetingSessionId();
            setActiveSession(null);
          }}
          onReconnect={handleReconnectMeeting}
          audiencePanel
        />
      ) : null}

      {activeSession?.mode === "broadcast" ? (
        <BroadcastViewerTheater
          title={activeSession.session?.title}
          streamUrl={activeBroadcastStreamUrl}
          chatUrl={activeBroadcastResolvedChatUrl}
          chatFallbackMessage={activeBroadcastChatFallbackMessage}
          streamStatus={activeSession.broadcast?.stream_status}
          sessionStatus={activeSession.session?.status}
          badgeLabel="Live Broadcast"
          statusMessage={activeBroadcastStatusMessage}
          onRefreshStream={handleRefreshActiveBroadcast}
        />
      ) : null}

      <section className="rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-reference text-xl font-semibold text-white">Available Live Sessions</h3>
            <p className="mt-1 text-xs text-[#949494]">Clean list view with smart filters and one-click join.</p>
          </div>
          <span className="text-xs text-[#949494]">
            {loading ? "Loading..." : `${filteredSessions.length} session${filteredSessions.length === 1 ? "" : "s"}`}
          </span>
        </div>

        <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2.5 text-sm text-white outline-none focus:border-[#999999]"
            placeholder="Search by session title or description"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {modeOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setMode(option.key)}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] transition ${
                  mode === option.key
                    ? "border-[#D9D9D9] bg-[#D9D9D9] text-[#141414]"
                    : "border-black bg-[#161616] text-[#CDCDCD] hover:bg-[#1E1E1E]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
            {error}
          </div>
        ) : null}

        {filteredSessions.length > 0 ? (
          <div className="space-y-3">
            {filteredSessions.map((session) => (
              <article
                key={session.id}
                className={`grid gap-4 rounded-2xl border panel-gradient p-4 shadow-[0_14px_34px_rgba(0,0,0,0.22)] md:grid-cols-[1fr_auto] md:items-center ${
                  session.id === highlightedSessionId ? "border-[#D9D9D9]/40" : "border-black"
                }`}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-1 text-[11px] uppercase tracking-[0.12em] ${statusBadgeClass(session.status)}`}
                    >
                      {session.status}
                    </span>
                    <span className="rounded-full border border-black bg-[#171717] px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[#CDCDCD]">
                      {sessionTypeLabel(session.session_type)}
                    </span>
                    {session.id === highlightedSessionId ? (
                      <span className="rounded-full border border-black bg-[#D9D9D9]/10 px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[#D9D9D9]">
                        Shared Link
                      </span>
                    ) : null}
                  </div>
                  <h4 className="mt-2 font-reference text-xl text-white">{session.title}</h4>
                  <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                    {session.description || "Live session with classroom or broadcast format."}
                  </p>
                </div>
                <Button
                  className="w-full md:w-[160px]"
                  loading={joinState.loadingId === session.id}
                  onClick={() => handleJoin(session.id)}
                >
                  Join Session
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
            No sessions match this filter right now.
          </div>
        )}
      </section>
    </PageShell>
  );
}
