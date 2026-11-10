import Hls from "hls.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLectureVideoUrl, updateLectureProgress } from "../../api/courses";
import { apiData, apiMessage } from "../../utils/api";
import {
  formatHlsQualityLabel,
  normalizeHlsQualityOptions,
  pickVisibleQualityOptions,
} from "./hlsQuality";
import { createProgressSyncer } from "./progressSync";

/** Seconds before the end where a saved position is ignored (restart instead). */
const RESUME_END_MARGIN_SECONDS = 8;

function playbackErrorState(error) {
  const status = Number(error?.response?.status) || 0;
  if (status === 403) return { status: "forbidden", message: apiMessage(error, "Enrollment required.") };
  if (status === 401) return { status: "unauthenticated", message: "Sign in to watch this lesson." };
  if (status === 404) return { status: "error", message: "This lesson isn't available right now." };
  return { status: "error", message: apiMessage(error, "Failed to load lecture video.") };
}

/**
 * Secure lecture playback: signed URL, HLS (hls.js or native), quality
 * levels, resume position, progress syncing and completion.
 *
 * @param {object|null} lecture   current lecture (with `progress`)
 * @param {object} options
 * @param {boolean} options.locked            skip loading (locked lesson)
 * @param {(lectureId, snapshot) => void} options.onProgressSaved
 * @param {() => void} options.onEnded       called after the video ends
 */
