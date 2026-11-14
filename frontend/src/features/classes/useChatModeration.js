// Owncast chat moderation for the class open in the studio (moved from the
// old BroadcastingPage without behaviour change; window.prompt/confirm are
// replaced by the studio's own dialogs). OWNER: WS-D1.
import { useCallback, useState } from "react";
import { applyRealtimeOwncastChatModeration, getRealtimeOwncastChatModeration } from "../../api/realtime";
import { apiData, apiMessage } from "../../utils/api";
import { owncastIdentityKey, owncastIdentityLabel } from "./classesModel";

const INITIAL = { sessionId: null, loading: false, actionLoading: "", error: "", info: "", data: null };

/** Minutes for a chat timeout: 1-1440, or an error message (pure; tested). */
export function parseTimeoutMinutes(input) {
  const minutes = Number(input);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    return { error: "Timeout must be between 1 and 1440 minutes." };
  }
  return { minutes };
}

export default function useChatModeration({ session }) {
  const sessionId = session?.id ?? null;
  const [state, setState] = useState(INITIAL);
  const [selectedKey, setSelectedKey] = useState("");

  const load = useCallback(
    async (id = sessionId) => {
      if (!id) return;
      setState((prev) => ({ ...prev, sessionId: id, loading: true, error: "", info: "" }));
      try {
        const data = apiData(await getRealtimeOwncastChatModeration(id), {});
        setState((prev) => ({ ...prev, sessionId: id, loading: false, data, error: "", info: "Chat control state refreshed." }));
      } catch (err) {
        setState((prev) => ({ ...prev, sessionId: id, loading: false, error: apiMessage(err, "Unable to load Owncast chat controls."), info: "" }));
      }
    },
    [sessionId]
  );

  const apply = async (action, payload = {}, successMessage = "Chat action applied.") => {
    const id = state.sessionId || sessionId;
    if (!id) return;
    setState((prev) => ({ ...prev, sessionId: id, actionLoading: action, error: "", info: "" }));
    try {
      const data = apiData(await applyRealtimeOwncastChatModeration(id, { action, ...payload }), {});
      setState((prev) => ({ ...prev, sessionId: id, actionLoading: "", data, error: "", info: successMessage }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        sessionId: id,
        actionLoading: "",
        error: apiMessage(err, "Unable to apply Owncast chat moderation action."),
        info: "",
      }));
    }
  };

  const data = state.sessionId === sessionId ? state.data || {} : {};
  const loaded = state.sessionId === sessionId && Boolean(state.data);
  const chatEnabled = typeof data.chat_enabled === "boolean" ? data.chat_enabled : session?.chat_enabled !== false;
  const identities = Array.isArray(data.identities) ? data.identities : [];
  const messages = Array.isArray(data.recent_messages) ? data.recent_messages : [];
  const ipBans = Array.isArray(data.ip_bans) ? data.ip_bans : [];
  const selected = identities.length
    ? identities.find((identity) => owncastIdentityKey(identity) === selectedKey) || identities[0]
    : null;

  const timeoutUser = async (identity, minutesInput) => {
    const parsed = parseTimeoutMinutes(minutesInput);
    if (parsed.error) {
      setState((prev) => ({ ...prev, error: parsed.error, info: "" }));
      return;
    }
    const { minutes } = parsed;
    await apply(
      "timeout_user",
      { owncast_user_id: identity.owncast_user_id, duration_seconds: Math.round(minutes * 60) },
      `Timed out ${owncastIdentityLabel(identity)} for ${minutes} minute${minutes === 1 ? "" : "s"}.`
    );
  };

  const banUser = (identity) =>
    apply("ban_user", { owncast_user_id: identity.owncast_user_id }, `${owncastIdentityLabel(identity)} was banned from chat.`);

  const banIp = async (input) => {
    const ipAddress = String(input || "").trim();
    if (!ipAddress) {
      setState((prev) => ({ ...prev, error: "Enter an IP address to ban.", info: "" }));
      return false;
    }
    await apply("ban_ip", { ip_address: ipAddress }, `IP ${ipAddress} was banned.`);
    return true;
  };

  const toggleChat = () =>
    apply(
      chatEnabled ? "disable_chat" : "enable_chat",
      {},
      chatEnabled ? "Broadcast chat disabled. Video remains live." : "Broadcast chat enabled."
    );

  return {
    state,
    loaded,
    chatEnabled,
    identities,
    messages,
    ipBans,
    selected,
    selectedKey: selected ? owncastIdentityKey(selected) : "",
    setSelectedKey,
    load,
    apply,
    timeoutUser,
    banUser,
    banIp,
    toggleChat,
  };
}
