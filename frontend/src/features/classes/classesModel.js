// Classes, Host-a-class and Host studio: pure helpers (no React).
// OWNER: WS-D1. Moved here unchanged from the old BroadcastingPage /
// MeetingPage (plan §3.5, §7.5 WS-D1) so every component stays small and
// the behaviour stays the same.

export const STREAM_SERVICE_ALSYED = "alsyed_stream";
export const STREAM_SERVICE_OBS = "obs_stream";
export const SESSION_TYPE_BROADCAST = "broadcasting";
export const SESSION_TYPE_MEETING = "meeting";

export const MODE_BROADCAST = "broadcast";
export const MODE_MEETING = "meeting";

export const defaultBroadcastProfile = Object.freeze({
  capture_width: 640,
  capture_height: 360,
  fps: 20,
  max_video_bitrate_kbps: 650,
});

export const defaultBroadcastSource = "camera";

export const OBS_START_INFO_MESSAGE =
  "OBS stream is ready. If OBS warned that the connection dropped, start streaming again in OBS using the same server URL and key. Viewers stay in the same session.";

export function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function normalizeBroadcastProfile(serverProfile = {}) {
  return {
    capture_width: clampNumber(serverProfile.capture_width, 320, 1920, defaultBroadcastProfile.capture_width),
    capture_height: clampNumber(serverProfile.capture_height, 180, 1080, defaultBroadcastProfile.capture_height),
    fps: clampNumber(serverProfile.fps, 10, 30, defaultBroadcastProfile.fps),
    max_video_bitrate_kbps: clampNumber(
      serverProfile.max_video_bitrate_kbps,
      200,
      4000,
      defaultBroadcastProfile.max_video_bitrate_kbps
    ),
  };
}

export function moduleOptionLabel(module) {
  const count = Number(module?.lecture_count || 0);
  return `${module?.title || "Untitled module"} (${count} lecture${count === 1 ? "" : "s"})`;
}

export function inferObsServerUrl(win = typeof window === "undefined" ? null : window) {
  if (!win) return "rtmp://your-server:1935/live";
  const host = String(win.location?.hostname || "").trim() || "localhost";
  return `rtmp://${host}:1935/live`;
}

export function maskSecretValue(value) {
  const normalized = String(value || "");
  if (!normalized) return "";
  return "•".repeat(Math.max(normalized.length, 12));
}

export function canManageSession(session, user) {
  if (!session) return false;
  if (session.can_manage) return true;
  if (session.is_host) return true;
  return user?.is_admin === true;
}

export function isObsStreamMode(session) {
  return String(session?.stream_service || "").trim().toLowerCase() === STREAM_SERVICE_OBS;
}

export function isMeetingSession(session) {
  return String(session?.session_type || "").trim().toLowerCase() === SESSION_TYPE_MEETING;
}

export function getStreamServiceLabel(session) {
  return isObsStreamMode(session) ? "Alsyed OBS Stream" : "Alsyed Stream";
}

/** One short, sentence-case line: how this class is delivered. */
/**
 * Who can watch a broadcast: the batch (live class, else course) it is linked
 * to. Every broadcast shares one stream, so the studio names the batch the
 * host is about to put on air. Empty when the class is open to everyone.
 */
export function sessionAudienceLabel(session) {
  if (isMeetingSession(session)) return "";
  return String(session?.linked_live_class?.title || session?.linked_course?.title || "").trim();
}

export function sessionModeLabel(session) {
  if (isMeetingSession(session)) return "Interactive meeting";
  return isObsStreamMode(session) ? "Broadcast from OBS" : "Broadcast from the browser";
}

export function normalizedStreamStatus(session) {
  return String(session?.stream_status || "").trim().toLowerCase();
}

/**
 * The one StatusTag vocabulary (plan §2.5) for a class row:
 * live (on air), reconnecting (host lost), scheduled, or ended.
 */
export function sessionStatus(session) {
  const status = String(session?.status || "").trim().toLowerCase();
  if (status === "ended") return { key: "off", label: "Ended" };
  if (session?.host_reconnecting || (status === "live" && normalizedStreamStatus(session) === "interrupted")) {
    return { key: "late", label: "Host reconnecting" };
  }
  if (isMeetingSession(session)) {
    return status === "live" ? { key: "live", label: "Live" } : { key: "scheduled", label: "Scheduled" };
  }
  if (normalizedStreamStatus(session) === "live") return { key: "live", label: "Live" };
  if (normalizedStreamStatus(session) === "starting") return { key: "processing", label: "Starting" };
  return { key: "scheduled", label: status === "live" ? "Open, not streaming" : "Scheduled" };
}

export function isSessionOnAir(session) {
  return sessionStatus(session).key === "live";
}

export function resolveRecordingMode(recording) {
  const source = String(recording?.source || "").trim().toLowerCase();
  if (source === "browser_fallback") return "screenity-fallback";
  if (recording?.is_active) return "livekit-egress";
  return "";
}

export function resolveRecordingPlaybackUrl(recording) {
  return String(recording?.playback_url || recording?.output_download_url || "").trim();
}

