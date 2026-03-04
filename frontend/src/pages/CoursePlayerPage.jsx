import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { useParams } from "react-router-dom";
import { getCourse, getLectureVideoUrl } from "../api/courses";
import PageShell from "../components/PageShell";
import { apiData, apiMessage } from "../utils/api";

export default function CoursePlayerPage() {
  const { courseId } = useParams();
  const [course, setCourse] = useState(null);
  const [selectedLecture, setSelectedLecture] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [playbackType, setPlaybackType] = useState("file");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retried, setRetried] = useState(false);
  const videoRef = useRef(null);

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
        const firstLecture = data?.sections?.flatMap((section) =>
          (section.lectures || []).map((lecture) => ({ ...lecture, section_title: section.title }))
        )?.[0];
        setSelectedLecture(firstLecture || null);
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

  useEffect(() => {
    if (selectedLecture?.id) {
      loadVideoUrl(selectedLecture.id);
    }
  }, [selectedLecture?.id]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement || !videoUrl) return undefined;

    let hls;
    if (playbackType === "hls") {
      if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
        videoElement.src = videoUrl;
      } else if (Hls.isSupported()) {
        hls = new Hls();
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

  const lectureCount = useMemo(
    () => course?.sections?.reduce((acc, section) => acc + (section.lectures?.length || 0), 0) || 0,
    [course]
  );

  const handleVideoError = async () => {
    if (!selectedLecture?.id || retried) return;
    setRetried(true);
    await loadVideoUrl(selectedLecture.id, true);
  };

  if (loading) {
    return <PageShell title="Course Player">Loading...</PageShell>;
  }

  return (
    <PageShell
      title={course?.title || "Course"}
      subtitle={`${course?.sections?.length || 0} sections • ${lectureCount} lectures`}
    >
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <aside className="rounded-2xl border border-[#2a332d] bg-[#0f1310] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
          <div className="mb-3 text-sm font-medium text-[#d4dbc8]">Sections</div>
          <div className="max-h-[70vh] space-y-3 overflow-auto pr-1">
            {(course?.sections || []).map((section) => (
              <div key={section.id} className="rounded-xl border border-[#202820] bg-[#0a0d0a] p-3">
                <h3 className="text-sm font-semibold text-white">{section.title}</h3>
                <ul className="mt-2 space-y-1">
                  {(section.lectures || []).map((lecture) => {
                    const active = selectedLecture?.id === lecture.id;
                    return (
                      <li key={lecture.id}>
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedLecture({ ...lecture, section_title: section.title })
                          }
                          className={`w-full rounded-md px-2 py-2 text-left text-sm transition ${
                            active
                              ? "bg-gradient-to-r from-[#b9c7ab] to-[#7b8d72] text-white"
                              : "text-[#c9d1c3] hover:bg-[#161c16] hover:text-white"
                          }`}
                        >
                          {lecture.title}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        <div className="rounded-2xl border border-[#2a332d] bg-[#0f1310] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)]">
          <div className="aspect-video overflow-hidden rounded-xl border border-[#202820] bg-black">
            {videoUrl ? (
              <video
                key={`${playbackType}:${videoUrl}`}
                ref={videoRef}
                controls
                className="h-full w-full"
                onError={handleVideoError}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[#889486]">
                Select a lecture to play.
              </div>
            )}
          </div>
          <div className="mt-4">
            <h2 className="text-lg font-semibold text-white">
              {selectedLecture?.title || "No lecture selected"}
            </h2>
            {selectedLecture?.section_title ? (
              <p className="mt-1 text-sm text-[#b7c0b0]">{selectedLecture.section_title}</p>
            ) : null}
            <p className="mt-3 text-sm text-[#d4dbc8]">
              {selectedLecture?.description || "Lecture description will appear here."}
            </p>
            {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

