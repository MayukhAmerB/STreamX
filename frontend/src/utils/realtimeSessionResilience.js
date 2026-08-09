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
