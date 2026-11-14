// OWNER: WS-F (plan §5.4, Appendix A.5).
//
//   useCapabilities() -> { caps, loading, refresh }
//
// AuthContext owns the capabilities: they arrive embedded in the signed-in
// user (/api/auth/user/ and the login answer) and AuthContext re-checks them
// on window focus, every 5 minutes and right after any API answers 403
// `feature_disabled` (the api client dispatches "capabilities:stale").
//
// Fallback (a context without `capabilities`, e.g. an older user payload or a
// test double): fetch /api/me/capabilities/ once per signed-in user and share
// the result between components; still refetched on "capabilities:stale".
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { apiData } from "../../utils/api";
import { CAPABILITIES_STALE_EVENT, fetchCapabilities } from "./api";

const shared = { userId: null, caps: null, promise: null };
const listeners = new Set();

function publish(caps) {
  shared.caps = caps;
  listeners.forEach((listener) => listener(caps));
}

function load(userId) {
  if (shared.userId !== userId) {
    shared.userId = userId;
    shared.caps = null;
    shared.promise = null;
  }
  if (!shared.promise) {
    shared.promise = fetchCapabilities()
      .then((response) => {
        if (shared.userId === userId) {
          publish(apiData(response, null));
        }
        return shared.caps;
      })
      .catch(() => {
        // Fail closed: gated items stay disabled ("Checking…") until a retry.
        if (shared.userId === userId) {
          shared.promise = null;
        }
        return null;
      });
  }
  return shared.promise;
}

/** Test helper: forget the shared cache. */
export function resetCapabilitiesCache() {
  shared.userId = null;
  shared.caps = null;
  shared.promise = null;
}

export default function useCapabilities() {
  const auth = useAuth() || {};
  const user = auth.user || null;
  const owned = auth.capabilities || user?.capabilities || null;
  const contextRefresh = typeof auth.refreshCapabilities === "function" ? auth.refreshCapabilities : null;
  const userId = user?.id ?? null;
  const usesFallback = !owned && userId != null;
  const [fallbackCaps, setFallbackCaps] = useState(() =>
    usesFallback && shared.userId === userId ? shared.caps : null
  );
  const [fallbackLoading, setFallbackLoading] = useState(() => usesFallback && !fallbackCaps);

  useEffect(() => {
    if (!usesFallback) {
      setFallbackLoading(false);
      return undefined;
    }
    let active = true;
    const listener = (next) => {
      if (active) {
        setFallbackCaps(next);
        setFallbackLoading(false);
      }
    };
    listeners.add(listener);
    load(userId).then((next) => {
      if (active) {
        setFallbackCaps(next);
        setFallbackLoading(false);
      }
    });
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, [usesFallback, userId]);

  const refresh = useCallback(() => {
    if (contextRefresh) {
      return contextRefresh();
    }
    if (userId == null) {
      return Promise.resolve(null);
    }
    shared.promise = null;
    return load(userId);
  }, [contextRefresh, userId]);

  // AuthContext listens for staleness itself; only the fallback path needs to.
  useEffect(() => {
    if (!usesFallback || contextRefresh || typeof window === "undefined") {
      return undefined;
    }
    const onStale = () => {
      refresh();
    };
    window.addEventListener(CAPABILITIES_STALE_EVENT, onStale);
    return () => window.removeEventListener(CAPABILITIES_STALE_EVENT, onStale);
  }, [usesFallback, contextRefresh, refresh]);

  if (owned) {
    return { caps: owned, loading: false, refresh };
  }
  return { caps: usesFallback ? fallbackCaps : null, loading: usesFallback ? fallbackLoading : false, refresh };
}
