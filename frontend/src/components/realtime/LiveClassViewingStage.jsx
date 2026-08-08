import { Link } from "react-router-dom";
import BroadcastViewerTheater from "./BroadcastViewerTheater";
import MeetingRoomExperience from "./MeetingRoomExperience";
import { resolveBroadcastEmbedUrls } from "../../utils/broadcastUrls";
import { DEFAULT_LIVE_CLASS_SCHEDULE, formatNextLiveWindow } from "../../utils/liveClassSchedule";

function PlayerChrome({ children, live = false }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_26px_70px_rgba(0,0,0,0.42)]">
      <div className="relative aspect-video w-full">
        {children}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/85 to-transparent" />
        <div className="pointer-events-none absolute inset-x-5 bottom-4 flex items-center gap-3 text-white/80">
          <span className="inline-block h-0 w-0 border-y-[6px] border-l-[10px] border-y-transparent border-l-white/80" />
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/25">
            <div className={`h-full ${live ? "w-1/3 bg-red-600" : "w-0 bg-white"}`} />
          </div>
          <span className="text-xs font-semibold">{live ? "LIVE" : "OFFLINE"}</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">Full</span>
        </div>
      </div>
    </div>
  );
}

function LegacyFallbackLink({ href }) {
  return (
    <Link
      to={href || "/join-live"}
      className="inline-flex min-h-10 items-center justify-center rounded-lg border border-white/15 bg-[#141414] px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-[#D8D8D8] transition hover:border-white/30 hover:bg-[#1D1D1D] hover:text-white"
    >
      Open legacy live fallback
    </Link>
  );
}

export default function LiveClassViewingStage({
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

  if (activePayload?.mode === "meeting") {
    return (
      <div>
        <MeetingRoomExperience
          payload={activePayload}
          audiencePanel
          onLeave={onLeave}
          onReconnect={() => onJoin(activePayload?.session?.id)}
        />
        <div className="mt-3 flex justify-end">
          <LegacyFallbackLink href={legacyHref} />
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
      <div>
        <BroadcastViewerTheater
          title={activePayload?.session?.title}
          sessionId={activePayload?.session?.id}
          streamUrl={urls.streamEmbedUrl}
          chatUrl={urls.writableChatEmbedUrl || urls.chatEmbedUrl}
          streamStatus={activePayload?.broadcast?.stream_status}
          sessionStatus={activePayload?.session?.status}
          chatEnabled={activePayload?.session?.chat_enabled !== false}
          badgeLabel="Live Class"
          headerLabel="Now playing"
          chatTitle="Live Class Chat"
          personalizeChat
        />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onLeave}
            className="rounded-lg border border-white/10 bg-[#141414] px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#CFCFCF]"
          >
            Leave player
          </button>
          <LegacyFallbackLink href={legacyHref} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PlayerChrome live={Boolean(liveSession)}>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_20%,rgba(255,255,255,0.08),transparent_42%),linear-gradient(145deg,#080808,#121212_56%,#080808)]" />
        <div className="absolute inset-0 flex items-center justify-center px-6 pb-12 text-center">
          {liveSession ? (
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-red-500/45 bg-red-950/50 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.18em] text-red-200">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500 shadow-[0_0_16px_rgba(239,68,68,0.9)]" />
                Class is live now
              </div>
              <h2 className="mt-5 font-reference text-2xl font-semibold text-white sm:text-4xl">
                {liveSession.title || "Your live class"}
              </h2>
              <p className="mt-3 text-sm text-[#BDBDBD] sm:text-base">
                Your approved classroom is ready. Join without leaving the Live Classes page.
              </p>
              <button
                type="button"
                onClick={() => onJoin(liveSession.id)}
                disabled={joining}
                className="mt-7 inline-flex min-h-14 min-w-[220px] items-center justify-center rounded-xl bg-red-600 px-8 py-4 text-base font-extrabold uppercase tracking-[0.1em] text-white shadow-[0_18px_38px_rgba(220,38,38,0.3)] transition hover:bg-red-500 disabled:cursor-wait disabled:opacity-65"
              >
                {joining ? "Connecting..." : "Join Live Class"}
              </button>
            </div>
          ) : (
            <div className="max-w-2xl">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-2xl text-white/70">
                LIVE
              </div>
              <div className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-[#8B8B8B]">
                Live classroom offline
              </div>
              <h2 className="mt-3 font-reference text-2xl font-semibold text-white sm:text-4xl">
                Friday, Saturday and Sunday
              </h2>
              <p className="mt-3 text-lg font-semibold text-[#D6D6D6]">7:00 PM to 8:00 PM IST</p>
              <p className="mt-3 text-sm leading-6 text-[#8F8F8F]">
                This player will become available when your instructor starts an approved session.
              </p>
              <p className="mt-4 text-xs text-[#6F6F6F]">
                Next window: {formatNextLiveWindow(currentSchedule)}
              </p>
            </div>
          )}
        </div>
      </PlayerChrome>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-5">
        <div>
          <h3 className="font-reference text-xl font-semibold text-white sm:text-2xl">
            {liveSession?.title || "AL Syed Initiative live classroom"}
          </h3>
          <p className="mt-1 text-sm text-[#888888]">
            {liveSession ? "Live now for your approved enrollment" : currentSchedule.label}
          </p>
        </div>
        <span className={`rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-[0.12em] ${
          liveSession
            ? "border-red-500/45 bg-red-950/35 text-red-300"
            : "border-white/10 bg-[#141414] text-[#8E8E8E]"
        }`}>
          {liveSession ? "Live" : "Scheduled"}
        </span>
      </div>
      {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
      <div className="mt-4 flex justify-end">
        <LegacyFallbackLink href={legacyHref} />
      </div>
    </div>
  );
}
