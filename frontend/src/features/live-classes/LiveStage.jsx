import BroadcastViewerTheater from "../../components/realtime/BroadcastViewerTheater";
import MeetingRoomExperience from "../../components/realtime/MeetingRoomExperience";
import { resolveBroadcastEmbedUrls } from "../../utils/broadcastUrls";
import { DEFAULT_LIVE_CLASS_SCHEDULE } from "../../utils/liveClassSchedule";
import { PageNotification } from "../app-shell/ui";
import { AllSessionsLink, BackupPlayerLink, LeaveClassButton, LiveMeetingFrame, LiveNowCard, NextClassCard } from "./LiveCards";

/**
 * The course classroom's live area. Idle: "Live now" card with one Join
 * button, or the next class + Add to calendar. Joined: the broadcast theater
 * (video + chat) or the meeting room, with Leave and a backup-player link.
 */
export default function LiveStage({
  schedule,
  liveSession,
  activePayload,
  onJoin,
  onLeave,
  joining = false,
  error = "",
  legacyHref = "/join-live",
}) {
  const currentSchedule = schedule || DEFAULT_LIVE_CLASS_SCHEDULE;
  const errorNotice = error ? (
    <PageNotification kind="error" title="Couldn't open the live class." subtitle={error} />
  ) : null;

  if (activePayload?.mode === "meeting") {
    return (
      <div className="lc-stage">
        <LiveMeetingFrame>
          <MeetingRoomExperience
            payload={activePayload}
            audiencePanel
            onLeave={onLeave}
            onReconnect={() => onJoin(activePayload?.session?.id)}
          />
        </LiveMeetingFrame>
        <div className="lc-stage__footer">
          <BackupPlayerLink href={legacyHref} />
        </div>
      </div>
    );
  }

  if (activePayload?.mode === "broadcast") {
    const urls = resolveBroadcastEmbedUrls({
      streamEmbedUrl: activePayload?.broadcast?.stream_embed_url,
      chatEmbedUrl: activePayload?.broadcast?.chat_embed_url,
    });
    return (
      <div className="lc-stage">
        <div className="lc-theater">
          <BroadcastViewerTheater
            title={activePayload?.session?.title}
            sessionId={activePayload?.session?.id}
            streamUrl={urls.streamEmbedUrl}
            chatUrl={urls.writableChatEmbedUrl || urls.chatEmbedUrl}
            streamStatus={activePayload?.broadcast?.stream_status}
            sessionStatus={activePayload?.session?.status}
            chatEnabled={activePayload?.session?.chat_enabled !== false}
            badgeLabel="Live"
            headerLabel="Now playing"
            chatTitle="Live class chat"
            personalizeChat
            withContainer={false}
            actions={<LeaveClassButton onLeave={onLeave} />}
          />
        </div>
        {errorNotice}
        <div className="lc-stage__footer">
          <BackupPlayerLink href={legacyHref} />
        </div>
      </div>
    );
  }

  return (
    <div className="lc-stage">
      {liveSession ? (
        <LiveNowCard
          session={liveSession}
          onJoin={onJoin}
          joining={joining}
          note="Your class opens right here on this page."
        />
      ) : (
        <NextClassCard schedule={currentSchedule} />
      )}
      {errorNotice}
      <div className="lc-stage__footer">
        {liveSession ? <BackupPlayerLink href={legacyHref} /> : <AllSessionsLink />}
      </div>
    </div>
  );
}
