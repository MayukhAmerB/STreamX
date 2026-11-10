import "../features/live-classes/LiveClasses.scss";

import { Search as SearchIcon } from "@carbon/icons-react";
import { Button, ContentSwitcher, Search, Switch } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import BroadcastViewerTheater from "../components/realtime/BroadcastViewerTheater";
import MeetingRoomExperience from "../components/realtime/MeetingRoomExperience";
import { createRealtimeOwncastChatLaunch, joinRealtimeSession, listRealtimeSessions } from "../api/realtime";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, useToast } from "../features/app-shell/ui";
import {
  LeaveClassButton,
  LiveMeetingFrame,
  LiveNowCard,
  NextClassCard,
  SessionTile,
} from "../features/live-classes/LiveCards";
import {
  SESSION_FILTERS,
  SESSION_SEARCH_THRESHOLD,
  countLiveSessions,
  filterLiveSessions,
  filterSessionsForCourse,
  shouldShowSessionFilter,
  sortLiveSessions,
} from "../features/live-classes/liveSessions";
import { formatScheduleSummary } from "../features/live-classes/schedule";
import { useAuth } from "../hooks/useAuth";
import useAdaptiveRealtimeSessionPolling from "../hooks/useAdaptiveRealtimeSessionPolling";
import {
  clearPersistedMeetingSessionId,
  persistMeetingSessionId,
  readPersistedMeetingSessionId,
} from "../utils/activeMeetingStorage";
import { resolveBroadcastEmbedUrls } from "../utils/broadcastUrls";
import { apiData, apiMessage } from "../utils/api";
import {
  findJoinableLiveSession,
  isJoinableLiveSession,
  resolveLiveClassSchedule,
} from "../utils/liveClassSchedule";

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

