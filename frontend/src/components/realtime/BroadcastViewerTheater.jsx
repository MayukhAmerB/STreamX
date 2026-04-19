import { useEffect, useRef, useState } from "react";
import ProtectedPlaybackSurface from "../ProtectedPlaybackSurface";
import useOwncastStreamLaunch from "../../hooks/useOwncastStreamLaunch";

function EmptyPanel({ className, message }) {
  return (
    <div className={`flex items-center justify-center px-6 text-center text-sm text-[#BBBBBB] ${className}`.trim()}>
      {message}
    </div>
  );
}

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
  withContainer = true,
  className = "",
}) {
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [streamFrameVersion, setStreamFrameVersion] = useState(0);
  const previousStreamStatusRef = useRef(streamStatus);
  const normalizedStreamStatus = String(streamStatus || "").trim().toLowerCase();
  const normalizedSessionStatus = String(sessionStatus || "").trim().toLowerCase();
  const isSessionEnded = normalizedSessionStatus === "ended";
  const canRenderLiveFrames = !isSessionEnded;
  const secureStream = useOwncastStreamLaunch({
    sessionId,
    streamUrl,
    refreshKey: streamFrameVersion,
    enabled: Boolean(streamUrl && canRenderLiveFrames),
  });
  const resolvedStreamUrl = secureStream.streamUrl;
  const layoutClassName = showHeaderMeta
    ? "mt-3 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)] lg:items-stretch"
    : "grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)] lg:items-stretch";
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

  const refreshStreamFrame = () => {
    setStreamFrameVersion((previous) => previous + 1);
    if (typeof onRefreshStream === "function") {
      onRefreshStream();
    }
  };

  const handleMobileChatToggle = () => {
    setMobileChatOpen((previous) => {
      const next = !previous;
      if (next && typeof onRefreshChat === "function") {
        onRefreshChat();
      }
      return next;
    });
  };

  useEffect(() => {
    const previousStatus = String(previousStreamStatusRef.current || "").trim().toLowerCase();
    if (previousStatus && previousStatus !== "live" && normalizedStreamStatus === "live") {
      setStreamFrameVersion((previous) => previous + 1);
    }
    previousStreamStatusRef.current = normalizedStreamStatus;
  }, [normalizedStreamStatus]);

  useEffect(() => {
    if (isStreamUnavailable) {
      setMobileChatOpen(true);
    }
  }, [isStreamUnavailable]);

  const content = (
    <>
      {showHeaderMeta ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.14em] text-[#949494]">{headerLabel}</div>
            <span className="text-sm text-[#DFDFDF]">{title}</span>
          </div>
          <span className="rounded-full border border-black bg-[#171717] px-3 py-1 text-xs uppercase tracking-[0.12em] text-[#CDCDCD]">
            {badgeLabel}
          </span>
        </div>
      ) : null}

      {resolvedStatusMessage ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black bg-[#141414] px-4 py-3 text-sm text-[#D7D7D7]">
          <span>{resolvedStatusMessage}</span>
          {streamUrl && canRenderLiveFrames ? (
            <button
              type="button"
              onClick={refreshStreamFrame}
              className="rounded-full border border-black bg-[#1B1B1B] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[#E2E2E2] transition hover:bg-[#232323]"
            >
              Retry Video
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={layoutClassName}>
        <div className="overflow-hidden rounded-2xl border border-black bg-black shadow-[0_14px_34px_rgba(0,0,0,0.24)]">
          {streamUrl && canRenderLiveFrames ? (
            <ProtectedPlaybackSurface
              className="aspect-video w-full min-h-[260px] sm:min-h-[360px] lg:min-h-[520px] lg:max-h-[calc(100vh-220px)]"
              watermarkEnabled={Boolean(resolvedStreamUrl)}
            >
              {resolvedStreamUrl ? (
                <iframe
                  key={`${resolvedStreamUrl}|${streamFrameVersion}`}
                  title={streamTitle}
                  src={resolvedStreamUrl}
                  className="block h-full w-full"
                  allow="autoplay"
                />
              ) : (
                <EmptyPanel className="h-full min-h-[260px] sm:min-h-[360px]" message={resolvedStreamFallbackMessage} />
              )}
            </ProtectedPlaybackSurface>
          ) : (
            <EmptyPanel
              className="h-[260px] sm:h-[360px] lg:h-[520px] lg:max-h-[calc(100vh-220px)]"
              message={resolvedStreamFallbackMessage}
            />
          )}
        </div>

        <div className="hidden overflow-hidden rounded-2xl border border-black panel-gradient lg:block lg:h-full lg:min-h-0">
          {chatUrl && canRenderLiveFrames ? (
            <iframe
              title={chatTitle}
              src={chatUrl}
              className="block h-[260px] w-full sm:h-[360px] lg:h-full lg:min-h-[520px] lg:max-h-[calc(100vh-220px)]"
              allow="clipboard-read; clipboard-write"
            />
          ) : (
            <EmptyPanel
              className="h-[260px] sm:h-[360px] lg:h-full lg:min-h-[520px] lg:max-h-[calc(100vh-220px)]"
              message={resolvedChatFallbackMessage}
            />
          )}
        </div>
      </div>

      <div className="mt-3 lg:hidden">
        <button
          type="button"
          onClick={handleMobileChatToggle}
          className="sticky bottom-3 z-20 w-full rounded-xl border border-black bg-[#151515]/96 px-4 py-2.5 text-sm font-semibold text-[#E2E2E2] shadow-[0_16px_34px_rgba(0,0,0,0.3)] backdrop-blur transition hover:bg-[#1C1C1C]"
        >
          {mobileChatOpen ? "Hide Chat" : "Open Chat"}
        </button>
      </div>

      <div
        className={`mt-3 overflow-hidden rounded-2xl panel-gradient transition-[max-height,opacity] duration-300 lg:hidden ${
          mobileChatOpen ? "max-h-[70vh] border border-black opacity-100" : "max-h-0 border border-transparent opacity-0"
        }`}
      >
        {mobileChatOpen ? (
          chatUrl && canRenderLiveFrames ? (
            <iframe
              title={`${chatTitle} (Mobile)`}
              src={chatUrl}
              className="block h-[58vh] min-h-[300px] w-full"
              allow="clipboard-read; clipboard-write"
            />
          ) : (
            <EmptyPanel className="h-[280px]" message={resolvedChatFallbackMessage} />
          )
        ) : null}
      </div>
    </>
  );

  if (!withContainer) {
    return content;
  }

  return (
    <section className={`mb-6 rounded-[26px] border border-black panel-gradient p-4 sm:p-5 ${className}`.trim()}>
      {content}
    </section>
  );
}

