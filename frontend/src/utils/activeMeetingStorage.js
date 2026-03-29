const ACTIVE_MEETING_STORAGE_KEY = "streamx:active-meeting-session";

function normalizeSessionId(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeUserId(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function readPersistedMeetingSessionId(userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) {
    return null;
  }
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(ACTIVE_MEETING_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (normalizeUserId(parsed?.userId) !== normalizedUserId) {
      return null;
    }
    return normalizeSessionId(parsed?.sessionId);
  } catch {
    return null;
  }
}

export function persistMeetingSessionId(sessionId, userId) {
  if (typeof window === "undefined") {
    return;
  }
  const normalized = normalizeSessionId(sessionId);
  const normalizedUserId = normalizeUserId(userId);
  try {
    if (!normalized || !normalizedUserId) {
      window.localStorage.removeItem(ACTIVE_MEETING_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      ACTIVE_MEETING_STORAGE_KEY,
      JSON.stringify({ sessionId: normalized, userId: normalizedUserId })
    );
  } catch {
    // best-effort browser persistence only
  }
}

export function clearPersistedMeetingSessionId() {
  persistMeetingSessionId(null);
}
