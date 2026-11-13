export function retainRealtimeSessionsOnRefresh(rows, previousSessions = []) {
  return Array.isArray(rows) ? rows : previousSessions;
}

export function reconcileActiveLivePayload(activePayload, sessions = []) {
  if (!activePayload?.session?.id) return activePayload;

  const latestSession = sessions.find(
    (session) => String(session?.id) === String(activePayload.session.id)
  );
  if (!latestSession) return activePayload;
  if (String(latestSession.status || "").toLowerCase() === "ended") return null;

  return {
    ...activePayload,
    session: {
      ...activePayload.session,
      ...latestSession,
    },
  };
}

// The session list holds active sessions only: an ended class drops out of it
// instead of appearing as "ended". Returns the watched session's id when a
// refresh no longer contains it (the caller then confirms with the session's
// own endpoint before closing the player), else null.
export function missingActiveSessionId(activePayload, sessions = []) {
  const id = activePayload?.session?.id;
  if (id === undefined || id === null || id === "") return null;
  const rows = Array.isArray(sessions) ? sessions : [];
  return rows.some((session) => String(session?.id) === String(id)) ? null : id;
}
