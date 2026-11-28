// Host studio for a broadcast (T5): stage and one control bar on the left,
// Setup · Chat · Recordings · Viewer tabs on the right (below on phones).
// Composes the hooks split out of the old 2,749-line BroadcastingPage.
// OWNER: WS-D1.
import { useCallback, useEffect } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { ScrollTabs } from "../app-shell/ui";
import ChatModerationPanel from "./ChatModerationPanel";
import StudioControls from "./StudioControls";
import StudioRecordingsPanel from "./StudioRecordingsPanel";
import StudioSetupPanel, { sessionUrls } from "./StudioSetupPanel";
import StudioStage from "./StudioStage";
import StudioViewerPanel, { ViewerTheater, isWatching } from "./StudioViewerPanel";
import useChatModeration from "./useChatModeration";
import useHostStudio from "./useHostStudio";
import useStudioRecordings from "./useStudioRecordings";
import useViewerBroadcast from "./useViewerBroadcast";

export const STUDIO_PANELS = [
  { key: "setup", label: "Setup" },
  { key: "chat", label: "Chat" },
  { key: "recordings", label: "Recordings" },
  { key: "viewer", label: "Viewer" },
];

export function panelHref(pathname, search, key) {
  const params = new URLSearchParams(search);
  if (key === "setup") params.delete("panel");
  else params.set("panel", key);
  params.delete("watch");
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

export default function BroadcastStudio({ session, onSession, confirm, header, uploadHref }) {
  const { user, isAuthenticated } = useAuth() || {};
  const location = useLocation();
  const [params] = useSearchParams();
  const panel = STUDIO_PANELS.some((item) => item.key === params.get("panel")) ? params.get("panel") : "setup";

  const syncSession = useCallback((latest) => {
    if (latest?.id === session?.id) onSession(latest);
  }, [onSession, session?.id]);

  const viewer = useViewerBroadcast({
    user,
    isAuthenticated,
    initialPayload: location.state?.autoJoinPayload || null,
    onSessionUpdate: syncSession,
  });
  const recordings = useStudioRecordings({ session, user });
  const chat = useChatModeration({ session });
  const studio = useHostStudio({ session, onSession: syncSession, confirm, onWentLive: viewer.join });

  // ?watch=1 opens the viewer player straight away (old /broadcasting?session=…).
  useEffect(() => {
    if (params.get("watch") === "1" && session?.id && isAuthenticated && !isWatching(viewer, session)) viewer.join(session.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per class
  }, [session?.id, isAuthenticated]);

  const live = studio.linked && studio.studioLink.live;
  const { streamUrl } = sessionUrls(session, viewer.activeBroadcast);
  const chatEnabled = chat.loaded ? chat.chatEnabled : session?.chat_enabled !== false;

  return (
    <div className="cls-studio" data-live={session?.stream_status === "live" ? "true" : "false"}>
      {header(studio)}
      <div className="cls-studio__grid">
        <div className="cls-studio__main">
          <StudioStage
            session={session}
            obsMode={studio.obsMode}
            streamUrl={streamUrl}
            attachPreview={studio.attachPreview}
            connected={studio.connected}
            live={live}
          />
          <StudioControls
            studio={studio}
            session={session}
            onStopLive={() => studio.stopLive({ afterStop: recordings.refresh })}
          />
          <ViewerTheater session={session} viewer={viewer} chatEnabled={chatEnabled} />
        </div>
        <aside className="cls-studio__side" aria-label="Studio panels">
          <ScrollTabs
            label="Studio panels"
            activeKey={panel}
            tabs={STUDIO_PANELS.map((item) => ({ ...item, href: panelHref(location.pathname, location.search, item.key) }))}
          />
          <div className="cls-studio__panel">
            {panel === "setup" ? (
              <StudioSetupPanel
                session={session}
                viewerPayload={viewer.activeBroadcast}
                onSession={syncSession}
                confirm={confirm}
                moduleOptions={recordings.moduleOptions}
              />
            ) : null}
            {panel === "chat" ? <ChatModerationPanel chat={chat} confirm={confirm} /> : null}
            {panel === "recordings" ? (
              <StudioRecordingsPanel
                session={session}
                recordings={recordings}
                browserMode={!studio.obsMode}
                isAdmin={user?.is_admin === true}
                uploadHref={uploadHref}
                confirm={confirm}
              />
            ) : null}
            {panel === "viewer" ? <StudioViewerPanel session={session} viewer={viewer} /> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
