import { useEffect, useRef, useState } from "react";
import ProtectedPlaybackSurface from "../ProtectedPlaybackSurface";
import useOwncastChatLaunch from "../../hooks/useOwncastChatLaunch";
import useOwncastStreamLaunch from "../../hooks/useOwncastStreamLaunch";

function EmptyPanel({ className, message }) {
  return (
    <div className={`flex items-center justify-center px-6 text-center text-sm text-[#BBBBBB] ${className}`.trim()}>
      {message}
    </div>
  );
}

function ChatPanel({ title, url, message, onRefresh }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-white/10 bg-[#101010] px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-white">{title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Read &amp; reply
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-lg border border-white/10 bg-[#171717] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#D7D7D7] transition hover:bg-[#222222]"
          >
            Refresh
          </button>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-white/10 bg-white px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-black transition hover:bg-[#E5E5E5]"
            >
              Open
            </a>
          ) : null}
        </div>
      </div>
      {url ? (
        <iframe
          title={title}
          src={url}
          className="block h-[58vh] min-h-[340px] w-full flex-1 lg:h-full lg:min-h-[466px] lg:max-h-[calc(100vh-276px)]"
          allow="clipboard-read; clipboard-write"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <EmptyPanel className="h-[340px] flex-1 lg:min-h-[466px]" message={message} />
      )}
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
  showChat = true,
  personalizeChat = false,
  withContainer = true,
  className = "",
}) {
  const [mobileChatOpen, setMobileChatOpen] = useState(true);
  const [streamFrameVersion, setStreamFrameVersion] = useState(0);
  const [chatFrameVersion, setChatFrameVersion] = useState(0);
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
  const secureChat = useOwncastChatLaunch({
    sessionId,
    chatUrl,
    refreshKey: chatFrameVersion,
    enabled: Boolean(personalizeChat && showChat && chatUrl && canRenderLiveFrames),
  });
  const resolvedChatUrl = secureChat.chatUrl;
  const layoutClassName = showChat
    ? showHeaderMeta
      ? "mt-3 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)] lg:items-stretch"
      : "grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)] lg:items-stretch"
    : showHeaderMeta
      ? "mt-3"
      : "";
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

        {showChat ? (
          <>
            <button
              type="button"
              onClick={() => setMobileChatOpen((previous) => !previous)}
              className="sticky bottom-3 z-20 w-full rounded-xl border border-white/10 bg-[#151515]/96 px-4 py-3 text-sm font-semibold text-[#EAEAEA] shadow-[0_16px_34px_rgba(0,0,0,0.3)] backdrop-blur transition hover:bg-[#1C1C1C] lg:hidden"
            >
              {mobileChatOpen ? "Hide Live Chat" : "Show Live Chat & Reply"}
            </button>
            <div
              className={`${mobileChatOpen ? "block" : "hidden"} overflow-hidden rounded-2xl border border-black panel-gradient lg:block lg:h-full lg:min-h-0`}
            >
              <ChatPanel
                title={chatTitle}
                url={canRenderLiveFrames ? resolvedChatUrl : ""}
                message={resolvedChatFallbackMessage}
                onRefresh={refreshChatFrame}
              />
            </div>
          </>
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

