const DISCONNECT_REASON_NAMES = Object.freeze({
  0: "unknown",
  1: "client_initiated",
  2: "duplicate_identity",
  3: "server_shutdown",
  4: "participant_removed",
  5: "room_deleted",
  6: "state_mismatch",
  7: "join_failure",
  8: "migration",
  9: "signal_close",
  10: "room_closed",
  11: "user_unavailable",
  12: "user_rejected",
  13: "sip_trunk_failure",
  14: "connection_timeout",
  15: "media_failure",
});

const TERMINAL_DISCONNECT_REASONS = new Set([
  "client_initiated",
  "duplicate_identity",
  "participant_removed",
  "room_deleted",
  "room_closed",
  "user_rejected",
]);

const CONNECTION_QUALITY_NAMES = Object.freeze({
  0: "poor",
  1: "good",
  2: "excellent",
  3: "lost",
});

export function normalizeDisconnectReason(reason) {
  if (reason === undefined || reason === null || reason === "") {
    return "unknown";
  }
  const numeric = Number(reason);
  if (Number.isInteger(numeric) && DISCONNECT_REASON_NAMES[numeric]) {
    return DISCONNECT_REASON_NAMES[numeric];
  }
  const normalized = String(reason).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return Object.values(DISCONNECT_REASON_NAMES).includes(normalized) ? normalized : "unknown";
}

export function shouldAutomaticallyReconnect(reason) {
  return !TERMINAL_DISCONNECT_REASONS.has(normalizeDisconnectReason(reason));
}

export function normalizeConnectionQuality(quality) {
  const numeric = Number(quality);
  if (Number.isInteger(numeric) && CONNECTION_QUALITY_NAMES[numeric]) {
    return CONNECTION_QUALITY_NAMES[numeric];
  }
  const normalized = String(quality || "").trim().toLowerCase();
  return Object.values(CONNECTION_QUALITY_NAMES).includes(normalized) ? normalized : "unknown";
}

export function disconnectMessage(reason) {
  switch (normalizeDisconnectReason(reason)) {
    case "duplicate_identity":
      return "This class was opened in another tab or device. Close the other session, then rejoin.";
    case "participant_removed":
      return "You were removed from this live class. Contact the instructor if this was unexpected.";
    case "room_deleted":
    case "room_closed":
      return "This live class has ended.";
    case "user_rejected":
      return "The connection request was rejected. Contact support if this continues.";
    case "client_initiated":
      return "You left the live class.";
    default:
      return "Connection lost. Reconnecting with a fresh session...";
  }
}

function resolveNetworkLabel(connection) {
  const connectionType = String(connection?.type || "").trim().toLowerCase();
  if (["wifi", "ethernet"].includes(connectionType)) {
    return connectionType;
  }
  const effectiveType = String(connection?.effectiveType || "").trim().toLowerCase();
  if (effectiveType === "slow-2g") {
    return "slow_2g";
  }
  return ["2g", "3g", "4g"].includes(effectiveType) ? effectiveType : "unknown";
}

export function resolveMeetingConnectionStrategy({
  audienceFocusMode = false,
  canPresent = false,
  canSpeak = false,
  forceRelayTransport = false,
  browserWindow = typeof window === "undefined" ? null : window,
  browserNavigator = typeof navigator === "undefined" ? null : navigator,
} = {}) {
  if (!browserWindow || !browserNavigator) {
    return {
      isMobileDevice: false,
      mobileListener: false,
      saveData: false,
      effectiveType: "",
      network: "unknown",
      platform: "unknown",
      relayFallbackEligible: false,
      preferRelayTransport: Boolean(forceRelayTransport),
      conservativeReceiveProfile: false,
    };
  }

  const userAgent = String(browserNavigator.userAgent || "").toLowerCase();
  const viewportWidth = Number(browserWindow.innerWidth || 0);
  const touchCapable = Number(browserNavigator.maxTouchPoints || 0) > 1;
  const mobileUserAgent = /android|iphone|ipad|ipod|mobile|iemobile|opera mini/i.test(userAgent);
  const isMobileDevice = mobileUserAgent || (touchCapable && viewportWidth > 0 && viewportWidth <= 1024);
  const connection =
    browserNavigator.connection || browserNavigator.mozConnection || browserNavigator.webkitConnection || null;
  const effectiveType = String(connection?.effectiveType || "").trim().toLowerCase();
  const saveData = connection?.saveData === true;
  const weakNetwork = ["slow-2g", "2g", "3g"].includes(effectiveType);
  const mobileListener = Boolean(isMobileDevice && !canPresent && !canSpeak);

  return {
    isMobileDevice,
    mobileListener,
    saveData,
    effectiveType,
    network: resolveNetworkLabel(connection),
    platform: isMobileDevice ? "mobile" : "desktop",
    relayFallbackEligible: Boolean(mobileListener || saveData || weakNetwork),
    preferRelayTransport: Boolean(forceRelayTransport),
    conservativeReceiveProfile: Boolean(mobileListener || audienceFocusMode || saveData || weakNetwork),
  };
}
