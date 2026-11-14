// The old /meeting and /broadcasting pages now open Classes (plan §3.3):
//   live in a browser broadcast (or reloaded mid-class) → that class's studio
//   /broadcasting?session=<id>                         → that class's studio (viewer opens)
//   remembered meeting room                            → that meeting room
//   otherwise                                          → /console/{ws}/classes?mode=…
// The host's "You are live" badge links to /broadcasting, so this keeps it
// working. OWNER: WS-D1.
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { getHostStudioController } from "../../services/realtime/hostStudioController";
import { readPersistedMeetingSessionId } from "../../utils/activeMeetingStorage";
import { MODE_BROADCAST, MODE_MEETING, classesPath, studioPath, workspaceRootFor } from "./classesModel";

/** Where an old Meeting/Broadcasting URL goes (pure; tested). */
export function legacyClassesTarget({ mode, search = "", root, liveSessionId = null, resumeSessionId = null, meetingSessionId = null }) {
  const params = new URLSearchParams(search);
  const session = Number(params.get("session"));
  if (mode === MODE_BROADCAST) {
    if (liveSessionId !== null && liveSessionId !== undefined) return studioPath(root, liveSessionId);
    if (Number.isInteger(session) && session > 0) return `${studioPath(root, session)}?watch=1`;
    if (resumeSessionId !== null && resumeSessionId !== undefined) return studioPath(root, resumeSessionId);
    return classesPath(root, MODE_BROADCAST);
  }
  if (meetingSessionId) return studioPath(root, meetingSessionId);
  return classesPath(root, MODE_MEETING);
}

export default function LegacyClassesRedirect({ mode }) {
  const { search, state } = useLocation();
  const { isAdmin, user, loading } = useAuth() || {};
  if (loading) return null;
  const controller = getHostStudioController();
  const snapshot = controller.getSnapshot();
  const target = legacyClassesTarget({
    mode,
    search,
    root: workspaceRootFor("", { isAdmin }),
    liveSessionId: snapshot.live || snapshot.sessionId !== null ? snapshot.sessionId : null,
    resumeSessionId: controller.readResumeCandidate()?.sessionId ?? null,
    meetingSessionId: mode === MODE_MEETING ? readPersistedMeetingSessionId(user?.id) : null,
  });
  return <Navigate to={target} replace state={state} />;
}
