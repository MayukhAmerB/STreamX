import { useEffect, useState } from "react";
import { createRealtimeOwncastChatLaunch } from "../api/realtime";
import { apiData, apiMessage } from "../utils/api";

const emptyLaunchState = {
  sessionId: null,
  sourceUrl: "",
  url: "",
  expiresAt: 0,
  loading: false,
  error: "",
};

export default function useOwncastChatLaunch({ sessionId, chatUrl, refreshKey = 0, enabled = true } = {}) {
  const normalizedSessionId = Number(sessionId || 0) || null;
  const normalizedChatUrl = String(chatUrl || "").trim();
  const shouldLaunch = Boolean(enabled && normalizedSessionId && normalizedChatUrl);
  const [launchState, setLaunchState] = useState(emptyLaunchState);
  const [autoRefreshKey, setAutoRefreshKey] = useState(0);

  useEffect(() => {
    if (!shouldLaunch) {
      setLaunchState(emptyLaunchState);
      return undefined;
    }

    let cancelled = false;
    setLaunchState((previous) => ({
      sessionId: normalizedSessionId,
      sourceUrl: normalizedChatUrl,
      url:
        previous.sessionId === normalizedSessionId && previous.sourceUrl === normalizedChatUrl
          ? previous.url
          : "",
      expiresAt:
        previous.sessionId === normalizedSessionId && previous.sourceUrl === normalizedChatUrl
          ? previous.expiresAt
          : 0,
      loading: true,
      error: "",
    }));

    createRealtimeOwncastChatLaunch(normalizedSessionId)
      .then((response) => {
        if (cancelled) return;
        const data = apiData(response, {});
        const launchUrl = String(data?.launch_url || "").trim();
        const expiresInSeconds = Math.max(30, Number(data?.expires_in_seconds || 0) || 0);
        if (!launchUrl) {
          setLaunchState({
            sessionId: normalizedSessionId,
            sourceUrl: normalizedChatUrl,
            url: "",
            expiresAt: 0,
            loading: false,
            error: "Secure chat launch URL was not returned.",
          });
          return;
        }
        setLaunchState({
          sessionId: normalizedSessionId,
          sourceUrl: normalizedChatUrl,
          url: launchUrl,
          expiresAt: Date.now() + expiresInSeconds * 1000,
          loading: false,
          error: "",
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setLaunchState({
          sessionId: normalizedSessionId,
          sourceUrl: normalizedChatUrl,
          url: "",
          expiresAt: 0,
          loading: false,
          error: apiMessage(error, "Unable to prepare secure chat."),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [autoRefreshKey, normalizedChatUrl, normalizedSessionId, refreshKey, shouldLaunch]);

  useEffect(() => {
    if (!shouldLaunch || !launchState.url || !launchState.expiresAt) {
      return undefined;
    }
    const refreshDelay = Math.max(30_000, launchState.expiresAt - Date.now() - 30_000);
    const timeoutId = window.setTimeout(() => {
      setAutoRefreshKey((previous) => previous + 1);
    }, refreshDelay);
    return () => window.clearTimeout(timeoutId);
  }, [launchState.expiresAt, launchState.url, shouldLaunch]);

  const launchIsCurrent =
    launchState.sessionId === normalizedSessionId &&
    launchState.sourceUrl === normalizedChatUrl &&
    launchState.expiresAt > Date.now() + 5000;

  return {
    requiresLaunch: shouldLaunch,
    loading: shouldLaunch ? launchState.loading : false,
    error: shouldLaunch ? launchState.error : "",
    chatUrl: shouldLaunch && launchIsCurrent ? launchState.url : shouldLaunch ? "" : normalizedChatUrl,
  };
}
