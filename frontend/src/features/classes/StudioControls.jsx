// The studio's one control bar plus its notices (plan §3.5: "live controls
// in one bar"). Go Live / Start Live is the screen's one champagne action.
// OWNER: WS-D1.
import { Camera, Close, Screen, StopFilled } from "@carbon/icons-react";
import { Button, InlineNotification } from "@carbon/react";
import { HOST_LINK, HOST_SOURCE } from "../../services/realtime/hostStudioController";
import { normalizedStreamStatus } from "./classesModel";
import { sourceLabel } from "./StudioStage";

export function obsStartLabel(session) {
  return ["starting", "live", "stopped", "failed"].includes(normalizedStreamStatus(session)) ? "Resume OBS" : "Start Live";
}

function cameraLabel(connected, source) {
  if (connected && source === HOST_SOURCE.CAMERA) return "Restart camera";
  if (connected) return "Switch to camera";
  return "Connect camera";
}

function Notices({ studio, session, preflight }) {
  const { studioState, studioLink, linked, obsMode } = studio;
  const egressError = String(session?.livekit_egress_error || "").trim();
  return (
    <div className="cls-notices">
      {!obsMode && linked && studioLink.deliveryFailed ? (
        <div className="cls-alert" role="alert">
          <p>Viewers are not receiving your broadcast. Your camera is still connected.</p>
          <Button kind="danger" size="sm" disabled={studioLink.goingLive} onClick={studio.resumeDelivery}>
            Resume broadcast
          </Button>
        </div>
      ) : null}
      {!obsMode && studioLink.goingLive ? (
        <div className="cls-going-live">
          <span className="cls-indeterminate" aria-hidden="true" />
          <span role="status">Going live… the stream starts in a few seconds.</span>
          <Button kind="ghost" size="sm" onClick={studio.cancelGoLive}>
            Cancel Go Live
          </Button>
        </div>
      ) : null}
      {preflight?.ok === false ? (
        <InlineNotification
          lowContrast
          kind="warning"
          role="alert"
          hideCloseButton
          title="Pre-class check found a problem"
          subtitle={`${(preflight.failed || []).join(", ")}. Ops has been alerted; you can still try to go live.`}
        />
      ) : null}
      {studioState.error ? <InlineNotification lowContrast kind="error" hideCloseButton title="Studio" subtitle={studioState.error} /> : null}
      {studioState.info ? (
        <p className="cls-help" role="status">
          {studioState.info}
        </p>
      ) : null}
      {!obsMode && linked && studioLink.error ? (
        <p className="cls-help cls-error" role="alert">
          {studioLink.error}
        </p>
      ) : null}
      {!obsMode && linked && studioLink.info ? <p className="cls-help">{studioLink.info}</p> : null}
      {egressError ? (
        <p className="cls-help cls-warning">
          {obsMode ? "Stream" : "Egress"}: {egressError}
        </p>
      ) : null}
    </div>
  );
}

export default function StudioControls({ studio, session, onStopLive }) {
  const { obsMode, connected, connecting, linked, studioLink, studioState, videoSource, profile } = studio;
  const ended = String(session?.status || "").toLowerCase() === "ended";
  const streamLive = !ended && session?.stream_status === "live";
  const busy = studioState.actionLoading;
  return (
    <div className="cls-controls">
      <div className={`cls-controls__bar${obsMode ? "" : " cls-controls__bar--browser"}`} role="toolbar" aria-label="Live controls">
        {!obsMode ? (
          <div className="cls-controls__sources">
            <Button kind="tertiary" size="md" renderIcon={Camera} disabled={ended || connecting || busy} onClick={studio.connectCamera}>
              {connecting ? "Connecting…" : cameraLabel(connected, videoSource)}
            </Button>
            <Button kind="ghost" size="md" renderIcon={Screen} disabled={ended || connecting || busy} onClick={studio.shareScreen}>
              {connected && videoSource === HOST_SOURCE.SCREEN ? "Reshare screen" : "Share screen"}
            </Button>
            <Button
              kind="ghost"
              size="md"
              renderIcon={Close}
              disabled={!linked || studioLink.link === HOST_LINK.IDLE || busy}
              onClick={() => studio.disconnect({ confirmIfLive: true })}
            >
              Disconnect
            </Button>
          </div>
        ) : null}
        <div className="cls-controls__live">
          <Button kind="danger--ghost" size="md" renderIcon={StopFilled} disabled={!streamLive || busy} onClick={onStopLive}>
            Stop Live
          </Button>
          <Button
            kind="primary"
            size="md"
            className={streamLive || ended ? "cls-go-live" : "cls-go-live sc-button--accent cls-accent"}
            disabled={ended || busy}
            aria-describedby={ended ? "cls-ended-reason" : undefined}
            onClick={studio.startLive}
          >
            {busy ? "Working…" : obsMode ? obsStartLabel(session) : streamLive ? "Verify delivery" : "Go Live"}
          </Button>
        </div>
      </div>
      {ended ? (
        <p id="cls-ended-reason" className="cls-help" role="status">
          This class has ended, so it cannot go live again. Host a new class from Classes.
        </p>
      ) : null}
      <Notices studio={studio} session={session} preflight={studio.preflight} />
      {ended ? null : (
        <p className="cls-meta">
          {obsMode
            ? `Publish from OBS with the server URL and key, then watch the monitor here. If OBS drops, keep this page open and press “${obsStartLabel(session)}” to prepare the same stream again.`
            : `Source: ${sourceLabel(videoSource)} · ${profile.capture_width}×${profile.capture_height} at ${profile.fps} fps, up to ${profile.max_video_bitrate_kbps} kbps.`}{" "}
          Every class is recorded and published to the course when it ends.
        </p>
      )}
    </div>
  );
}
