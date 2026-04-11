import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { useParams } from "react-router-dom";
import { getCourse, getLectureVideoUrl, updateLectureProgress } from "../api/courses";
import PageShell from "../components/PageShell";
import ProtectedPlaybackSurface from "../components/ProtectedPlaybackSurface";
import { apiData, apiMessage } from "../utils/api";

const PROGRESS_SYNC_INTERVAL_SECONDS = 15;
const PROGRESS_THROTTLE_BACKOFF_MS = 30000;

function resolveRetryAfterMs(error, fallbackMs = PROGRESS_THROTTLE_BACKOFF_MS) {
  const retryAfterHeader = error?.response?.headers?.["retry-after"];
  if (!retryAfterHeader) return fallbackMs;

  const retryAfterValue = String(retryAfterHeader).trim();
  const seconds = Number(retryAfterValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1000, seconds * 1000);
  }

  const retryAt = Date.parse(retryAfterValue);
  if (Number.isFinite(retryAt)) {
    return Math.max(1000, retryAt - Date.now());
  }

  return fallbackMs;
}

function flattenCourseLectures(course) {
  return (course?.sections || []).flatMap((section) =>
    (section.lectures || []).map((lecture) => ({
      ...lecture,
      section_title: section.title,
    }))
  );
}

function pickInitialLecture(course) {
  const lectures = flattenCourseLectures(course);
  if (!lectures.length) return null;

  const mostRecentProgressLecture = [...lectures]
    .filter((lecture) => lecture?.progress?.updated_at)
    .sort(
      (left, right) =>
        new Date(right.progress.updated_at).getTime() - new Date(left.progress.updated_at).getTime()
    )[0];

  if (mostRecentProgressLecture) return mostRecentProgressLecture;
  return lectures[0];
}

function applyLectureProgressSnapshot(course, lectureId, progress) {
  if (!course) return course;
  return {
    ...course,
    sections: (course.sections || []).map((section) => ({
      ...section,
      lectures: (section.lectures || []).map((lecture) =>
        lecture.id === lectureId ? { ...lecture, progress } : lecture
      ),
    })),
  };
}