export default function JoinLivePage() {
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const { showToast } = useToast();
  const { id: courseIdParam } = useParams();
  const [searchParams] = useSearchParams();
  const authenticatedUserId = Number(user?.id || 0) || null;
  const courseId = useMemo(() => {
    const parsed = Number(courseIdParam || 0);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [courseIdParam]);

  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [joinState, setJoinState] = useState({ loadingId: null, error: "", info: "" });
  const [activeSession, setActiveSession] = useState(() => readPersistedBroadcastPayload());
  const [broadcastChatLaunch, setBroadcastChatLaunch] = useState({
    sessionId: null,
    sourceUrl: "",
    url: "",
    expiresAt: 0,
    loading: false,
  });
  const [broadcastChatLaunchRefreshKey, setBroadcastChatLaunchRefreshKey] = useState(0);
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
    const refreshId = window.setInterval(loadSessions, 30_000);
    return () => window.clearInterval(refreshId);
  }, []);

  const orderedSessions = useMemo(() => sortLiveSessions(sessions), [sessions]);
  const courseSessions = useMemo(
    () => filterSessionsForCourse(orderedSessions, courseId),
    [courseId, orderedSessions]
  );
  const stats = useMemo(() => countLiveSessions(courseSessions), [courseSessions]);
  const showModeFilter = shouldShowSessionFilter(stats);
  const showSearch = courseSessions.length >= SESSION_SEARCH_THRESHOLD || Boolean(query);
  const effectiveMode = showModeFilter ? mode : "all";
  const filteredSessions = useMemo(
    () => filterLiveSessions(courseSessions, { mode: effectiveMode, query }),
    [courseSessions, effectiveMode, query]
  );

  const liveSchedule = useMemo(() => resolveLiveClassSchedule(courseSessions), [courseSessions]);
  const joinableLiveSession = useMemo(
    () => findJoinableLiveSession(courseSessions),
    [courseSessions]
  );

  const handleJoin = async (sessionId) => {
    setJoinState({ loadingId: sessionId, error: "", info: "" });
    try {
      const requestedSession = courseSessions.find(
        (session) => String(session.id) === String(sessionId),
      );
      const response = await joinRealtimeSession(sessionId, {
        display_name: user?.full_name || "",
        prefer_broadcast: requestedSession?.session_type === "broadcasting",
      });
      const data = apiData(response, null);
      const nextActiveSession = data?.mode === "broadcast" ? sanitizeBroadcastPayload(data) : data;
      setActiveSession(nextActiveSession);
      persistBroadcastPayload(nextActiveSession);
      persistMeetingSessionId(data?.mode === "meeting" ? data?.session?.id : null, authenticatedUserId);
      setJoinState({ loadingId: null, error: "", info: "" });
      if (data?.mode === "meeting" || data?.mode === "broadcast") {
        showToast({ kind: "success", title: "You joined the class", timeout: 3000 });
      }
      await loadSessions();
    } catch (err) {
      setJoinState({ loadingId: null, error: apiMessage(err, "Unable to join live session."), info: "" });
    }
  };

  const handleReconnectMeeting = async (sessionId) => {
    const requestedSession = courseSessions.find(
      (session) => String(session.id) === String(sessionId),
    );
    const response = await joinRealtimeSession(sessionId, {
      display_name: user?.full_name || "",
      prefer_broadcast: requestedSession?.session_type === "broadcasting",
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
    if (!highlightedSessionId || autoJoinConsumed || loading) {
      return;
    }
    if (activeSession?.session?.id === highlightedSessionId) {
      setAutoJoinConsumed(true);
      return;
    }
    const highlightedSession = sessions.find((session) => session.id === highlightedSessionId);
    setAutoJoinConsumed(true);
    if (!isJoinableLiveSession(highlightedSession)) {
      setJoinState({
        loadingId: null,
        error: "",
        info: "This class is not live yet. Live classes run Friday, Saturday and Sunday from 7:00 PM to 8:00 PM IST.",
      });
      return;
    }
    handleJoin(highlightedSessionId);
  }, [activeSession?.session?.id, autoJoinConsumed, highlightedSessionId, loading, sessions]);

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
    broadcastChatLaunch.sourceUrl === activeBroadcastChatUrl &&
    (!broadcastChatLaunch.expiresAt || broadcastChatLaunch.expiresAt > Date.now() + 5000)
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
      setBroadcastChatLaunch({ sessionId: null, sourceUrl: "", url: "", expiresAt: 0, loading: false });
      return undefined;
    }

    const sessionId = activeSession.session.id;
    if (authLoading) {
      setBroadcastChatLaunch({ sessionId, sourceUrl: activeBroadcastChatUrl, url: "", expiresAt: 0, loading: true });
      return undefined;
    }
    if (!isAuthenticated) {
      setBroadcastChatLaunch({ sessionId, sourceUrl: activeBroadcastChatUrl, url: "", expiresAt: 0, loading: false });
      return undefined;
    }

    let cancelled = false;
    setBroadcastChatLaunch((previous) => ({
      sessionId,
      sourceUrl: activeBroadcastChatUrl,
      url:
        previous.sessionId === sessionId && previous.sourceUrl === activeBroadcastChatUrl
          ? previous.url
          : "",
      expiresAt:
        previous.sessionId === sessionId && previous.sourceUrl === activeBroadcastChatUrl
          ? previous.expiresAt
          : 0,
      loading: true,
    }));
    createRealtimeOwncastChatLaunch(sessionId)
      .then((response) => {
        if (cancelled) return;
        const data = apiData(response, {});
        const launchUrl = String(data?.launch_url || "").trim();
        const expiresInSeconds = Math.max(30, Number(data?.expires_in_seconds || 0) || 0);
        setBroadcastChatLaunch({
          sessionId,
          sourceUrl: activeBroadcastChatUrl,
          url: launchUrl,
          expiresAt: launchUrl ? Date.now() + expiresInSeconds * 1000 : 0,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setBroadcastChatLaunch({ sessionId, sourceUrl: activeBroadcastChatUrl, url: "", expiresAt: 0, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeBroadcastChatUrl,
    activeSession?.mode,
    activeSession?.session?.id,
    authLoading,
    broadcastChatLaunchRefreshKey,
    isAuthenticated,
    shouldUsePersonalizedBroadcastChat,
  ]);

  useEffect(() => {
    if (
      !shouldUsePersonalizedBroadcastChat ||
      !broadcastChatLaunch.url ||
      !broadcastChatLaunch.expiresAt ||
      broadcastChatLaunch.sessionId !== activeSession?.session?.id ||
      broadcastChatLaunch.sourceUrl !== activeBroadcastChatUrl
    ) {
      return undefined;
    }

    const refreshDelay = Math.max(30_000, broadcastChatLaunch.expiresAt - Date.now() - 30_000);
    const timeoutId = window.setTimeout(() => {
      setBroadcastChatLaunchRefreshKey((previous) => previous + 1);
    }, refreshDelay);
    return () => window.clearTimeout(timeoutId);
  }, [
    activeBroadcastChatUrl,
    activeSession?.session?.id,
    broadcastChatLaunch.expiresAt,
    broadcastChatLaunch.sessionId,
    broadcastChatLaunch.sourceUrl,
    broadcastChatLaunch.url,
    shouldUsePersonalizedBroadcastChat,
  ]);

  const isWatching = activeSession?.mode === "broadcast" || activeSession?.mode === "meeting";
  const pageTitle = courseId ? "Course live classroom" : "Live classes";
  const scheduleSummary = formatScheduleSummary(liveSchedule);
  const loadFailed = Boolean(error) && sessions.length === 0;
  const selectedModeIndex = Math.max(
    0,
    SESSION_FILTERS.findIndex((option) => option.key === effectiveMode)
  );

  const retryLoad = () => {
    setLoading(true);
    setError("");
    loadSessions();
  };

  const leaveBroadcast = () => {
    setActiveSession(null);
    setJoinState({ loadingId: null, error: "", info: "" });
  };

  return (
    <div className={`lc-page${isWatching ? " lc-page--watching" : ""}`}>
      {isWatching ? (
        <h1 className="lc-visually-hidden">{pageTitle}</h1>
      ) : (
        <PageHeader
          title={pageTitle}
          description={
            courseId ? "Live classes included with this course." : "Join your class when it goes live."
          }
        />
      )}

      {joinState.error ? (
        <PageNotification
          kind="error"
          title="Couldn't join the class."
          subtitle={joinState.error}
          onClose={() => setJoinState((previous) => ({ ...previous, error: "" }))}
        />
      ) : null}

      {joinState.info ? (
        <PageNotification
          kind="info"
          title={joinState.info}
          onClose={() => setJoinState((previous) => ({ ...previous, info: "" }))}
        />
      ) : null}

      {activeSession?.mode === "meeting" ? (
        <LiveMeetingFrame>
          <MeetingRoomExperience
            payload={activeSession}
            onLeave={() => {
              clearPersistedMeetingSessionId();
              setActiveSession(null);
            }}
            onReconnect={handleReconnectMeeting}
            audiencePanel
          />
        </LiveMeetingFrame>
      ) : null}

      {activeSession?.mode === "broadcast" ? (
        <div className="lc-theater">
          <BroadcastViewerTheater
            title={activeSession.session?.title}
            sessionId={activeSession.session?.id}
            streamUrl={activeBroadcastStreamUrl}
            chatUrl={activeBroadcastResolvedChatUrl}
            chatFallbackMessage={activeBroadcastChatFallbackMessage}
            streamStatus={activeSession.broadcast?.stream_status}
            sessionStatus={activeSession.session?.status}
            chatEnabled={activeSession.session?.chat_enabled !== false}
            badgeLabel="Live"
            headerLabel="Now playing"
            chatTitle="Live chat"
            statusMessage={activeBroadcastStatusMessage}
            onRefreshStream={handleRefreshActiveBroadcast}
            onRefreshChat={() => setBroadcastChatLaunchRefreshKey((previous) => previous + 1)}
            withContainer={false}
            actions={<LeaveClassButton onLeave={leaveBroadcast} />}
          />
        </div>
      ) : null}

      {!isWatching && loading ? <PageSkeleton label="Loading live classes" count={2} /> : null}

      {!isWatching && !loading && loadFailed ? (
        <PageNotification
          kind="error"
          title="Couldn't load live classes."
          subtitle={error}
          actionLabel="Try again"
          onAction={retryLoad}
        />
      ) : null}

      {!isWatching && !loading && !loadFailed ? (
        <>
          {error ? (
            <PageNotification
              kind="warning"
              title="Showing the last update."
              subtitle={error}
              actionLabel="Try again"
              onAction={retryLoad}
            />
          ) : null}

          <div className="lc-hero">
            {joinableLiveSession ? (
              <LiveNowCard
                session={joinableLiveSession}
                onJoin={handleJoin}
                joining={joinState.loadingId === joinableLiveSession.id}
              />
            ) : (
              <NextClassCard schedule={liveSchedule} />
            )}
          </div>

          {courseSessions.length > 0 ? (
            <section className="lc-section" aria-labelledby="lc-sessions-title">
              <div className="lc-section__header">
                <h2 id="lc-sessions-title" className="lc-section__title">
                  All sessions
                </h2>
                <p className="lc-section__count">
                  {stats.total} session{stats.total === 1 ? "" : "s"}
                  {stats.live > 0 ? ` · ${stats.live} live` : ""}
                </p>
              </div>

              {showModeFilter || showSearch ? (
                <div className="lc-filters">
                  {showModeFilter ? (
                    <ContentSwitcher
                      aria-label="Session type"
                      className="lc-filters__switch"
                      selectedIndex={selectedModeIndex}
                      size="lg"
                      onChange={({ name }) => setMode(name)}
                    >
                      {SESSION_FILTERS.map((option) => (
                        <Switch
                          key={option.key}
                          name={option.key}
                          text={option.label}
                        />
                      ))}
                    </ContentSwitcher>
                  ) : null}
                  {showSearch ? (
                    <Search
                      size="lg"
                      className="lc-filters__search"
                      labelText="Search sessions"
                      placeholder="Search sessions"
                      closeButtonLabelText="Clear search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  ) : null}
                </div>
              ) : null}

              {filteredSessions.length > 0 ? (
                <ul className="lc-session-list">
                  {filteredSessions.map((session) => (
                    <li key={session.id}>
                      <SessionTile
                        session={session}
                        joinable={isJoinableLiveSession(session)}
                        highlighted={session.id === highlightedSessionId}
                        joining={joinState.loadingId === session.id}
                        onJoin={handleJoin}
                        scheduleSummary={scheduleSummary}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon={SearchIcon}
                  text="No session matches your search."
                  action={
                    <Button
                      kind="tertiary"
                      onClick={() => {
                        setQuery("");
                        setMode("all");
                      }}
                    >
                      Show all sessions
                    </Button>
                  }
                />
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
