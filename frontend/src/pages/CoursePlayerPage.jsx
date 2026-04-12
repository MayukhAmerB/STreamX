import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { useParams } from "react-router-dom";
import {
  createLectureQuestion,
  getCourse,
  getLectureNote,
  getLectureQuestions,
  getLectureVideoUrl,
  updateLectureNote,
  updateLectureProgress,
} from "../api/courses";
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
    (section.lectures || []).map((lecture) => withSectionMetadata(lecture, section))
  );
}

function withSectionMetadata(lecture, section = {}) {
  return {
    ...lecture,
    section_title: section.title || lecture?.section_title || "",
    section_description: section.description || lecture?.section_description || "",
  };
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

function normalizeDisplayText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function formatDateTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatHlsQualityLabel(level) {
  const height = Math.max(0, Number(level?.height) || 0);
  if (height > 0) return `${height}p`;
  const width = Math.max(0, Number(level?.width) || 0);
  if (width > 0) return `${width}w`;
  return "Auto";
}

function normalizeHlsQualityOptions(levels) {
  const seen = new Set();
  return (Array.isArray(levels) ? levels : [])
    .map((level, index) => ({
      index,
      height: Math.max(0, Number(level?.height) || 0),
      bitrate: Math.max(0, Number(level?.bitrate) || 0),
      label: formatHlsQualityLabel(level),
      value: Number(level?.height) > 0 ? String(level.height) : `level-${index}`,
    }))
    .sort((left, right) => right.height - left.height || right.bitrate - left.bitrate || right.index - left.index)
    .filter((option) => {
      const dedupeKey = option.height > 0 ? `height-${option.height}` : option.value;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });
}

export default function CoursePlayerPage() {
  const { courseId } = useParams();
  const [course, setCourse] = useState(null);
  const [selectedLecture, setSelectedLecture] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [playbackType, setPlaybackType] = useState("file");
  const [qualityOptions, setQualityOptions] = useState([]);
  const [selectedQuality, setSelectedQuality] = useState("");
  const [activeQualityLabel, setActiveQualityLabel] = useState("");
  const [qualityControlMessage, setQualityControlMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retried, setRetried] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [progressState, setProgressState] = useState({ saving: false, error: "", savedAt: "" });
  const [noteDraft, setNoteDraft] = useState("");
  const [noteState, setNoteState] = useState({ loading: false, saving: false, error: "", savedAt: "" });
  const [questionDraft, setQuestionDraft] = useState("");
  const [questions, setQuestions] = useState([]);
  const [questionState, setQuestionState] = useState({
    loading: false,
    submitting: false,
    error: "",
    success: "",
  });
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const selectedLectureIdRef = useRef(null);
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

  const activeLectureDetails = useMemo(() => {
    if (!selectedLecture?.id) return selectedLecture;
    return flattenCourseLectures(course).find((lecture) => lecture.id === selectedLecture.id) || selectedLecture;
  }, [course, selectedLecture]);

  const activeProgress = activeLectureDetails?.progress || selectedLecture?.progress || null;
  const selectedResources = activeLectureDetails?.resources || selectedLecture?.resources || [];
  const courseThumbnail = !thumbnailFailed && course?.thumbnail ? course.thumbnail : "";
  const lectureDescription = useMemo(
    () =>
      normalizeDisplayText(activeLectureDetails?.description)
      || normalizeDisplayText(activeLectureDetails?.section_description)
      || normalizeDisplayText(course?.description),
    [activeLectureDetails?.description, activeLectureDetails?.section_description, course?.description]
  );
  const visibleQualityOptions = useMemo(() => {
    const hdOptions = qualityOptions.filter((option) => option.height === 1080 || option.height === 720);
    return hdOptions.length ? hdOptions : qualityOptions;
  }, [qualityOptions]);

  useEffect(() => {
    setThumbnailFailed(false);
  }, [course?.thumbnail]);

  useEffect(() => {
    selectedLectureIdRef.current = selectedLecture?.id || null;
  }, [selectedLecture?.id]);

  useEffect(() => {
    setSelectedQuality("");
    setQualityOptions([]);
    setActiveQualityLabel("");
    setQualityControlMessage("");
  }, [selectedLecture?.id]);

  useEffect(() => {
    const lectureId = selectedLecture?.id;
    setQuestionDraft("");

    if (!lectureId) {
      setNoteDraft("");
      setQuestions([]);
      setNoteState({ loading: false, saving: false, error: "", savedAt: "" });
      setQuestionState({ loading: false, submitting: false, error: "", success: "" });
      return undefined;
    }

    let cancelled = false;
    setNoteState({ loading: true, saving: false, error: "", savedAt: "" });
    setQuestionState({ loading: true, submitting: false, error: "", success: "" });

    getLectureNote(lectureId)
      .then((response) => {
        if (cancelled) return;
        const note = apiData(response) || {};
        setNoteDraft(note.content || "");
        setNoteState({
          loading: false,
          saving: false,
          error: "",
          savedAt: note.updated_at ? formatDateTime(note.updated_at) : "",
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setNoteDraft("");
        setNoteState({
          loading: false,
          saving: false,
          error: apiMessage(err, "Unable to load your lecture notes."),
          savedAt: "",
        });
      });

    getLectureQuestions(lectureId)
      .then((response) => {
        if (cancelled) return;
        setQuestions(apiData(response) || []);
        setQuestionState({ loading: false, submitting: false, error: "", success: "" });
      })
      .catch((err) => {
        if (cancelled) return;
        setQuestions([]);
        setQuestionState({
          loading: false,
          submitting: false,
          error: apiMessage(err, "Unable to load your lecture questions."),
          success: "",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [selectedLecture?.id]);

  const handleSaveNote = async () => {
    if (!selectedLecture?.id) return;
    const lectureId = selectedLecture.id;
    setNoteState((current) => ({ ...current, saving: true, error: "" }));
    try {
      const response = await updateLectureNote(lectureId, { content: noteDraft });
      if (selectedLectureIdRef.current !== lectureId) return;
      const note = apiData(response) || {};
      setNoteDraft(note.content || "");
      setNoteState({
        loading: false,
        saving: false,
        error: "",
        savedAt: note.updated_at ? formatDateTime(note.updated_at) : "just now",
      });
    } catch (err) {
      if (selectedLectureIdRef.current !== lectureId) return;
      setNoteState((current) => ({
        ...current,
        saving: false,
        error: apiMessage(err, "Unable to save your lecture notes."),
      }));
    }
  };

  const handleSubmitQuestion = async (event) => {
    event.preventDefault();
    if (!selectedLecture?.id || questionState.submitting) return;
    const lectureId = selectedLecture.id;

    const question = questionDraft.trim();
    if (!question) {
      setQuestionState((current) => ({ ...current, error: "Type your question before submitting.", success: "" }));
      return;
    }

    setQuestionState((current) => ({ ...current, submitting: true, error: "", success: "" }));
    try {
      const response = await createLectureQuestion(lectureId, { question });
      if (selectedLectureIdRef.current !== lectureId) return;
      const createdQuestion = apiData(response);
      setQuestions((current) => (createdQuestion ? [createdQuestion, ...current] : current));
      setQuestionDraft("");
      setQuestionState({
        loading: false,
        submitting: false,
        error: "",
        success: "Question submitted. Our team answers lecture questions every Friday.",
      });
    } catch (err) {
      if (selectedLectureIdRef.current !== lectureId) return;
      setQuestionState((current) => ({
        ...current,
        submitting: false,
        error: apiMessage(err, "Unable to submit your question."),
        success: "",
      }));
    }
  };

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

    let isActive = true;
    let hls;
    hlsRef.current = null;
    if (playbackType === "hls") {
      if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
        setQualityOptions([]);
        setActiveQualityLabel("Browser");
        setQualityControlMessage("Quality selection is handled automatically by this browser.");
        videoElement.src = videoUrl;
      } else if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          backBufferLength: 30,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          maxBufferHole: 0.5,
          capLevelToPlayerSize: false,
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          if (!isActive) return;
          const nextOptions = normalizeHlsQualityOptions(data?.levels || hls.levels);
          setQualityOptions(nextOptions);
          setQualityControlMessage(
            nextOptions.length > 1 ? "Choose the lecture quality from settings." : "This lecture currently exposes a single playback quality."
          );
          if (nextOptions.length) {
            const preferredQuality = nextOptions[0];
            setSelectedQuality(preferredQuality.value);
            setActiveQualityLabel(preferredQuality.label);
          } else {
            setActiveQualityLabel("");
          }
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          if (!isActive) return;
          const currentLevel = hls.levels?.[data.level];
          if (currentLevel) {
            setActiveQualityLabel(formatHlsQualityLabel(currentLevel));
          }
        });
        hls.loadSource(videoUrl);
        hls.attachMedia(videoElement);
      } else {
        setQualityOptions([]);
        setActiveQualityLabel("");
        setQualityControlMessage("");
        setError("This browser does not support HLS playback.");
      }
    } else {
      setQualityOptions([]);
      setActiveQualityLabel("");
      setQualityControlMessage("");
      videoElement.src = videoUrl;
    }

    return () => {
      isActive = false;
      if (hls) hls.destroy();
      if (hlsRef.current === hls) {
        hlsRef.current = null;
      }
    };
  }, [videoUrl, playbackType]);

  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls || playbackType !== "hls" || !qualityOptions.length) return;

    if (!selectedQuality) {
      const defaultQuality = qualityOptions[0];
      if (defaultQuality) {
        setSelectedQuality(defaultQuality.value);
      }
      return;
    }

    const nextQuality = qualityOptions.find((option) => option.value === selectedQuality);
    if (!nextQuality) return;

    hls.loadLevel = nextQuality.index;
    hls.nextLevel = nextQuality.index;
    hls.currentLevel = nextQuality.index;
    hls.nextLoadLevel = nextQuality.index;
    setActiveQualityLabel(nextQuality.label);
  }, [playbackType, qualityOptions, selectedQuality]);

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

  const handleSelectLecture = (lecture, section) => {
    void persistCurrentProgress({ force: true, completed: false });
    setSelectedLecture(withSectionMetadata(lecture, section));
  };

  if (loading) {
    return <PageShell title="Course Player">Loading...</PageShell>;
  }

  return (
    <PageShell
      title={course?.title || "Course"}
      subtitle={`${course?.sections?.length || 0} sections - ${lectureCount} lectures`}
    >
      <div className="grid items-start gap-5 xl:grid-cols-[340px_1fr]">
        <aside className="self-start overflow-x-hidden rounded-[28px] border border-black panel-gradient shadow-[0_20px_60px_rgba(0,0,0,0.28)] xl:sticky xl:top-6 xl:max-h-[calc(100vh-3rem)] xl:overflow-y-auto">
          <div className="border-b border-[#303030] bg-[radial-gradient(circle_at_top,rgba(192,192,192,0.12),transparent_48%)] p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#949494]">
              Course Videos
            </div>
            <div className="mt-2 text-lg font-semibold text-white">
              All lessons
            </div>
            <div className="mt-1 text-xs leading-5 text-[#A7A7B7]">
              {course?.sections?.length || 0} modules | {lectureCount} lessons | {lectureStats.completedCount} completed
            </div>
          </div>

          <div className="space-y-4 p-4">
            <div className="overflow-hidden rounded-[24px] border border-[#3B3B3B] bg-[#0C0C0C] p-3 shadow-[0_14px_36px_rgba(0,0,0,0.24)]">
              <div className="flex gap-3">
                {courseThumbnail ? (
                  <img
                    src={courseThumbnail}
                    alt={course?.title || "Course cover"}
                    onError={() => setThumbnailFailed(true)}
                    className="h-20 w-28 shrink-0 rounded-2xl border border-[#2F2F2F] object-cover"
                  />
                ) : (
                  <div className="relative flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-[#2F2F2F] bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.18),transparent_34%),linear-gradient(135deg,#1F1F1F,#070707)]">
                    <div className="absolute inset-x-0 bottom-0 h-10 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.72))]" />
                    <div className="relative flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/12 text-xs text-white">
                      Play
                    </div>
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
                  {(section.lectures || []).map((lecture, lectureIndex) => {
                    const isActive = selectedLecture?.id === lecture.id;
                    const lectureProgress = lecture.progress;
                    const percentComplete = lectureProgress?.percent_complete || 0;
                    const lessonNumber = lecture.order || lectureIndex + 1;
                    return (
                      <button
                        key={lecture.id}
                        type="button"
                        onClick={() => handleSelectLecture(lecture, section)}
                        className={`flex w-full items-start gap-3 px-3 py-3 text-left transition ${
                          isActive
                            ? "bg-[#DFDFDF] text-[#1D1D1D]"
                            : "bg-[#0C0C0C] text-[#D9D9D9] hover:bg-[#151515]"
                        }`}
                      >
                        {courseThumbnail ? (
                          <img
                            src={courseThumbnail}
                            alt=""
                            onError={() => setThumbnailFailed(true)}
                            className={`h-14 w-20 shrink-0 rounded-xl object-cover ${
                              isActive ? "border border-[#BDBDBD]" : "border border-[#2A2A2A]"
                            }`}
                          />
                        ) : (
                          <div
                            className={`relative flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border ${
                              isActive
                                ? "border-[#BDBDBD] bg-[linear-gradient(135deg,#D8D8D8,#8C8C8C)]"
                                : "border-[#2A2A2A] bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.16),transparent_34%),linear-gradient(135deg,#1E1E1E,#070707)]"
                            }`}
                          >
                            <div className="absolute inset-x-0 bottom-0 h-8 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.72))]" />
                            <div className="absolute left-2 top-2 rounded-full border border-white/15 bg-black/40 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-[0.12em] text-white/80">
                              {lessonNumber}
                            </div>
                            <div
                              className={`relative flex h-6 w-6 items-center justify-center rounded-full border text-[9px] font-semibold ${
                                isActive
                                  ? "border-black/20 bg-black/18 text-black"
                                  : "border-white/20 bg-white/12 text-white"
                              }`}
                            >
                              Play
                            </div>
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
                qualityOptions={visibleQualityOptions}
                selectedQuality={selectedQuality}
                onQualityChange={setSelectedQuality}
                activeQualityLabel={activeQualityLabel}
                qualityControlMessage={qualityControlMessage}
                showQualityControl={playbackType === "hls" && Boolean(videoUrl)}
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

            <div className="mt-5 grid items-stretch gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="flex h-full flex-col gap-4">
                <div className="rounded-2xl border border-black panel-gradient p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                    Lecture Brief
                  </div>
                  {lectureDescription ? (
                    <p className="mt-3 whitespace-pre-line text-sm leading-7 text-[#D7D7D7]">
                      {lectureDescription}
                    </p>
                  ) : (
                    <p className="mt-3 text-sm leading-7 text-[#8F8F8F]">
                      Lecture description will appear here once it is added in the lecture details.
                    </p>
                  )}
                  {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
                  {progressState.error ? (
                    <p className="mt-3 text-sm text-amber-300">{progressState.error}</p>
                  ) : null}
                </div>

                <div className="flex flex-1 flex-col rounded-2xl border border-[#2D2D2D] bg-[linear-gradient(145deg,#101010,#050505)] p-4 shadow-[0_16px_44px_rgba(0,0,0,0.24)]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                        Your Private Lecture Notes
                      </div>
                      <p className="mt-2 text-sm leading-6 text-[#BDBDBD]">
                        Note important points for this lecture here. These notes are saved only for your account and this exact lecture.
                      </p>
                    </div>
                    {noteState.savedAt ? (
                      <span className="rounded-full border border-[#DADADA]/15 bg-white/5 px-3 py-1 text-[11px] font-semibold text-[#D7D7D7]">
                        Saved {noteState.savedAt}
                      </span>
                    ) : null}
                  </div>

                  <textarea
                    value={noteDraft}
                    onChange={(event) => {
                      setNoteDraft(event.target.value);
                      if (noteState.error) {
                        setNoteState((current) => ({ ...current, error: "" }));
                      }
                    }}
                    disabled={!selectedLecture?.id || noteState.loading}
                    rows={8}
                    maxLength={20000}
                    placeholder={
                      selectedLecture?.id
                        ? "Write key commands, reminders, timestamps, or important takeaways..."
                        : "Select a lecture to start writing notes."
                    }
                    className="mt-4 min-h-[220px] w-full flex-1 resize-y rounded-2xl border border-[#303030] bg-black/60 px-4 py-3 text-sm leading-7 text-white outline-none transition placeholder:text-[#6F6F6F] focus:border-[#D8D8D8]/70"
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-[#8F8F8F]">
                      {noteState.loading ? "Loading your saved notes..." : `${noteDraft.length}/20000 characters`}
                    </p>
                    <button
                      type="button"
                      onClick={handleSaveNote}
                      disabled={!selectedLecture?.id || noteState.loading || noteState.saving}
                      className="rounded-full border border-[#D8D8D8]/70 bg-[#F1F1F1] px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#101010] transition hover:bg-white disabled:cursor-not-allowed disabled:border-[#3A3A3A] disabled:bg-[#1E1E1E] disabled:text-[#7E7E7E]"
                    >
                      {noteState.saving ? "Saving..." : "Save Notes"}
                    </button>
                  </div>
                  {noteState.error ? <p className="mt-3 text-sm text-amber-300">{noteState.error}</p> : null}
                </div>
              </div>

              <div className="flex h-full flex-col gap-4">
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

                <div className="flex flex-1 flex-col rounded-2xl border border-[#2D2D2D] bg-[linear-gradient(145deg,#111111,#060606)] p-4 shadow-[0_16px_44px_rgba(0,0,0,0.22)]">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                    Ask a Question
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[#BDBDBD]">
                    Ask doubts from this lecture here. Questions are reviewed and answered every Friday.
                  </p>

                  <form className="mt-4 space-y-3" onSubmit={handleSubmitQuestion}>
                    <textarea
                      value={questionDraft}
                      onChange={(event) => {
                        setQuestionDraft(event.target.value);
                        if (questionState.error || questionState.success) {
                          setQuestionState((current) => ({ ...current, error: "", success: "" }));
                        }
                      }}
                      disabled={!selectedLecture?.id || questionState.submitting}
                      rows={5}
                      maxLength={3000}
                      placeholder={
                        selectedLecture?.id
                          ? "Write your question for the instructor..."
                          : "Select a lecture before asking a question."
                      }
                      className="min-h-[130px] w-full resize-y rounded-2xl border border-[#303030] bg-black/60 px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-[#6F6F6F] focus:border-[#D8D8D8]/70"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-xs text-[#8F8F8F]">{questionDraft.length}/3000 characters</p>
                      <button
                        type="submit"
                        disabled={!selectedLecture?.id || questionState.submitting}
                        className="rounded-full border border-[#D8D8D8]/70 bg-[#F1F1F1] px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#101010] transition hover:bg-white disabled:cursor-not-allowed disabled:border-[#3A3A3A] disabled:bg-[#1E1E1E] disabled:text-[#7E7E7E]"
                      >
                        {questionState.submitting ? "Submitting..." : "Submit Question"}
                      </button>
                    </div>
                  </form>

                  {questionState.error ? <p className="mt-3 text-sm text-amber-300">{questionState.error}</p> : null}
                  {questionState.success ? (
                    <p className="mt-3 text-sm text-emerald-300">{questionState.success}</p>
                  ) : null}

                  <div className="mt-5 flex-1 border-t border-[#242424] pt-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
                      Your Questions
                    </div>
                    {questions.length ? (
                      <div className="mt-3 space-y-3">
                        {questions.map((question) => (
                          <div
                            key={question.id}
                            className="rounded-2xl border border-[#2A2A2A] bg-black/45 px-3 py-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span
                                className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                                  question.status === "answered"
                                    ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-200"
                                    : question.status === "reviewed"
                                      ? "border-sky-300/35 bg-sky-300/10 text-sky-200"
                                      : "border-[#DADADA]/15 bg-white/5 text-[#D7D7D7]"
                                }`}
                              >
                                {question.status_label || question.status}
                              </span>
                              {question.created_at ? (
                                <span className="text-[11px] text-[#8F8F8F]">
                                  {formatDateTime(question.created_at)}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#E1E1E1]">
                              {question.question}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-3 text-sm leading-6 text-[#949494]">
                        {questionState.loading
                          ? "Loading your submitted questions..."
                          : "No questions submitted for this lecture yet."}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

