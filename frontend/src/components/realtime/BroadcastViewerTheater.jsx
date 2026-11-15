import "./BroadcastViewerTheater.scss";

import { ChevronDown, Launch, Renew, WarningAltFilled } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import useOwncastChatLaunch from "../../hooks/useOwncastChatLaunch";
import useOwncastStreamLaunch from "../../hooks/useOwncastStreamLaunch";
import SecureHlsBroadcastPlayer from "./SecureHlsBroadcastPlayer";

function EmptyPanel({ className = "", message }) {
  return (
    <div className={`bvt__empty ${className}`.trim()}>
      <p>{message}</p>
    </div>
  );
}

/** "live" | "starting" | "offline" | "ended" for the status tag. */
export function resolveTheaterState({ streamStatus = "", sessionStatus = "" } = {}) {
  const stream = String(streamStatus || "").trim().toLowerCase();
  const session = String(sessionStatus || "").trim().toLowerCase();
  if (session === "ended") return "ended";
  if (stream === "starting") return "starting";
  if (stream && stream !== "live") return "offline";
  return "live";
}

const STATE_LABELS = {
  starting: "Reconnecting",
  offline: "Offline",
  ended: "Ended",
};

function ChatPanel({ title, url, message, onRefresh, chatEnabled, open, onToggle }) {
  return (
    <section className="bvt__chat" data-open={open ? "true" : "false"} aria-label={title}>
      <div className="bvt__chat-header">
        <div className="bvt__chat-heading">
          <h3 className="bvt__chat-title">{title}</h3>
          <p className="bvt__chat-status" data-enabled={chatEnabled ? "true" : "false"}>
            <span className="bvt__dot" aria-hidden="true" />
            {chatEnabled ? "Read & reply" : "Chat is off"}
          </p>
        </div>
        <div className="bvt__chat-actions">
          <button type="button" className="bvt__icon-btn" onClick={onRefresh} aria-label="Refresh chat">
            <Renew size={20} aria-hidden="true" />
          </button>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="bvt__icon-btn"
              aria-label="Open chat in a new tab"
            >
              <Launch size={20} aria-hidden="true" />
            </a>
          ) : null}
          <button
            type="button"
            className="bvt__icon-btn bvt__chat-toggle"
            onClick={onToggle}
            disabled={!chatEnabled}
            aria-expanded={open ? "true" : "false"}
            aria-label={open ? "Hide chat" : "Show chat"}
          >
            <ChevronDown size={20} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="bvt__chat-body">
        {url ? (
          <iframe
            title={title}
            src={url}
            className="bvt__chat-frame"
            allow="clipboard-read; clipboard-write"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <EmptyPanel className="bvt__empty--chat" message={message} />
        )}
      </div>
    </section>
  );
}

/**
 * Student live-broadcast view: secure HLS player, title + live status, and
 * the Owncast chat beside the video (desktop) or under it (phones).
 * Styles are self-contained (`bvt-`/`bvt__` classes, Carbon tokens with dark
 * fallbacks) because the instructor Broadcasting page still renders this
 * outside the Carbon shell.
 */
