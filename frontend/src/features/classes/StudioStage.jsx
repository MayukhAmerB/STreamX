// The studio's 16:9 stage: the camera/screen preview for browser classes,
// the secure OBS monitor for OBS classes. OWNER: WS-D1.
import { useState } from "react";
import useOwncastStreamLaunch from "../../hooks/useOwncastStreamLaunch";
import { HOST_SOURCE } from "../../services/realtime/hostStudioController";

function StageMessage({ children, onClick }) {
  if (onClick) {
    return (
      <button type="button" className="cls-stage__message cls-stage__message--action" onClick={onClick}>
        {children}
      </button>
    );
  }
  return <p className="cls-stage__message">{children}</p>;
}

function ObsMonitor({ sessionId, streamUrl }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const secure = useOwncastStreamLaunch({ sessionId, streamUrl, refreshKey, enabled: Boolean(streamUrl) });
  if (!streamUrl) return <StageMessage>The stream preview appears here after OBS starts publishing.</StageMessage>;
  if (secure.streamUrl) {
    return <iframe title="OBS broadcast monitor" src={secure.streamUrl} className="cls-stage__media" allow="autoplay; fullscreen" />;
  }
  return (
    <StageMessage onClick={() => setRefreshKey((previous) => previous + 1)}>
      {secure.loading ? "Preparing the secure OBS monitor…" : "The secure OBS monitor could not be prepared. Tap to retry."}
    </StageMessage>
  );
}

export function sourceLabel(source) {
  if (source === HOST_SOURCE.SCREEN) return "Screen share";
  if (source === HOST_SOURCE.PLACEHOLDER) return "None (viewers see a blank screen)";
  return "Camera";
}

export default function StudioStage({ session, obsMode, streamUrl, attachPreview, connected, live }) {
  const ended = String(session?.status || "").toLowerCase() === "ended";
  return (
    <div className={`cls-stage${live ? " is-live" : ""}`}>
      {ended && obsMode ? (
        <StageMessage>This class has ended. Its recording is in the Recordings tab.</StageMessage>
      ) : obsMode ? (
        <ObsMonitor sessionId={session?.id} streamUrl={streamUrl} />
      ) : (
        <>
          <video ref={attachPreview} autoPlay muted playsInline className="cls-stage__media cls-stage__video" aria-label="Your camera or screen preview" />
          {!connected ? <StageMessage>Connect your camera or share your screen to see the preview here.</StageMessage> : null}
        </>
      )}
    </div>
  );
}