export function useLecturePlayback(lecture, { locked = false, onProgressSaved, onEnded } = {}) {
  const lectureId = lecture?.id ?? null;
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const resumeAppliedRef = useRef(false);
  const retriedRef = useRef(false);
  const autoStartRef = useRef(false);
  const lectureRef = useRef(lecture);
  lectureRef.current = lecture;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onProgressSavedRef = useRef(onProgressSaved);
  onProgressSavedRef.current = onProgressSaved;

  const [source, setSource] = useState({ url: "", type: "file", lectureId: null });
  const [loadState, setLoadState] = useState({ status: "idle", message: "" });
  const [qualityOptions, setQualityOptions] = useState([]);
  const [selectedQuality, setSelectedQuality] = useState("");
  const [activeQualityLabel, setActiveQualityLabel] = useState("");
  const [qualityControlMessage, setQualityControlMessage] = useState("");
  const [progressStatus, setProgressStatus] = useState({ state: "idle", message: "" });

  const [syncer] = useState(() =>
    createProgressSyncer({
      save: async (id, payload) => apiData(await updateLectureProgress(id, payload)),
      onSaved: (id, snapshot) => onProgressSavedRef.current?.(id, snapshot),
      onStatus: (status) => setProgressStatus({ state: status.state, message: status.message || "" }),
      describeError: (error) => apiMessage(error, "Unable to save lesson progress."),
    })
  );

  useEffect(() => () => syncer.dispose(), [syncer]);

  /**
   * Saves the position of `videoElement` for `lecture` (defaults: the
   * current ones). Effects pass the element and lecture they captured, so a
   * save during a lesson switch never lands on the next lesson.
   */
  const persistProgress = useCallback(
    ({ force = false, completed } = {}, target = {}) => {
      const videoElement = target.videoElement || videoRef.current;
      const captured = target.lecture || lectureRef.current;
      const latest = lectureRef.current;
      const current = latest?.id === captured?.id ? latest : captured;
      if (!videoElement || !current?.id) return Promise.resolve(null);
      if (!force && current.progress?.completed) return Promise.resolve(null);
      return syncer.sync({
        lectureId: current.id,
        positionSeconds: videoElement.currentTime || 0,
        durationSeconds:
          videoElement.duration || current.progress?.duration_seconds || current.stream_duration_seconds || 0,
        completed,
        force,
      });
    },
    [syncer]
  );

  /** "Mark complete" / "Mark incomplete". Works with or without a playing video. */
  const setCompleted = useCallback(
    (completed) => {
      const current = lectureRef.current;
      if (!current?.id) return Promise.resolve(null);
      const videoElement = videoRef.current;
      const duration =
        (videoElement && Number.isFinite(videoElement.duration) ? videoElement.duration : 0) ||
        current.progress?.duration_seconds ||
        current.stream_duration_seconds ||
        0;
      const position = videoElement?.currentTime || current.progress?.last_position_seconds || 0;
      return syncer.sync({
        lectureId: current.id,
        positionSeconds: position,
        durationSeconds: duration,
        completed: Boolean(completed),
        force: true,
      });
    },
    [syncer]
  );

  const loadVideoUrl = useCallback(async (id, { isRetry = false } = {}) => {
    if (!isRetry) setLoadState({ status: "loading", message: "" });
    try {
      const data = apiData(await getLectureVideoUrl(id));
      if (lectureRef.current?.id !== id) return;
      const url = data?.signed_url || data?.playback_url || "";
      setSource({ url, type: data?.playback_type || "file", lectureId: id });
      if (!isRetry) retriedRef.current = false;
      setLoadState(url ? { status: "ready", message: "" } : { status: "error", message: "This lesson has no video yet." });
    } catch (error) {
      if (lectureRef.current?.id !== id) return;
      setSource({ url: "", type: "file", lectureId: null });
      setLoadState(playbackErrorState(error));
    }
  }, []);

  // New lecture: reset quality UI and fetch a fresh signed URL.
  useEffect(() => {
    setSelectedQuality("");
    setQualityOptions([]);
    setActiveQualityLabel("");
    setQualityControlMessage("");
    setSource({ url: "", type: "file", lectureId: null });
    resumeAppliedRef.current = false;
    if (!lectureId) {
      setLoadState({ status: "idle", message: "" });
      return;
    }
    if (locked) {
      setLoadState({ status: "locked", message: "" });
      return;
    }
    void loadVideoUrl(lectureId);
  }, [lectureId, locked, loadVideoUrl]);

  // Attach the stream (hls.js, native HLS on Safari/iOS, or a plain file).
  useEffect(() => {
    const videoElement = videoRef.current;
    const { url: videoUrl, type: playbackType } = source;
    if (!videoElement || !videoUrl) return undefined;

    let isActive = true;
    let hls;
    hlsRef.current = null;
    if (playbackType === "hls") {
      if (Hls.isSupported()) {
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
            nextOptions.length > 1
              ? "Choose the lecture quality from settings."
              : "This lecture currently exposes a single playback quality."
          );
          if (nextOptions.length) {
            setSelectedQuality(nextOptions[0].value);
            setActiveQualityLabel(nextOptions[0].label);
          } else {
            setActiveQualityLabel("");
          }
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          if (!isActive) return;
          const currentLevel = hls.levels?.[data.level];
          if (currentLevel) setActiveQualityLabel(formatHlsQualityLabel(currentLevel));
        });
        hls.loadSource(videoUrl);
        hls.attachMedia(videoElement);
      } else if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
        setQualityOptions([]);
        setActiveQualityLabel("Browser");
        setQualityControlMessage("Quality selection is handled automatically by this browser.");
        videoElement.src = videoUrl;
      } else {
        setQualityOptions([]);
        setActiveQualityLabel("");
        setQualityControlMessage("");
        setLoadState({ status: "error", message: "This browser does not support HLS playback." });
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
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }, [source]);

  // Apply the chosen quality level.
  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls || source.type !== "hls" || !qualityOptions.length) return;
    if (!selectedQuality) {
      setSelectedQuality(qualityOptions[0].value);
      return;
    }
    const nextQuality = qualityOptions.find((option) => option.value === selectedQuality);
    if (!nextQuality) return;
    hls.loadLevel = nextQuality.index;
    hls.nextLevel = nextQuality.index;
    hls.currentLevel = nextQuality.index;
    hls.nextLoadLevel = nextQuality.index;
    setActiveQualityLabel(nextQuality.label);
  }, [source.type, qualityOptions, selectedQuality]);

  // Resume position, periodic/forced progress saves, completion on end.
  useEffect(() => {
    const videoElement = videoRef.current;
    const current = lectureRef.current;
    // Bound to the source, not the lecture: listeners always belong to the
    // lecture whose signed URL is loaded in this <video>.
    if (!videoElement || !current?.id || !source.url || current.id !== source.lectureId) return undefined;

    const resumePosition = Math.max(0, Number(current.progress?.resume_position_seconds) || 0);

    const handleLoadedMetadata = () => {
      if (resumeAppliedRef.current) return;
      resumeAppliedRef.current = true;
      const safeDuration =
        videoElement.duration || current.progress?.duration_seconds || current.stream_duration_seconds;
      if (
        resumePosition > 0 &&
        !current.progress?.completed &&
        (!safeDuration || resumePosition < Math.max(0, safeDuration - RESUME_END_MARGIN_SECONDS))
      ) {
        videoElement.currentTime = resumePosition;
      }
      if (autoStartRef.current) {
        autoStartRef.current = false;
        const attempt = videoElement.play?.();
        if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
      }
    };
    const target = { videoElement, lecture: current };
    const handleTimeUpdate = () => void persistProgress({ force: false }, target);
    const handlePause = () => {
      if (!videoElement.ended) void persistProgress({ force: true }, target);
    };
    const handleEnded = () => {
      void persistProgress({ force: true, completed: true }, target);
      onEndedRef.current?.();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") void persistProgress({ force: true }, target);
    };
    const handleBeforeUnload = () => void persistProgress({ force: true }, target);

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
      // Save where the learner stopped when switching lessons or leaving.
      if (!videoElement.ended) void persistProgress({ force: true }, target);
    };
  }, [source, persistProgress]);

  // The signed URL can expire mid-session: fetch a new one once per lecture.
  const handleVideoError = useCallback(async () => {
    const current = lectureRef.current;
    if (!current?.id || retriedRef.current) return;
    retriedRef.current = true;
    // Resume from the last saved position on the refreshed URL.
    resumeAppliedRef.current = false;
    await loadVideoUrl(current.id, { isRetry: true });
  }, [loadVideoUrl]);

  const retry = useCallback(() => {
    const current = lectureRef.current;
    if (!current?.id) return;
    retriedRef.current = false;
    void loadVideoUrl(current.id);
  }, [loadVideoUrl]);

  /** Start playback automatically once the next lecture's metadata loads. */
  const requestAutoStart = useCallback(() => {
    autoStartRef.current = true;
  }, []);

  const visibleQualityOptions = useMemo(() => pickVisibleQualityOptions(qualityOptions), [qualityOptions]);

  return {
    videoRef,
    videoUrl: source.url,
    playbackType: source.type,
    videoSessionKey: source.url ? `${source.type}:${source.url}` : "",
    status: loadState.status,
    errorMessage: loadState.message,
    qualityOptions: visibleQualityOptions,
    selectedQuality,
    setSelectedQuality,
    activeQualityLabel,
    qualityControlMessage,
    progressStatus,
    persistProgress,
    setCompleted,
    handleVideoError,
    retry,
    requestAutoStart,
  };
}