function formatSeconds(totalSeconds) {
  const normalized = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatFileSize(totalBytes) {
  const normalized = Math.max(0, Number(totalBytes) || 0);
  if (normalized < 1024) return `${normalized} B`;
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(1)} KB`;
  return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CoursePlayerPage() {
  const { courseId } = useParams();
  const [course, setCourse] = useState(null);
  const [selectedLecture, setSelectedLecture] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [playbackType, setPlaybackType] = useState("file");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retried, setRetried] = useState(false);
  const [progressState, setProgressState] = useState({ saving: false, error: "", savedAt: "" });
  const videoRef = useRef(null);
  const resumeAppliedRef = useRef(false);
  const progressInFlightRef = useRef(false);
  const pendingProgressRef = useRef(null);
  const deferredProgressRef = useRef(null);
  const progressRetryAtRef = useRef(0);
  const progressRetryTimerRef = useRef(null);
  const lastSyncedRef = useRef({
    lectureId: null,
    positionSeconds: 0,
    durationSeconds: 0,
    completed: false,
  });

  function clearProgressRetryTimer() {
    if (progressRetryTimerRef.current && typeof window !== "undefined") {
      window.clearTimeout(progressRetryTimerRef.current);
    }
    progressRetryTimerRef.current = null;
  }

  function scheduleDeferredProgressRetry(delayMs) {
    if (typeof window === "undefined") return;
    clearProgressRetryTimer();
    progressRetryTimerRef.current = window.setTimeout(() => {
      progressRetryTimerRef.current = null;
      progressRetryAtRef.current = 0;
      const deferredSnapshot = deferredProgressRef.current;
      deferredProgressRef.current = null;
      if (deferredSnapshot) {
        void syncLectureProgress({ ...deferredSnapshot, force: true });
      }
    }, delayMs);
  }

  const lectureCount = useMemo(
    () => course?.sections?.reduce((acc, section) => acc + (section.lectures?.length || 0), 0) || 0,
    [course]
  );

  const lectureStats = useMemo(() => {
    const lectures = flattenCourseLectures(course);
    const completedCount = lectures.filter((lecture) => lecture?.progress?.completed).length;
    const startedCount = lectures.filter(
      (lecture) => (lecture?.progress?.last_position_seconds || 0) > 0 && !lecture?.progress?.completed
    ).length;
    return {
      total: lectures.length,
      completedCount,
      startedCount,
    };
  }, [course]);

  const activeProgress = selectedLecture?.progress || null;
  const selectedResources = selectedLecture?.resources || [];

  const syncLectureProgress = async ({
    lectureId,
    positionSeconds,
    durationSeconds,
    completed = false,
    force = false,
  }) => {
    if (!lectureId) return null;

    const normalizedPosition = Math.max(0, Math.floor(Number(positionSeconds) || 0));
    const normalizedDuration = Math.max(0, Math.floor(Number(durationSeconds) || 0));
    const progressSnapshot = {
      lectureId,
      positionSeconds: normalizedPosition,
      durationSeconds: normalizedDuration,
      completed,
      force,
    };
    const retryDelayMs = progressRetryAtRef.current - Date.now();
    if (retryDelayMs > 0) {
      deferredProgressRef.current = progressSnapshot;
      if (!progressRetryTimerRef.current) {
        scheduleDeferredProgressRetry(retryDelayMs);
      }
      return null;
    }

    const previousSync = lastSyncedRef.current;
    const shouldSkip =
      !force &&
      previousSync.lectureId === lectureId &&
      previousSync.completed === completed &&
      Math.abs(previousSync.positionSeconds - normalizedPosition) < PROGRESS_SYNC_INTERVAL_SECONDS;

    if (shouldSkip) return null;
    if (progressInFlightRef.current) {
      pendingProgressRef.current = progressSnapshot;
      return null;
    }

    const showSavingIndicator = force;
    progressInFlightRef.current = true;
    if (showSavingIndicator) {
      setProgressState((current) => ({ ...current, saving: true, error: "" }));
    } else if (progressState.error) {
      setProgressState((current) => ({ ...current, error: "" }));
    }
    try {
      const response = await updateLectureProgress(lectureId, {
        position_seconds: normalizedPosition,
        duration_seconds: normalizedDuration || undefined,
        completed,
      });
      const snapshot = apiData(response);
      clearProgressRetryTimer();
      deferredProgressRef.current = null;
      progressRetryAtRef.current = 0;
      lastSyncedRef.current = {
        lectureId,
        positionSeconds: normalizedPosition,
        durationSeconds: normalizedDuration,
        completed: Boolean(snapshot?.completed),
      };
      setCourse((current) => applyLectureProgressSnapshot(current, lectureId, snapshot));
      setSelectedLecture((current) =>
        current?.id === lectureId ? { ...current, progress: snapshot } : current
      );
      if (showSavingIndicator || progressState.error) {
        setProgressState({
          saving: false,
          error: "",
          savedAt: new Date().toISOString(),
        });
      }
      return snapshot;
    } catch (err) {
      if (err?.response?.status === 429) {
        const throttleDelayMs = resolveRetryAfterMs(err);
        progressRetryAtRef.current = Date.now() + throttleDelayMs;
        deferredProgressRef.current = progressSnapshot;
        scheduleDeferredProgressRetry(throttleDelayMs);
        setProgressState({
          saving: false,
          error: `Progress saving paused after rate limiting. Retrying in ${Math.ceil(
            throttleDelayMs / 1000
          )}s.`,
          savedAt: "",
        });
        return null;
      }

      setProgressState({
        saving: false,
        error: apiMessage(err, "Unable to save lesson progress."),
        savedAt: "",
      });
      return null;
    } finally {
      progressInFlightRef.current = false;
      const pendingSnapshot = pendingProgressRef.current;
      pendingProgressRef.current = null;
      if (
        pendingSnapshot &&
        (
          pendingSnapshot.completed !== completed
          || pendingSnapshot.positionSeconds !== normalizedPosition
          || pendingSnapshot.lectureId !== lectureId
        )
      ) {
        void syncLectureProgress(pendingSnapshot);
      }
    }
  };

  const persistCurrentProgress = async ({ force = false, completed = false } = {}) => {
    const videoElement = videoRef.current;
    if (!videoElement || !selectedLecture?.id || !videoUrl) return null;
    if (!force && activeProgress?.completed) return null;
    return syncLectureProgress({
      lectureId: selectedLecture.id,
      positionSeconds: videoElement.currentTime || 0,
      durationSeconds:
        videoElement.duration || activeProgress?.duration_seconds || selectedLecture.stream_duration_seconds || 0,
      completed,
      force,
    });
  };

  const loadVideoUrl = async (lectureId, isRetry = false) => {
    try {
      const response = await getLectureVideoUrl(lectureId);
      const data = apiData(response);
      setVideoUrl(data?.signed_url || "");
      setPlaybackType(data?.playback_type || "file");
      if (!isRetry) setRetried(false);
      setError("");
    } catch (err) {
      setError(apiMessage(err, "Failed to load lecture video."));
      setVideoUrl("");
    }
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await getCourse(courseId);
        const data = apiData(response);
        if (!active) return;
        setCourse(data);
        setSelectedLecture(pickInitialLecture(data));
      } catch (err) {
        if (active) setError(apiMessage(err, "Failed to load course player."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [courseId]);

  useEffect(() => () => clearProgressRetryTimer(), []);

  useEffect(() => {
    if (!selectedLecture?.id) return;
    resumeAppliedRef.current = false;
    void loadVideoUrl(selectedLecture.id);
  }, [selectedLecture?.id]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoUrl) return undefined;

    let hls;
    if (playbackType === "hls") {
      if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
        videoElement.src = videoUrl;
      } else if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          backBufferLength: 30,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          maxBufferHole: 0.5,
          capLevelToPlayerSize: true,
        });
        hls.loadSource(videoUrl);
        hls.attachMedia(videoElement);
      } else {
        setError("This browser does not support HLS playback.");
      }
    } else {
      videoElement.src = videoUrl;
    }

    return () => {
      if (hls) hls.destroy();
    };
  }, [videoUrl, playbackType]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !selectedLecture?.id || !videoUrl) return undefined;

    const resumePosition = Math.max(0, Number(selectedLecture?.progress?.resume_position_seconds) || 0);

    const handleLoadedMetadata = () => {
      if (resumeAppliedRef.current) return;
      resumeAppliedRef.current = true;
      const safeDuration =
        videoElement.duration || selectedLecture?.progress?.duration_seconds || selectedLecture.stream_duration_seconds;
      if (
        resumePosition > 0 &&
        !selectedLecture?.progress?.completed &&
        (!safeDuration || resumePosition < Math.max(0, safeDuration - 8))
      ) {
        videoElement.currentTime = resumePosition;
      }
    };

    const handleTimeUpdate = () => {
      void persistCurrentProgress({ force: false, completed: false });
    };

    const handlePause = () => {
      void persistCurrentProgress({ force: true, completed: false });
    };

    const handleEnded = () => {
      void persistCurrentProgress({ force: true, completed: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        void persistCurrentProgress({ force: true, completed: false });
      }
    };

    const handleBeforeUnload = () => {
      void persistCurrentProgress({ force: true, completed: false });
    };

    videoElement.addEventListener("loadedmetadata", handleLoadedMetadata);
    videoElement.addEventListener("timeupdate", handleTimeUpdate);
    videoElement.addEventListener("pause", handlePause);
    videoElement.addEventListener("ended", handleEnded);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      videoElement.removeEventListener("loadedmetadata", handleLoadedMetadata);
      videoElement.removeEventListener("timeupdate", handleTimeUpdate);
      videoElement.removeEventListener("pause", handlePause);
      videoElement.removeEventListener("ended", handleEnded);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      void persistCurrentProgress({ force: true, completed: false });
    };
  }, [
    selectedLecture?.id,
    selectedLecture?.stream_duration_seconds,
    videoUrl,
  ]);

  const handleVideoError = async () => {
    if (!selectedLecture?.id || retried) return;
    setRetried(true);
    await loadVideoUrl(selectedLecture.id, true);
  };

  const handleSelectLecture = (lecture, sectionTitle) => {
    void persistCurrentProgress({ force: true, completed: false });
    setSelectedLecture({
      ...lecture,
      section_title: sectionTitle,
    });
  };

  if (loading) {
    return <PageShell title="Course Player">Loading...</PageShell>;
  }

  return (
    <PageShell
      title={course?.title || "Course"}
      subtitle={`${course?.sections?.length || 0} sections - ${lectureCount} lectures`}
    >
      <div className="grid gap-5 xl:grid-cols-[340px_1fr]">
        <aside className="overflow-hidden rounded-[28px] border border-black panel-gradient shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
          <div className="border-b border-[#222222] bg-[radial-gradient(circle_at_top,rgba(192,192,192,0.12),transparent_48%)] p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#949494]">
              Your Progress
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
              <div className="rounded-2xl border border-black panel-gradient p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#949494]">Completed</div>
                <div className="mt-1 text-2xl font-semibold text-white">{lectureStats.completedCount}</div>
              </div>
              <div className="rounded-2xl border border-black panel-gradient p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#949494]">In Progress</div>
                <div className="mt-1 text-2xl font-semibold text-white">{lectureStats.startedCount}</div>
              </div>
              <div className="rounded-2xl border border-black panel-gradient p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-[#949494]">Lessons</div>
                <div className="mt-1 text-2xl font-semibold text-white">{lectureStats.total}</div>
              </div>
            </div>
          </div>

          <div className="max-h-[72vh] space-y-4 overflow-auto p-4">
            <div className="overflow-hidden rounded-[24px] border border-[#3B3B3B] bg-[#0C0C0C] p-3 shadow-[0_14px_36px_rgba(0,0,0,0.24)]">
              <div className="flex gap-3">
                {course?.thumbnail ? (
                  <img
                    src={course.thumbnail}
                    alt={course?.title || "Course cover"}
                    className="h-20 w-28 shrink-0 rounded-2xl border border-[#2F2F2F] object-cover"
                  />
                ) : (
                  <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-2xl border border-[#2F2F2F] bg-[linear-gradient(135deg,#1B1B1B,#080808)] text-[10px] font-semibold uppercase tracking-[0.16em] text-[#BDBDBD]">
                    Course
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                    Now Watching
                  </div>
                  <div className="mt-1 line-clamp-2 text-sm font-semibold text-white">
                    {selectedLecture?.title || "Select a lecture to begin"}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-[#A7A7B7]">
                    {selectedLecture?.section_title
                      ? `${selectedLecture.section_title} | ${formatSeconds(
                          selectedLecture.stream_duration_seconds || activeProgress?.duration_seconds || 0
                        )}`
                      : `${course?.sections?.length || 0} modules | ${lectureCount} lessons`}
                  </div>
                </div>
              </div>
            </div>

            {(course?.sections || []).map((section, sectionIndex) => (
              <div key={section.id} className="overflow-hidden rounded-[24px] border border-[#3B3B3B] bg-[#101010] shadow-[0_14px_36px_rgba(0,0,0,0.2)]">
                <div className="flex items-center justify-between gap-3 border-b border-[#303030] bg-[#171717] px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8F8F8F]">
                      Module {sectionIndex + 1}
                    </div>
                    <h2 className="mt-1 truncate text-sm font-semibold text-white">{section.title}</h2>
                  </div>
                  <span className="shrink-0 rounded-full border border-[#3A3A3A] bg-[#0A0A0A] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#BBBBBB]">
                    {(section.lectures || []).length} lessons
                  </span>
                </div>
                <div className="divide-y divide-[#252525]">
                  {(section.lectures || []).map((lecture) => {
                    const isActive = selectedLecture?.id === lecture.id;
                    const lectureProgress = lecture.progress;
                    const percentComplete = lectureProgress?.percent_complete || 0;
                    return (
                      <button
                        key={lecture.id}
                        type="button"
                        onClick={() => handleSelectLecture(lecture, section.title)}
                        className={`flex w-full items-start gap-3 px-3 py-3 text-left transition ${
                          isActive
                            ? "bg-[#DFDFDF] text-[#1D1D1D]"
                            : "bg-[#0C0C0C] text-[#D9D9D9] hover:bg-[#151515]"
                        }`}
                      >
                        {course?.thumbnail ? (
                          <img
                            src={course.thumbnail}
                            alt=""
                            className={`h-14 w-20 shrink-0 rounded-xl object-cover ${
                              isActive ? "border border-[#BDBDBD]" : "border border-[#2A2A2A]"
                            }`}
                          />
                        ) : (
                          <div
                            className={`flex h-14 w-20 shrink-0 items-center justify-center rounded-xl border text-[10px] font-semibold uppercase tracking-[0.14em] ${
                              isActive
                                ? "border-[#BDBDBD] bg-white/50 text-[#1D1D1D]"
                                : "border-[#2A2A2A] bg-[#171717] text-[#A1A1A1]"
                            }`}
                          >
                            Video
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="line-clamp-2 text-sm font-semibold">{lecture.title}</div>
                              <div
                                className={`mt-1 text-xs ${
                                  isActive ? "text-[#3A3A3A]" : "text-[#949494]"
                                }`}
                              >
                                {lectureProgress?.completed
                                  ? "Completed"
                                  : percentComplete > 0
                                    ? `Resume from ${formatSeconds(
                                        lectureProgress.resume_position_seconds || lectureProgress.last_position_seconds
                                      )}`
                                    : lecture.is_preview
                                      ? "Preview lesson"
                                      : "Not started"}
                              </div>
                            </div>
                            <span
                              className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                                lectureProgress?.completed
                                  ? "border border-zinc-300/80 bg-zinc-100 text-zinc-900"
                                  : percentComplete > 0
                                    ? "border border-[#DADADA]/20 bg-white/10 text-[#E7E7E7]"
                                    : "border border-[#2A2A2A] bg-[#171717] text-[#A1A1A1]"
                              }`}
                            >
                              {lectureProgress?.completed ? "Done" : `${percentComplete}%`}
                            </span>
                          </div>
                          <div className={`mt-3 h-1.5 overflow-hidden rounded-full ${isActive ? "bg-black/20" : "bg-black/35"}`}>
                            <div
                              className={`h-full rounded-full ${
                                lectureProgress?.completed ? "bg-zinc-300" : "bg-[#C0C0C0]"
                              }`}
                              style={{ width: `${Math.max(0, Math.min(100, percentComplete))}%` }}
                            />
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {!(section.lectures || []).length ? (
                    <div className="px-4 py-5 text-sm text-[#949494]">
                      No videos have been added to this module yet.
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <section className="overflow-hidden rounded-[28px] border border-black panel-gradient shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
          <div className="border-b border-[#222222] bg-[radial-gradient(circle_at_top_right,rgba(192,192,192,0.15),transparent_36%)] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#949494]">
                  Lesson Workspace
                </div>
                <h2 className="mt-2 text-2xl font-semibold text-white">
                  {selectedLecture?.title || "Select a lecture"}
                </h2>
                {selectedLecture?.section_title ? (
                  <p className="mt-1 text-sm text-[#BBBBBB]">{selectedLecture.section_title}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {activeProgress?.completed ? (
                  <span className="rounded-full border border-zinc-300/80 bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-900">
                    Completed
                  </span>
                ) : null}
                {activeProgress?.resume_position_seconds ? (
                  <span className="rounded-full border border-[#DADADA]/15 bg-white/5 px-3 py-1 text-xs font-semibold text-[#E0E0E0]">
                    Resume {formatSeconds(activeProgress.resume_position_seconds)}
                  </span>
                ) : null}
                {progressState.saving ? (
                  <span className="rounded-full border border-[#DADADA]/15 bg-white/5 px-3 py-1 text-xs font-semibold text-[#E0E0E0]">
                    Saving...
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
                videoSessionKey={videoUrl ? `${playbackType}:${videoUrl}` : ""}
              >
                {videoUrl ? (
                  <video
                    key={`${playbackType}:${videoUrl}`}
                    ref={videoRef}
                    disablePictureInPicture
                    disableRemotePlayback
                    preload="metadata"
                    playsInline
                    className="h-full w-full bg-black object-contain"
                    onDoubleClick={(event) => event.preventDefault()}
                    onError={handleVideoError}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-[#8F8F8F]">
                    Select a lecture to play.
                  </div>
                )}
              </ProtectedPlaybackSurface>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-2xl border border-black panel-gradient p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                  Lesson Notes
                </div>
                <p className="mt-3 text-sm leading-7 text-[#D7D7D7]">
                  {selectedLecture?.description || "Lecture description will appear here."}
                </p>
                {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
                {progressState.error ? (
                  <p className="mt-3 text-sm text-amber-300">{progressState.error}</p>
                ) : null}
              </div>

              <div className="space-y-4">
                <div className="rounded-2xl border border-black panel-gradient p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                    Progress Snapshot
                  </div>
                  <div className="mt-4 space-y-3">
                    <div className="rounded-2xl border border-black panel-gradient p-3">
                      <div className="text-[11px] uppercase tracking-[0.16em] text-[#949494]">Completion</div>
                      <div className="mt-1 text-2xl font-semibold text-white">
                        {activeProgress?.percent_complete || 0}%
                      </div>
                    </div>
                    <div className="rounded-2xl border border-black panel-gradient p-3">
                      <div className="text-[11px] uppercase tracking-[0.16em] text-[#949494]">Last Position</div>
                      <div className="mt-1 text-lg font-semibold text-white">
                        {formatSeconds(activeProgress?.last_position_seconds || 0)}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-black panel-gradient p-3">
                      <div className="text-[11px] uppercase tracking-[0.16em] text-[#949494]">Duration</div>
                      <div className="mt-1 text-lg font-semibold text-white">
                        {formatSeconds(
                          activeProgress?.duration_seconds || selectedLecture?.stream_duration_seconds || 0
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-black panel-gradient p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                    Lesson Resources
                  </div>
                  {selectedResources.length ? (
                    <div className="mt-4 space-y-3">
                      {selectedResources.map((resource) => (
                        <a
                          key={resource.id}
                          href={resource.download_url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-start justify-between gap-3 rounded-2xl border border-black panel-gradient px-3 py-3 transition hover:border-[#3B3B3B] hover:bg-[#141414]"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-white">
                              {resource.title}
                            </div>
                            <div className="mt-1 text-xs text-[#949494]">
                              {resource.filename}
                              {resource.file_size ? ` | ${formatFileSize(resource.file_size)}` : ""}
                            </div>
                          </div>
                          <span className="shrink-0 rounded-full border border-black bg-[#171717] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#BBBBBB]">
                            {(resource.file_extension || "file").toUpperCase()}
                          </span>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm leading-6 text-[#949494]">
                      No resources were uploaded for this lecture.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

