// React bindings for the engagement store. OWNER: WS-LEARN (console-student).
import { useEffect, useSyncExternalStore } from "react";
import { useAuth } from "../../hooks/useAuth";
import useCapabilities from "../capabilities/useCapabilities";
import { engagementStore, selectSummary } from "./engagementStore";

/**
 * True only when capabilities say the `engagement` switch is on. Unknown
 * (capabilities still loading, or an older payload without the key) counts as
 * off, so nothing flashes and no request is made while the switch is off.
 */
export function useEngagementEnabled() {
  const { caps } = useCapabilities();
  return Boolean(caps?.features?.engagement?.enabled);
}

/**
 * `{ enabled, status, data, summary, gain, refresh, clearGain }`.
 * `status`: "off" (switch off) | "idle" | "loading" | "ready" | "error" | "disabled".
 */
export default function useEngagement({ store = engagementStore, enabled: forced } = {}) {
  const auth = useAuth() || {};
  const userId = auth.user?.id ?? null;
  const capsEnabled = useEngagementEnabled();
  const enabled = (forced ?? capsEnabled) && userId != null;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    if (!enabled) return undefined;
    store.reenable();
    return store.start(userId);
  }, [enabled, store, userId]);

  if (!enabled) {
    return { enabled: false, status: "off", data: null, summary: null, gain: null, refresh: store.refresh, clearGain: store.clearGain };
  }
  return {
    enabled: state.status !== "disabled",
    status: state.status,
    data: state.data,
    summary: selectSummary(state),
    gain: state.gain,
    error: state.error,
    refresh: store.refresh,
    clearGain: store.clearGain,
  };
}
