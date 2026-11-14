// "Watch as a viewer" inside the studio (moved from the old
// BroadcastingPage without behaviour change): join in broadcast mode, keep
// the verified chat link fresh and poll the class adaptively. OWNER: WS-D1.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRealtimeOwncastChatLaunch, joinRealtimeSession } from "../../api/realtime";
import useAdaptiveRealtimeSessionPolling from "../../hooks/useAdaptiveRealtimeSessionPolling";
import { resolveBroadcastEmbedUrls } from "../../utils/broadcastUrls";
import { apiData, apiMessage } from "../../utils/api";
import { liveJoinDisplayName } from "../profiles/publicName";

const NO_LAUNCH = { sessionId: null, sourceUrl: "", url: "", expiresAt: 0, loading: false };

/** The status line under the viewer player (pure; tested). */
export function viewerStatusMessage(activeBroadcast) {
  const sessionStatus = String(activeBroadcast?.session?.status || "").trim().toLowerCase();
  const streamStatus = String(activeBroadcast?.broadcast?.stream_status || "").trim().toLowerCase();
  if (sessionStatus === "ended") return "This broadcast session has ended.";
  if (streamStatus === "starting") {
    return "The host is reconnecting OBS. Keep chat open and the video will resume here when the stream is back.";
  }
  if (streamStatus && streamStatus !== "live") {
    return "The video stream is temporarily offline. Keep chat open while the host reconnects OBS.";
  }
  return "";
}

export default function useViewerBroadcast({ user, isAuthenticated, initialPayload = null, onSessionUpdate }) {
  const [activeBroadcast, setActiveBroadcast] = useState(initialPayload);
  const [joinState, setJoinState] = useState({ loadingId: null, error: "", info: "" });
  const [chatLaunch, setChatLaunch] = useState(NO_LAUNCH);
  const [chatRefreshKey, setChatRefreshKey] = useState(0);
  const [playbackStalled, setPlaybackStalled] = useState(null);

  const join = useCallback(
    async (sessionId) => {
      setJoinState({ loadingId: sessionId, error: "", info: "" });
      try {
        const data = apiData(
          await joinRealtimeSession(sessionId, {
            display_name: liveJoinDisplayName(user),
            // Keep the studio in viewer/broadcast context even for moderators.
            prefer_broadcast: true,
          }),
          {}
        );
        if (data.mode === "meeting") {
          setJoinState({ loadingId: null, error: "", info: "This class is an interactive meeting. Open its meeting room to take part." });
          return null;
        }
        setActiveBroadcast(data);
        setJoinState({ loadingId: null, error: "", info: "Broadcast joined." });
        if (data?.session) onSessionUpdate?.(data.session);
        return data;
      } catch (err) {
        setJoinState({ loadingId: null, error: apiMessage(err, "Unable to join broadcast."), info: "" });
        return null;
      }
    },
    [onSessionUpdate, user]
  );

  const applySessionUpdate = useCallback(
    (latest) => {
      if (!latest) return;
      onSessionUpdate?.(latest);
      setActiveBroadcast((previous) => {
        if (!previous || previous.session?.id !== latest.id) return previous;
        return {
          ...previous,
          session: { ...previous.session, ...latest },
          broadcast: { ...previous.broadcast, stream_status: latest.stream_status || previous.broadcast?.stream_status || "" },
        };
      });
    },
    [onSessionUpdate]
  );

  const refreshStream = useAdaptiveRealtimeSessionPolling({
    enabled: Boolean(activeBroadcast?.session?.id),
    sessionId: activeBroadcast?.session?.id,
    sessionStatus: activeBroadcast?.session?.status,
    streamStatus: activeBroadcast?.broadcast?.stream_status,
    playbackStalled,
    onSessionData: applySessionUpdate,
  });

  const urls = useMemo(
    () =>
      resolveBroadcastEmbedUrls({
        streamEmbedUrl: activeBroadcast?.broadcast?.stream_embed_url,
        chatEmbedUrl: activeBroadcast?.broadcast?.chat_embed_url,
      }),
    [activeBroadcast]
  );
  const ended = String(activeBroadcast?.session?.status || "").trim().toLowerCase() === "ended";
  const chatUrl = urls.writableChatEmbedUrl || urls.chatEmbedUrl;
  const activeId = activeBroadcast?.session?.id;
  const personalChat = Boolean(activeId) && Boolean(chatUrl) && !ended;
  const launchFresh =
    chatLaunch.sessionId === activeId &&
    chatLaunch.sourceUrl === chatUrl &&
    (!chatLaunch.expiresAt || chatLaunch.expiresAt > Date.now() + 5000);
  const resolvedChatUrl = personalChat ? (launchFresh ? chatLaunch.url : "") : chatUrl;
  const chatFallbackMessage = personalChat
    ? chatLaunch.loading
      ? "Preparing your verified chat session..."
      : "Verified chat could not be prepared. Refresh the page or sign in again."
    : "Chat URL not configured for this session.";

  // A personal, short-lived chat link for the signed-in viewer.
  useEffect(() => {
    if (!personalChat) {
      setChatLaunch(NO_LAUNCH);
      return undefined;
    }
    if (!isAuthenticated) {
      setChatLaunch({ ...NO_LAUNCH, sessionId: activeId, sourceUrl: chatUrl });
      return undefined;
    }
    let cancelled = false;
    setChatLaunch((previous) => {
      const same = previous.sessionId === activeId && previous.sourceUrl === chatUrl;
      return { sessionId: activeId, sourceUrl: chatUrl, url: same ? previous.url : "", expiresAt: same ? previous.expiresAt : 0, loading: true };
    });
    createRealtimeOwncastChatLaunch(activeId)
      .then((response) => {
        if (cancelled) return;
        const data = apiData(response, {});
        const launchUrl = String(data?.launch_url || "").trim();
        const expiresInSeconds = Math.max(30, Number(data?.expires_in_seconds || 0) || 0);
        setChatLaunch({
          sessionId: activeId,
          sourceUrl: chatUrl,
          url: launchUrl,
          expiresAt: launchUrl ? Date.now() + expiresInSeconds * 1000 : 0,
          loading: false,
        });
      })
      .catch(() => {
        if (!cancelled) setChatLaunch({ ...NO_LAUNCH, sessionId: activeId, sourceUrl: chatUrl });
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, chatRefreshKey, chatUrl, isAuthenticated, personalChat]);

  // Refresh the chat link 30 s before it expires.
  useEffect(() => {
    if (!personalChat || !chatLaunch.url || !chatLaunch.expiresAt || chatLaunch.sessionId !== activeId || chatLaunch.sourceUrl !== chatUrl) {
      return undefined;
    }
    const refreshDelay = Math.max(30_000, chatLaunch.expiresAt - Date.now() - 30_000);
    const timeoutId = window.setTimeout(() => setChatRefreshKey((previous) => previous + 1), refreshDelay);
    return () => window.clearTimeout(timeoutId);
  }, [activeId, chatLaunch.expiresAt, chatLaunch.sessionId, chatLaunch.sourceUrl, chatLaunch.url, chatUrl, personalChat]);

  return {
    activeBroadcast,
    setActiveBroadcast,
    joinState,
    join,
    ended,
    streamUrl: urls.streamEmbedUrl,
    chatUrl: resolvedChatUrl,
    chatFallbackMessage,
    statusMessage: viewerStatusMessage(activeBroadcast),
    refreshStream,
    setPlaybackStalled,
    refreshChat: () => setChatRefreshKey((previous) => previous + 1),
  };
}
