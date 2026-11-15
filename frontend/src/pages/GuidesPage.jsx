import "./GuidesPage.scss";

import { ArrowRight, Book, PlayFilledAlt } from "@carbon/icons-react";
import { Button, InlineLoading, Tag } from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGuideVideoUrl, listGuides } from "../api/guides";
import ProtectedPlaybackSurface from "../components/ProtectedPlaybackSurface";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, useBreakpoint, useMediaQuery } from "../features/app-shell/ui";
import { apiData, apiMessage } from "../utils/api";

/** Picks the guide to show: the current one when it still exists, else the first. */
export function resolveSelectedGuideId(guides = [], requestedId = null) {
  if (requestedId != null && guides.some((guide) => String(guide.id) === String(requestedId))) {
    return guides.find((guide) => String(guide.id) === String(requestedId)).id;
  }
  return guides[0]?.id ?? null;
}

function GuideStageMessage({ loadingVideo }) {
  return (
    <div className="cds-guides__stage-message">
      {loadingVideo ? (
        <InlineLoading description="Loading video…" />
      ) : (
        <p>Choose a guide to start watching.</p>
      )}
    </div>
  );
}

/** Presentational view, also used by tests. */
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
  onRetry,
  onRetryVideo,
  videoRef,
  stageRef,
}) {
  if (loading) {
    return <PageSkeleton label="Loading guides" count={2} />;
  }

  if (!guides.length) {
    return error ? (
      <PageNotification
        kind="error"
        title="Guides could not be loaded."
        subtitle={error}
        actionLabel={onRetry ? "Try again" : undefined}
        onAction={onRetry}
      />
    ) : (
      <EmptyState icon={Book} text="No guides yet. New how-to videos will appear here." />
    );
  }

  const selectedIndex = Math.max(
    0,
    guides.findIndex((guide) => guide.id === selectedGuide?.id)
  );
  const nextGuide = selectedGuide ? guides[selectedIndex + 1] || null : null;

  return (
    <div className="cds-guides">
      <section className="cds-guides__viewer" aria-label="Guide player">
        <div className="cds-guides__stage" ref={stageRef}>
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
                className="cds-guides__video"
                aria-label={selectedGuide?.title ? `Video: ${selectedGuide.title}` : "Guide video"}
                disablePictureInPicture
                disableRemotePlayback
                preload="metadata"
                playsInline
                onDoubleClick={(event) => event.preventDefault()}
                onError={onVideoError}
              />
            ) : (
              <GuideStageMessage loadingVideo={loadingVideo} />
            )}
          </ProtectedPlaybackSurface>
        </div>

        <div className="cds-guides__details">
          <p className="cds-guides__eyebrow">
            Guide {selectedIndex + 1} of {guides.length}
          </p>
          <h2 className="cds-guides__title">{selectedGuide?.title || "Choose a guide"}</h2>
          {selectedGuide?.description ? (
            <p className="cds-guides__description">{selectedGuide.description}</p>
          ) : null}
          {videoError ? (
            <PageNotification
              kind="warning"
              title="This video can't play right now."
              subtitle={videoError}
              actionLabel={onRetryVideo ? "Try again" : undefined}
              onAction={onRetryVideo}
            />
          ) : null}
          {error ? <PageNotification kind="error" title="Something went wrong." subtitle={error} /> : null}
          {nextGuide ? (
            <Button
              kind="tertiary"
              size="md"
              renderIcon={ArrowRight}
              className="cds-guides__next"
              onClick={() => onSelectGuide(nextGuide)}
            >
              Next guide
            </Button>
          ) : null}
        </div>
      </section>

      <section className="cds-guides__library" aria-labelledby="cds-guides-library-title">
        <div className="cds-guides__library-header">
          <h2 id="cds-guides-library-title" className="cds-guides__library-title">
            All guides
          </h2>
          <Tag type="gray" size="sm">
            {guides.length}
          </Tag>
        </div>
        <ol className="cds-guides__list">
          {guides.map((guide, index) => {
            const active = guide.id === selectedGuide?.id;
            return (
              <li key={guide.id}>
                <button
                  type="button"
                  className={`cds-guide-item${active ? " is-active" : ""}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelectGuide(guide)}
                >
                  <span className="cds-guide-item__index" aria-hidden="true">
                    {active ? <PlayFilledAlt size={16} /> : index + 1}
                  </span>
                  <span className="cds-guide-item__text">
                    <span className="cds-guide-item__title">{guide.title}</span>
                    {guide.description ? (
                      <span className="cds-guide-item__description">{guide.description}</span>
                    ) : null}
                  </span>
                  {active ? (
                    <Tag type="blue" size="sm" className="cds-guide-item__tag">
                      Now playing
                    </Tag>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </section>
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
  const [reloadKey, setReloadKey] = useState(0);
  const [videoAttempt, setVideoAttempt] = useState(0);
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const { isDesktop } = useBreakpoint();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const response = await listGuides();
        const items = apiData(response, []);
        if (!active) return;
        const nextGuides = Array.isArray(items) ? items : [];
        setGuides(nextGuides);
        setSelectedGuideId((current) => resolveSelectedGuideId(nextGuides, current));
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
  }, [reloadKey]);

  const selectedGuide = useMemo(
    () => guides.find((guide) => guide.id === selectedGuideId) || null,
    [guides, selectedGuideId]
  );

  useEffect(() => {
    if (!selectedGuide?.id) {
      setVideoUrl("");
      setLoadingVideo(false);
      return undefined;
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
  }, [selectedGuide?.id, videoAttempt]);

  const handleSelectGuide = useCallback(
    (guide) => {
      if (!guide) return;
      setSelectedGuideId(guide.id);
      // On phones the list sits below the player: bring the player back into view.
      if (!isDesktop) {
        stageRef.current?.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }
    },
    [isDesktop, reduceMotion]
  );

  return (
    <>
      <PageHeader title="Guides" description="Short videos that show you how to use the platform." />
      <GuidesPageContent
        guides={guides}
        selectedGuide={selectedGuide}
        videoUrl={videoUrl}
        loading={loading}
        loadingVideo={loadingVideo}
        error={error}
        videoError={videoError}
        onSelectGuide={handleSelectGuide}
        onVideoError={() => setVideoError("This guide video could not be played in your browser.")}
        onRetry={() => setReloadKey((value) => value + 1)}
        onRetryVideo={() => setVideoAttempt((value) => value + 1)}
        videoRef={videoRef}
        stageRef={stageRef}
      />
    </>
  );
}