export function owncastMessagePreview(body) {
  return (
    String(body || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "No message body"
  );
}

export function formatModerationTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

export function owncastIdentityLabel(identity) {
  return (
    identity?.owncast_display_name ||
    identity?.platform_full_name ||
    identity?.platform_email ||
    identity?.owncast_user_id ||
    "Unknown user"
  );
}

export function owncastIdentityKey(identity) {
  return String(
    identity?.id ||
      identity?.owncast_user_id ||
      identity?.platform_user_id ||
      identity?.platform_email ||
      owncastIdentityLabel(identity)
  ).trim();
}

export function owncastIdentityStatus(identity) {
  if (identity?.is_disabled) return "banned";
  if (identity?.is_timeout_active) return "timeout";
  if (identity?.is_moderator) return "moderator";
  return "viewer";
}

export function isChatMessageHidden(message) {
  if (typeof message?.is_hidden === "boolean") return message.is_hidden;
  if (typeof message?.visible === "boolean") return !message.visible;
  return Boolean(message?.hidden_at);
}

export function buildJoinLink(session, origin = typeof window === "undefined" ? "" : window.location.origin) {
  if (session?.join_url) return session.join_url;
  const sessionId = session?.id;
  if (!sessionId) return "";
  return origin ? `${origin}/join-live?session=${sessionId}` : `/join-live?session=${sessionId}`;
}

/** Live first, then scheduled, newest first (the order both old pages used). */
export function sortSessions(sessions) {
  const statusWeight = { live: 1, scheduled: 2, ended: 3 };
  return [...(sessions || [])].sort((a, b) => {
    const aWeight = statusWeight[a.status] || 4;
    const bWeight = statusWeight[b.status] || 4;
    if (aWeight !== bWeight) return aWeight - bWeight;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

/** Sessions the Classes page lists: every meeting and broadcast that has not ended. */
export function activeClassSessions(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (item) =>
      item &&
      item.status !== "ended" &&
      [SESSION_TYPE_BROADCAST, SESSION_TYPE_MEETING].includes(String(item.session_type || "").toLowerCase())
  );
}

export function filterSessionsByMode(sessions, mode) {
  if (mode === MODE_MEETING) return sessions.filter(isMeetingSession);
  if (mode === MODE_BROADCAST) return sessions.filter((session) => !isMeetingSession(session));
  return sessions;
}

export function sortLiveClassOptions(rows) {
  return [...(rows || [])].sort((a, b) => {
    const monthDelta = Number(a?.month_number || 0) - Number(b?.month_number || 0);
    if (monthDelta !== 0) return monthDelta;
    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });
}

export function liveClassOptionLabel(item) {
  const month = item?.month_number ? `Month ${item.month_number}: ` : "";
  const course = item?.linked_course_title ? ` · ${item.linked_course_title}` : "";
  return `${month}${item?.title || "Live class"}${course}`;
}

/** "/console/admin" or "/console/teach" from the current path (staff default to admin). */
export function workspaceRootFor(pathname, { isAdmin = false } = {}) {
  const match = /^\/console\/(teach|admin)(?=\/|$)/.exec(String(pathname || ""));
  if (match) return `/console/${match[1]}`;
  return isAdmin ? "/console/admin" : "/console/teach";
}

export function classesPath(root, mode = "") {
  return `${root}/classes${mode ? `?mode=${encodeURIComponent(mode)}` : ""}`;
}

export function studioPath(root, sessionId, panel = "") {
  return `${root}/classes/${encodeURIComponent(sessionId)}/studio${panel ? `?panel=${encodeURIComponent(panel)}` : ""}`;
}

/**
 * The actions a class row offers (plan §3.5): exactly one primary, "Copy
 * link" as a ghost, and everything else in the overflow menu; destructive
 * items are flagged so the page asks for confirmation first.
 */
export function sessionRowActions(session, user) {
  const manage = canManageSession(session, user);
  const meeting = isMeetingSession(session);
  if (!manage) {
    return {
      primary: { key: "watch", label: meeting ? "Join meeting" : "Watch as a viewer" },
      copyLink: true,
      overflow: [],
    };
  }
  const overflow = meeting
    ? [{ key: "delete", label: "Delete class", danger: true }]
    : [
        { key: "stage", label: "Open stage control" },
        { key: "chat", label: "Chat moderation" },
        { key: "stop", label: "Stop broadcast", danger: true },
        { key: "delete", label: "Delete class", danger: true },
      ];
  return {
    // "Open Host Studio" keeps the name the live-class journey and hosts know.
    primary: { key: "studio", label: meeting ? "Open meeting room" : "Open Host Studio" },
    copyLink: true,
    overflow,
  };
}

/** ConfirmDialog copy that names the class (plan §2.5 ConfirmDialog). */
export function confirmCopy(kind, session) {
  const name = String(session?.title || "this class");
  if (kind === "stop") {
    return {
      title: `Stop the broadcast of “${name}”?`,
      objectName: name,
      body: "Viewers stop receiving video straight away. The class stays open, so you can go live again from the studio.",
      confirmLabel: "Stop broadcast",
      danger: true,
    };
  }
  if (kind === "stop-live") {
    return {
      title: `Stop live delivery of “${name}”?`,
      objectName: name,
      body: "Viewers stop receiving your video. The recording is saved and published when the class ends.",
      confirmLabel: "Stop live",
      danger: true,
    };
  }
  if (kind === "resync-key") {
    return {
      title: "Send the stream key to the server again?",
      objectName: name,
      body: "Use this when OBS reports an invalid key. The key itself stays the same, so OBS keeps its settings.",
      confirmLabel: "Re-sync key",
      danger: false,
    };
  }
  if (kind === "delete-recording") {
    return {
      title: "Delete the latest recording?",
      objectName: name,
      body: "The file is removed permanently. This cannot be undone.",
      confirmLabel: "Delete recording",
      danger: true,
    };
  }
  return {
    title: `Delete “${name}”?`,
    objectName: name,
    body: "This ends the class for everyone in it and removes it from your list.",
    confirmLabel: "Delete class",
    danger: true,
  };
}
