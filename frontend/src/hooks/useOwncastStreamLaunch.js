import { useEffect, useState } from "react";
import { createRealtimeOwncastStreamLaunch } from "../api/realtime";
import { apiData } from "../utils/api";

const emptyLaunchState = {
  sessionId: null,
  sourceUrl: "",
  url: "",
  expiresAt: 0,
  loading: false,
  error: "",
};

export default function useOwncastStreamLaunch({ sessionId, streamUrl, refreshKey = 0, enabled = true } = {}) {
  const normalizedSessionId = Number(sessionId || 0) || null;
  const normalizedStreamUrl = String(streamUrl || "").trim();
  const shouldLaunch = Boolean(enabled && normalizedSessionId && normalizedStreamUrl);
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
      sourceUrl: normalizedStreamUrl,
      url:
        previous.sessionId === normalizedSessionId && previous.sourceUrl === normalizedStreamUrl
          ? previous.url
          : "",
      expiresAt:
        previous.sessionId === normalizedSessionId && previous.sourceUrl === normalizedStreamUrl
          ? previous.expiresAt
          : 0,
      loading: true,
      error: "",
    }));

    createRealtimeOwncastStreamLaunch(normalizedSessionId)
      .then((response) => {
        if (cancelled) return;
        const data = apiData(response, {});
        const launchUrl = String(data?.launch_url || "").trim();
        const expiresInSeconds = Math.max(60, Number(data?.expires_in_seconds || 0) || 0);
        if (!launchUrl) {
          setLaunchState({
            sessionId: normalizedSessionId,
            sourceUrl: normalizedStreamUrl,
            url: "",
            expiresAt: 0,
            loading: false,
            error: "Secure video launch URL was not returned.",
          });
          return;
        }
        setLaunchState({
          sessionId: normalizedSessionId,
          sourceUrl: normalizedStreamUrl,
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
          sourceUrl: normalizedStreamUrl,
          url: "",
          expiresAt: 0,
          loading: false,
          error: error?.message || "Unable to prepare secure video launch.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [autoRefreshKey, normalizedSessionId, normalizedStreamUrl, refreshKey, shouldLaunch]);

  useEffect(() => {
    if (!shouldLaunch || !launchState.url || !launchState.expiresAt) {
      return undefined;
    }
    const refreshDelay = Math.max(30_000, launchState.expiresAt - Date.now() - 60_000);
    const timeoutId = window.setTimeout(() => {
      setAutoRefreshKey((previous) => previous + 1);
    }, refreshDelay);
    return () => window.clearTimeout(timeoutId);
  }, [launchState.expiresAt, launchState.url, shouldLaunch]);

  const launchIsCurrent =
    launchState.sessionId === normalizedSessionId &&
    launchState.sourceUrl === normalizedStreamUrl &&
    launchState.expiresAt > Date.now() + 5000;

  return {
    requiresLaunch: shouldLaunch,
    loading: shouldLaunch ? launchState.loading : false,
    error: shouldLaunch ? launchState.error : "",
    streamUrl: shouldLaunch && launchIsCurrent ? launchState.url : shouldLaunch ? "" : normalizedStreamUrl,
  };
}