export default function BroadcastViewerTheater({
  title = "",
  sessionId = null,
  streamUrl = "",
  chatUrl = "",
  streamStatus = "",
  sessionStatus = "",
  badgeLabel = "Live Broadcast",
  headerLabel = "Now Viewing",
  streamTitle = "Broadcast Stream",
  chatTitle = "Broadcast Chat",
  streamFallbackMessage = "Stream URL not configured for this session.",
  chatFallbackMessage = "Chat URL not configured for this session.",
  statusMessage = "",
  onRefreshStream = null,
  onRefreshChat = null,
  showHeaderMeta = true,
  showChat = true,
  chatEnabled = true,
  personalizeChat = false,
  withContainer = true,
  className = "",
  actions = null,
}) {
  const [mobileChatOpen, setMobileChatOpen] = useState(true);
  const [streamFrameVersion, setStreamFrameVersion] = useState(0);
  const [chatFrameVersion, setChatFrameVersion] = useState(0);
  const normalizedStreamStatus = String(streamStatus || "").trim().toLowerCase();
  const normalizedSessionStatus = String(sessionStatus || "").trim().toLowerCase();
  const isSessionEnded = normalizedSessionStatus === "ended";
  const canRenderLiveFrames = !isSessionEnded;
  const canUseChat = Boolean(showChat && chatEnabled && canRenderLiveFrames);
  const secureStream = useOwncastStreamLaunch({
    sessionId,
    streamUrl,
    refreshKey: streamFrameVersion,
    enabled: Boolean(streamUrl && canRenderLiveFrames),
  });
  const resolvedStreamUrl = secureStream.streamUrl;
  const secureChat = useOwncastChatLaunch({
    sessionId,
    chatUrl,
    refreshKey: chatFrameVersion,
    enabled: Boolean(personalizeChat && canUseChat && chatUrl),
  });
  const resolvedChatUrl = secureChat.chatUrl;
  const isStreamStarting = Boolean(
    resolvedStreamUrl && normalizedSessionStatus !== "ended" && normalizedStreamStatus === "starting"
  );
  const isStreamUnavailable = Boolean(
    resolvedStreamUrl && normalizedSessionStatus !== "ended" && normalizedStreamStatus && normalizedStreamStatus !== "live"
  );
  const resolvedStreamFallbackMessage = isSessionEnded
    ? "This broadcast session has ended."
    : secureStream.requiresLaunch
      ? secureStream.loading
        ? "Preparing secure video session..."
        : "Secure video could not be prepared. Refresh the page or sign in again."
      : streamFallbackMessage;
  const resolvedChatFallbackMessage = isSessionEnded
    ? "Chat is closed because this broadcast has ended."
    : !chatEnabled
      ? "Live chat has been disabled by a moderator. Video playback remains available."
    : secureChat.requiresLaunch && secureChat.loading
      ? "Preparing your secure live-class chat..."
      : secureChat.error
        ? "Secure chat could not be prepared. Refresh chat or sign in again."
    : chatFallbackMessage;
  const resolvedStatusMessage =
    String(statusMessage || "").trim() ||
    (isSessionEnded
      ? "This broadcast session has ended."
      : isStreamStarting
        ? "The host is reconnecting OBS. Keep chat open and the video will resume here when the stream is back."
      : isStreamUnavailable
        ? "The live video is temporarily offline. Keep chat open while the host reconnects OBS."
        : "");
  const theaterState = resolveTheaterState({ streamStatus, sessionStatus });
  const tagLabel = theaterState === "live" ? badgeLabel : STATE_LABELS[theaterState];

  // Only a manual Retry/Refresh relaunches the stream. When the stream comes
  // back live the player reloads in place (with jitter) on its own, so a
  // whole audience does not request new launches at the same moment.
  const refreshStreamFrame = () => {
    setStreamFrameVersion((previous) => previous + 1);
    if (typeof onRefreshStream === "function") {
      onRefreshStream();
    }
  };

  const refreshChatFrame = () => {
    setChatFrameVersion((previous) => previous + 1);
    if (typeof onRefreshChat === "function") {
      onRefreshChat();
    }
  };

  useEffect(() => {
    if (isStreamUnavailable) {
      setMobileChatOpen(true);
    }
  }, [isStreamUnavailable]);

  const hasMeta = showHeaderMeta || Boolean(resolvedStatusMessage) || Boolean(actions);

  const content = (
    <div
      className={`bvt${showChat ? " bvt--with-chat" : ""}${withContainer ? "" : ` ${className}`}`.trimEnd()}
      data-state={theaterState}
    >
      <div className="bvt__video">
        <div className="bvt__frame">
          {streamUrl && canRenderLiveFrames ? (
            resolvedStreamUrl ? (
              <SecureHlsBroadcastPlayer
                sessionId={sessionId}
                bootstrapUrl={secureStream.sameOriginLaunchUrl}
                hlsUrl={secureStream.hlsUrl}
                fallbackEmbedUrl={resolvedStreamUrl}
                refreshKey={streamFrameVersion}
                streamStatus={normalizedStreamStatus}
                sessionStatus={normalizedSessionStatus}
                title={streamTitle}
              />
            ) : (
              <EmptyPanel className="bvt__empty--video" message={resolvedStreamFallbackMessage} />
            )
          ) : (
            <EmptyPanel className="bvt__empty--video" message={resolvedStreamFallbackMessage} />
          )}
        </div>
      </div>

      {hasMeta ? (
        <div className="bvt__meta">
          {showHeaderMeta || actions ? (
            <div className="bvt__heading">
              {showHeaderMeta ? (
                <div className="bvt__titles">
                  <span className={`bvt__tag bvt__tag--${theaterState}`}>
                    <span className="bvt__dot" aria-hidden="true" />
                    {tagLabel}
                  </span>
                  <h2 className="bvt__title">
                    <span className="bvt__visually-hidden">{headerLabel}: </span>
                    {title || streamTitle}
                  </h2>
                </div>
              ) : null}
              {actions ? <div className="bvt__actions">{actions}</div> : null}
            </div>
          ) : null}

          {resolvedStatusMessage ? (
            <div className="bvt__status" role="status">
              <WarningAltFilled size={20} aria-hidden="true" className="bvt__status-icon" />
              <p className="bvt__status-text">{resolvedStatusMessage}</p>
              {streamUrl && canRenderLiveFrames ? (
                <button type="button" className="bvt__btn" onClick={refreshStreamFrame}>
                  <Renew size={16} aria-hidden="true" />
                  Retry video
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {showChat ? (
        <ChatPanel
          title={chatTitle}
          url={canUseChat ? resolvedChatUrl : ""}
          message={resolvedChatFallbackMessage}
          onRefresh={refreshChatFrame}
          chatEnabled={chatEnabled}
          open={mobileChatOpen}
          onToggle={() => setMobileChatOpen((previous) => !previous)}
        />
      ) : null}
    </div>
  );

  if (!withContainer) {
    return content;
  }

  return <section className={`bvt-container ${className}`.trim()}>{content}</section>;
}
