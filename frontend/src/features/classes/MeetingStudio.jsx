// Meeting room for an interactive class (moved from the old MeetingPage
// without behaviour change): joins on open, remembers the room across a
// reload, and falls back to the broadcast player when the room is full.
// OWNER: WS-D1.
import { Button, InlineNotification } from "@carbon/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { joinRealtimeSession } from "../../api/realtime";
import MeetingRoomExperience from "../../components/realtime/MeetingRoomExperience";
import { useAuth } from "../../hooks/useAuth";
import { clearPersistedMeetingSessionId, persistMeetingSessionId } from "../../utils/activeMeetingStorage";
import { apiData, apiMessage } from "../../utils/api";
import { ViewerTheater } from "./StudioViewerPanel";
import useViewerBroadcast from "./useViewerBroadcast";
import { liveJoinDisplayName } from "../profiles/publicName";

export default function MeetingStudio({ session, onSession, header }) {
  const { user, isAuthenticated, loading: authLoading } = useAuth() || {};
  const userId = Number(user?.id || 0) || null;
  const [activeMeeting, setActiveMeeting] = useState(null);
  const [joinState, setJoinState] = useState({ loading: false, error: "", left: false });
  const viewer = useViewerBroadcast({ user, isAuthenticated, onSessionUpdate: onSession });
  const joinedFor = useRef(null);

  const joinSession = useCallback(
    async (sessionId) => {
      const data = apiData(await joinRealtimeSession(sessionId, { display_name: liveJoinDisplayName(user) }), {});
      if (data.mode === "broadcast") {
        // The room is full: watch the class as a broadcast instead.
        clearPersistedMeetingSessionId();
        setActiveMeeting(null);
        viewer.setActiveBroadcast(data);
        return data;
      }
      setActiveMeeting(data);
      persistMeetingSessionId(data?.session?.id, userId);
      if (data?.session) onSession(data.session);
      return data;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viewer setter is stable
    [onSession, user, userId]
  );

  const join = useCallback(async () => {
    if (!session?.id) return;
    setJoinState({ loading: true, error: "", left: false });
    try {
      await joinSession(session.id);
      setJoinState({ loading: false, error: "", left: false });
    } catch (err) {
      setJoinState({ loading: false, error: apiMessage(err, "Unable to join meeting."), left: false });
    }
  }, [joinSession, session?.id]);

  // Opening the room joins it (the old "Open Meeting Control" / "Join Meeting").
  useEffect(() => {
    if (authLoading || !isAuthenticated || !session?.id || joinedFor.current === session.id) return;
    joinedFor.current = session.id;
    join();
  }, [authLoading, isAuthenticated, join, session?.id]);

  const leave = () => {
    clearPersistedMeetingSessionId();
    setActiveMeeting(null);
    setJoinState({ loading: false, error: "", left: true });
  };

  return (
    <div className="cls-studio">
      {header()}
      {joinState.error ? (
        <InlineNotification lowContrast kind="error" hideCloseButton title="Couldn't open the room" subtitle={joinState.error} />
      ) : null}
      {activeMeeting?.mode === "meeting" ? (
        <div className="cls-meeting">
          <MeetingRoomExperience payload={activeMeeting} onLeave={leave} onReconnect={joinSession} />
        </div>
      ) : null}
      <ViewerTheater session={viewer.activeBroadcast?.session} viewer={viewer} chatEnabled={viewer.activeBroadcast?.session?.chat_enabled !== false} />
      {!activeMeeting && !viewer.activeBroadcast ? (
        <section className="cls-section cls-meeting-idle" aria-live="polite">
          <h2 className="cls-section__title">{joinState.loading ? "Opening the room…" : joinState.left ? "You left the room" : "Ready when you are"}</h2>
          <p className="cls-help">
            Everyone in the room can talk on camera, up to {session?.meeting_capacity || 200} people. Late joiners beyond that watch as a broadcast.
          </p>
          {!joinState.loading ? (
            <div>
              <Button kind="primary" className="sc-button--accent cls-accent" onClick={join}>
                {joinState.left ? "Rejoin the room" : "Join the room"}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
