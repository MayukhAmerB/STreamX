// Watch the class exactly as students do (player and verified chat): the
// "Viewer" tab joins, the player opens under the stage. OWNER: WS-D1.
import { Button, InlineNotification } from "@carbon/react";
import BroadcastViewerTheater from "../../components/realtime/BroadcastViewerTheater";
import SecretField from "./SecretField";
import { buildJoinLink } from "./classesModel";
import useCopyToast from "./useCopyToast";

export function isWatching(viewer, session) {
  return Boolean(session?.id) && viewer.activeBroadcast?.session?.id === session.id;
}

export function ViewerTheater({ session, viewer, chatEnabled }) {
  if (!isWatching(viewer, session)) return null;
  const { activeBroadcast } = viewer;
  return (
    <section className="cls-theater" aria-label="What viewers see">
      <BroadcastViewerTheater
        title={activeBroadcast.session?.title}
        sessionId={activeBroadcast.session?.id}
        streamUrl={viewer.streamUrl}
        chatUrl={viewer.chatUrl}
        chatFallbackMessage={viewer.chatFallbackMessage}
        streamStatus={activeBroadcast.broadcast?.stream_status}
        sessionStatus={activeBroadcast.session?.status}
        chatEnabled={chatEnabled}
        showHeaderMeta={false}
        withContainer={false}
        statusMessage={viewer.statusMessage}
        onRefreshStream={viewer.refreshStream}
        onPlaybackStalledChange={viewer.setPlaybackStalled}
        onRefreshChat={viewer.refreshChat}
      />
    </section>
  );
}

export default function StudioViewerPanel({ session, viewer }) {
  const copy = useCopyToast();
  const { activeBroadcast, joinState, join, ended } = viewer;
  const watching = isWatching(viewer, session);
  return (
    <div className="cls-panel-stack">
      <section className="cls-section" aria-labelledby="cls-viewer-title">
        <div className="cls-section__head">
          <h2 id="cls-viewer-title" className="cls-section__title">
            Watch as a viewer
          </h2>
          {watching ? (
            <span className={`cls-pill cls-pill--${ended ? "idle" : "good"}`}>
              <span className="cls-pill__dot" aria-hidden="true" />
              {ended ? "Ended broadcast" : "Watching"}
            </span>
          ) : null}
        </div>
        <p className="cls-help">
          {watching
            ? "The player and chat under the stage show the class exactly as students see it."
            : "See the player and chat exactly as your students do. It opens by itself after Go Live."}
        </p>
        {!watching ? (
          <div>
            <Button kind="tertiary" size="md" disabled={joinState.loadingId === session?.id} onClick={() => join(session.id)}>
              {joinState.loadingId === session?.id ? "Joining…" : "Watch as a viewer"}
            </Button>
          </div>
        ) : null}
        {watching && !ended ? (
          <SecretField
            id="cls-viewer-link"
            label="Protected viewer link"
            value={buildJoinLink(activeBroadcast.session)}
            secret
            resetKey={activeBroadcast.session?.id}
            onCopy={() => copy(buildJoinLink(activeBroadcast.session), "Secure viewer link copied.", "Secure viewer link is not ready yet.")}
          />
        ) : null}
        {joinState.error ? <InlineNotification lowContrast kind="error" hideCloseButton title="Viewer" subtitle={joinState.error} /> : null}
        {joinState.info && !watching ? (
          <p className="cls-help" role="status">
            {joinState.info}
          </p>
        ) : null}
      </section>
    </div>
  );
}
