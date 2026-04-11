import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import ProtectedPlaybackSurface from "../components/ProtectedPlaybackSurface";
import { getGuideVideoUrl, listGuides } from "../api/guides";
import { apiData, apiMessage } from "../utils/api";

export function GuidesPageContent({
  guides,
  selectedGuide,
  videoUrl,
  loading,
  loadingVideo,
  error,
  videoError,
  onSelectGuide,
  onVideoError,
  videoRef,
}) {
  if (loading) {
    return <p className="text-sm text-[#BBBBBB]">Loading guides...</p>;
  }

  if (!guides.length) {
    return (
      <div className="rounded-[28px] border border-black panel-gradient p-6 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
        <h2 className="font-reference text-xl font-semibold text-white">No guides published yet</h2>
        <p className="mt-2 max-w-2xl text-sm leading-7 text-[#BBBBBB]">
          Once guide videos are uploaded and published from the Guide Panel, they will appear here for every logged-in user.
        </p>
        {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[1.18fr_0.82fr]">
      <section className="overflow-hidden rounded-[28px] border border-black panel-gradient shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
        <div className="border-b border-[#222222] bg-[radial-gradient(circle_at_top_right,rgba(192,192,192,0.15),transparent_36%)] p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#949494]">
                Guide Viewer
              </div>
              <h2 className="mt-2 text-2xl font-semibold text-white">
                {selectedGuide?.title || "Select a guide"}
              </h2>
              <p className="mt-1 text-sm text-[#BBBBBB]">
                Platform walkthroughs for onboarding, navigation, and daily use.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold text-[#E0E0E0]">
                {guides.length} guide{guides.length === 1 ? "" : "s"}
              </span>
              {loadingVideo ? (
                <span className="rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold text-[#E0E0E0]">
                  Loading video...
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="p-5">
          <div className="overflow-hidden rounded-[24px] border border-black bg-black">
            <ProtectedPlaybackSurface
              className="aspect-video"
              watermarkEnabled={Boolean(videoUrl)}
              showFullscreenButton={Boolean(videoUrl)}
              videoRef={videoUrl ? videoRef : null}
              videoSessionKey={videoUrl || ""}
            >
              {videoUrl ? (
                <video
                  key={videoUrl}
                  ref={videoRef}
                  src={videoUrl}
                  disablePictureInPicture
                  disableRemotePlayback
                  preload="metadata"
                  playsInline
                  className="h-full w-full bg-black object-contain"
                  onDoubleClick={(event) => event.preventDefault()}
                  onError={onVideoError}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[#8F8F8F]">
                  {loadingVideo ? "Preparing the selected guide..." : "Select a guide to start watching."}
                </div>
              )}
            </ProtectedPlaybackSurface>
          </div>

          <div className="mt-5 rounded-2xl border border-black panel-gradient p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              Guide Notes
            </div>
            <p className="mt-3 text-sm leading-7 text-[#D7D7D7]">
              {selectedGuide?.description || "This guide will walk through the selected workflow step by step."}
            </p>
            {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
            {videoError ? <p className="mt-3 text-sm text-amber-300">{videoError}</p> : null}
          </div>
        </div>
      </section>

      <aside className="overflow-hidden rounded-[28px] border border-black panel-gradient shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
        <div className="border-b border-[#222222] bg-[radial-gradient(circle_at_top,rgba(192,192,192,0.12),transparent_48%)] p-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#949494]">
            Guide Library
          </div>
          <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
            Admin-uploaded help videos for learning how to use the platform.
          </p>
        </div>

        <div className="max-h-[72vh] space-y-3 overflow-auto p-4">
          {guides.map((guide, index) => {
            const isActive = guide.id === selectedGuide?.id;
            return (
              <button
                key={guide.id}
                type="button"
                onClick={() => onSelectGuide(guide)}
                className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                  isActive
                    ? "border-[#C0C0C0] bg-[#DFDFDF] text-[#1D1D1D]"
                    : "border-black bg-[#0C0C0C] text-[#D9D9D9] hover:border-black hover:bg-[#141414]"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] opacity-70">
                      Guide {index + 1}
                    </div>
                    <div className="mt-2 text-base font-semibold">{guide.title}</div>
                    <p className={`mt-2 text-sm leading-6 ${isActive ? "text-[#3A3A3A]" : "text-[#949494]"}`}>
                      {guide.description || "Video guide ready to watch from the platform library."}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                      isActive
                        ? "border border-[#A9A9A9] bg-white text-[#202020]"
                        : "border border-black bg-[#171717] text-[#A1A1A1]"
                    }`}
                  >
                    {isActive ? "Now Playing" : "Watch"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

export default function GuidesPage() {
  const [guides, setGuides] = useState([]);
  const [selectedGuideId, setSelectedGuideId] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingVideo, setLoadingVideo] = useState(false);
  const [error, setError] = useState("");
  const [videoError, setVideoError] = useState("");
  const videoRef = useRef(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listGuides();
        const items = apiData(response, []);
        if (!active) return;
        setGuides(items);
        setSelectedGuideId((current) => {
          if (current && items.some((guide) => guide.id === current)) {
            return current;
          }
          return items[0]?.id || null;
        });
      } catch (err) {
        if (!active) return;
        setGuides([]);
        setError(apiMessage(err, "Failed to load guides."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const selectedGuide = useMemo(
    () => guides.find((guide) => guide.id === selectedGuideId) || null,
    [guides, selectedGuideId]
  );

  useEffect(() => {
    if (!selectedGuide?.id) {
      setVideoUrl("");
      setLoadingVideo(false);
      return;
    }

    let active = true;
    setLoadingVideo(true);
    setVideoError("");
    setVideoUrl("");

    (async () => {
      try {
        const response = await getGuideVideoUrl(selectedGuide.id);
        if (!active) return;
        const data = apiData(response, {});
        const nextVideoUrl = data?.playback_url || data?.signed_url || "";
        setVideoUrl(nextVideoUrl);
        if (!nextVideoUrl) {
          setVideoError("This guide video is not available right now.");
        }
      } catch (err) {
        if (!active) return;
        setVideoError(apiMessage(err, "Failed to load the selected guide video."));
      } finally {
        if (active) setLoadingVideo(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [selectedGuide?.id]);

  return (
    <PageShell
      title="Guides"
      subtitle="Watch admin-uploaded walkthrough videos for learning how to use the platform."
      badge="Guide Library"
      action={
        <Link to="/my-courses" className="inline-flex">
          <Button variant="secondary">Your Courses</Button>
        </Link>
      }
    >
      <GuidesPageContent
        guides={guides}
        selectedGuide={selectedGuide}
        videoUrl={videoUrl}
        loading={loading}
        loadingVideo={loadingVideo}
        error={error}
        videoError={videoError}
        onSelectGuide={(guide) => setSelectedGuideId(guide.id)}
        onVideoError={() => setVideoError("This guide video could not be played in your browser.")}
        videoRef={videoRef}
      />
    </PageShell>
  );
}
