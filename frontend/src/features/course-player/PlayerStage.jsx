import { Locked, Login, PlayFilledAlt, Renew, WarningAlt } from "@carbon/icons-react";
import { Button, InlineLoading } from "@carbon/react";
import { Link } from "react-router-dom";
import ProtectedPlaybackSurface from "../../components/ProtectedPlaybackSurface";

/** "Up next" card with the familiar 5-second countdown at the end of a lesson. */
export function UpNextOverlay({ lecture, secondsLeft, onPlayNow, onCancel }) {
  return (
    <div className="cp-upnext" data-playback-gesture-ignore="true" role="region" aria-label="Up next">
      <div className="cp-upnext__card">
        {/* Announced once by the page's live region; the ticking number is visual only. */}
        <p className="cp-upnext__eyebrow" aria-hidden="true">
          Up next in {secondsLeft}
        </p>
        <p className="cp-upnext__title">{lecture.title}</p>
        <div className="cp-upnext__bar" aria-hidden="true">
          <span className="cp-upnext__bar-fill" />
        </div>
        <div className="cp-upnext__actions">
          <Button kind="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button kind="primary" size="md" renderIcon={PlayFilledAlt} onClick={onPlayNow}>
            Play now
          </Button>
        </div>
      </div>
    </div>
  );
}

function StageMessage({ icon: Icon, title, text, children, tone = "default" }) {
  return (
    <div className={`cp-stage-message cp-stage-message--${tone}`}>
      {Icon ? <Icon size={24} aria-hidden="true" className="cp-stage-message__icon" /> : null}
      <p className="cp-stage-message__title">{title}</p>
      {text ? <p className="cp-stage-message__text">{text}</p> : null}
      {children ? <div className="cp-stage-message__actions">{children}</div> : null}
    </div>
  );
}

/**
 * The 16:9 video area. Plays the signed stream through the shared
 * ProtectedPlaybackSurface (watermark, custom controls, quality, speed,
 * fullscreen), or shows the locked / loading / error state in its place.
 */
export default function PlayerStage({
  playback,
  lecture,
  locked,
  enrollHref,
  previewLecture,
  onWatchPreview,
  loginState,
  upNext,
  onVideoPlay,
}) {
  const hasVideo = Boolean(playback.videoUrl) && !locked;

  let message = null;
  if (!lecture) {
    message = <StageMessage title="Select a lesson to start watching." />;
  } else if (locked || playback.status === "forbidden") {
    message = (
      <StageMessage
        icon={Locked}
        title="This lesson is locked"
        text={previewLecture ? "Enroll to watch every lesson, or try a free preview." : "Enroll in the course to watch every lesson."}
      >
        {enrollHref ? (
          <Button as={Link} to={enrollHref} kind="primary" size="md">
            Enroll now
          </Button>
        ) : null}
        {previewLecture && previewLecture.id !== lecture.id ? (
          <Button kind="secondary" size="md" renderIcon={PlayFilledAlt} onClick={() => onWatchPreview?.(previewLecture)}>
            Watch preview
          </Button>
        ) : null}
      </StageMessage>
    );
  } else if (playback.status === "unauthenticated") {
    message = (
      <StageMessage icon={Login} title="Sign in to watch this lesson.">
        <Button as={Link} to="/login" state={loginState} kind="primary" size="md">
          Sign in
        </Button>
      </StageMessage>
    );
  } else if (playback.status === "error") {
    message = (
      <StageMessage icon={WarningAlt} title="Couldn't play this lesson." text={playback.errorMessage} tone="error">
        <Button kind="primary" size="md" renderIcon={Renew} onClick={playback.retry}>
          Try again
        </Button>
      </StageMessage>
    );
  } else if (!hasVideo) {
    message = (
      <div className="cp-stage-message">
        <InlineLoading description="Loading video…" className="cp-stage-loading" />
      </div>
    );
  }

  return (
    <div className="cp-stage">
      <div className="cp-stage__frame">
        <ProtectedPlaybackSurface
          className="aspect-video"
          watermarkEnabled={hasVideo}
          showFullscreenButton={hasVideo}
          videoRef={hasVideo ? playback.videoRef : null}
          videoSessionKey={hasVideo ? playback.videoSessionKey : ""}
          qualityOptions={playback.qualityOptions}
          selectedQuality={playback.selectedQuality}
          onQualityChange={playback.setSelectedQuality}
          activeQualityLabel={playback.activeQualityLabel}
          qualityControlMessage={playback.qualityControlMessage}
          showQualityControl={playback.playbackType === "hls" && hasVideo}
          autoFullscreenOnLandscape
        >
          {hasVideo ? (
            <video
              key={playback.videoSessionKey}
              ref={playback.videoRef}
              className="cp-video"
              disablePictureInPicture
              disableRemotePlayback
              preload="metadata"
              playsInline
              aria-label={lecture?.title ? `Video: ${lecture.title}` : "Lesson video"}
              onDoubleClick={(event) => event.preventDefault()}
              onError={playback.handleVideoError}
              onPlay={onVideoPlay}
            />
          ) : (
            message
          )}
          {hasVideo && upNext ? <UpNextOverlay {...upNext} /> : null}
        </ProtectedPlaybackSurface>
      </div>
    </div>
  );
}
