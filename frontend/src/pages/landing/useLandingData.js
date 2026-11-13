// Landing page data, shared by the current page (v2) and the rollback page
// (v1). The calls are unchanged (plan §7.3): GET /api/courses/?catalog=current
// (with the course-catalog-cache:v2 fallback), GET /api/live-classes/
// (refetched when auth changes) and, for signed-in visitors, the broadcast
// sessions poll (45 s visible / 180 s hidden, refreshed on focus, pageshow
// and online). Nothing is ever fabricated: an empty or failed feed is
// reported as such (plan §7.2 rules 5 and 7).
import { useCallback, useEffect, useState } from "react";

import { listCourses, listLiveClasses } from "../../api/courses";
import { listRealtimeSessions } from "../../api/realtime";
import { apiData } from "../../utils/api";
import { readCatalogTracks } from "../../utils/catalogTracks";
import {
  readCachedCourseCatalogEntry,
  selectPublicCatalogCourses,
  writeCachedCourseCatalog,
} from "../../utils/courseCatalog";
import { getCourseLaunchStatus } from "../../utils/courseStatus";

export const HERO_LIVE_BROADCAST_VISIBLE_POLL_MS = 45000;
export const HERO_LIVE_BROADCAST_HIDDEN_POLL_MS = 180000;

const LEVEL_ORDER = { beginner: 1, intermediate: 2, advanced: 3 };
const CATEGORY_ORDER = { osint: 1, web_pentesting: 2 };

export function sortCatalogCourses(courses) {
  return [...(Array.isArray(courses) ? courses : [])].sort((a, b) => {
    const aCategory = CATEGORY_ORDER[a?.category] ?? 99;
    const bCategory = CATEGORY_ORDER[b?.category] ?? 99;
    if (aCategory !== bCategory) return aCategory - bCategory;
    const aLevel = LEVEL_ORDER[a?.level] ?? 99;
    const bLevel = LEVEL_ORDER[b?.level] ?? 99;
    if (aLevel !== bLevel) return aLevel - bLevel;
    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });
}

/** Beginner → advanced (or by month), then by title. */
export function sortLiveClasses(liveClasses) {
  return [...(Array.isArray(liveClasses) ? liveClasses : [])].sort((a, b) => {
    const aLevel = LEVEL_ORDER[String(a?.level || "").toLowerCase()] || a?.month_number || 99;
    const bLevel = LEVEL_ORDER[String(b?.level || "").toLowerCase()] || b?.month_number || 99;
    if (aLevel !== bLevel) return aLevel - bLevel;
    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });
}

/** The newest broadcasting session that is on air, or null. */
export function selectHeroLiveBroadcast(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return (
    [...rows]
      .filter((session) => {
        if (String(session?.session_type || "").trim().toLowerCase() !== "broadcasting") return false;
        if (String(session?.status || "").trim().toLowerCase() === "ended") return false;
        return String(session?.stream_status || "").trim().toLowerCase() === "live";
      })
      .sort((a, b) => {
        const aTimestamp = new Date(a?.started_at || a?.created_at || 0).getTime();
        const bTimestamp = new Date(b?.started_at || b?.created_at || 0).getTime();
        return bTimestamp - aTimestamp;
      })[0] || null
  );
}

function broadcastCourseId(broadcast) {
  return Number(broadcast?.linked_course?.id || broadcast?.linked_live_class?.linked_course_id || 0);
}

/** Where "Join now" goes for an on-air broadcast (same targets as before). */
export function liveBroadcastJoinPath(broadcast) {
  if (!broadcast) return "/courses?view=owned";
  const courseId = broadcastCourseId(broadcast);
  return courseId > 0 ? `/courses/${courseId}/live?session=${broadcast.id}` : `/join-live?session=${broadcast.id}`;
}

/** True only while this live class is actually on air (the single "on air" source). */
export function isLiveClassOnAir(liveClass, broadcast) {
  if (!liveClass || !broadcast) return false;
  const linkedClassId = Number(broadcast?.linked_live_class?.id || 0);
  if (linkedClassId > 0) return Number(liveClass.id) === linkedClassId;
  const courseId = broadcastCourseId(broadcast);
  return courseId > 0 && Number(liveClass.linked_course_id || 0) === courseId;
}

/** "Join now" target: the open professional course (or the first open one), else the catalogue. */
export function selectFeaturedCoursePath(courses) {
  const list = Array.isArray(courses) ? courses : [];
  const live = list.filter((course) => getCourseLaunchStatus(course).isLive && !course?.registration_closed);
  const featured =
    live.find((course) => String(course?.title || "").toLowerCase().includes("professional")) || live[0] || null;
  const id = Number(featured?.id || 0);
  return id > 0 ? `/courses/${id}` : "/courses";
}

/** Published course counts per track, from the catalogue (used when the server sent no tracks). */
export function countCoursesByTrack(courses) {
  return (Array.isArray(courses) ? courses : []).reduce(
    (counts, course) => {
      if (course?.is_published !== false && course?.category in counts) counts[course.category] += 1;
      return counts;
    },
    { osint: 0, web_pentesting: 0 },
  );
}

function initialCatalog() {
  const cached = readCachedCourseCatalogEntry();
  const courses = sortCatalogCourses(selectPublicCatalogCourses(cached.courses));
  return { courses, tracks: [], status: "loading", updatedAt: courses.length ? cached.cachedAt || null : null, fromCache: courses.length > 0 };
}

/** The current catalogue: cached data first (no flash), then the live answer; on failure the cache stays. */
export function useLandingCatalog() {
  const [state, setState] = useState(initialCatalog);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listCourses({ catalog: "current" });
        if (!active) return;
        const apiCourses = selectPublicCatalogCourses(apiData(response, []));
        writeCachedCourseCatalog(apiCourses);
        setState({
          courses: sortCatalogCourses(apiCourses),
          tracks: readCatalogTracks(response),
          status: "ready",
          updatedAt: Date.now(),
          fromCache: false,
        });
      } catch {
        if (!active) return;
        setState((previous) => {
          if (previous.courses.length) return { ...previous, status: "error", fromCache: true };
          const cached = readCachedCourseCatalogEntry();
          const courses = sortCatalogCourses(selectPublicCatalogCourses(cached.courses));
          return { courses, tracks: previous.tracks, status: "error", updatedAt: courses.length ? cached.cachedAt || null : null, fromCache: courses.length > 0 };
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState((previous) => ({ ...previous, status: "loading" }));
    setAttempt((value) => value + 1);
  }, []);

  return { ...state, retry };
}

/** Live classes; on failure the last real answer stays (with its time), never a made-up list. */
export function useLandingLiveClasses(isAuthenticated) {
  const [state, setState] = useState({ items: [], status: "loading", updatedAt: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listLiveClasses();
        if (!active) return;
        setState({ items: sortLiveClasses(apiData(response, [])), status: "ready", updatedAt: Date.now() });
      } catch {
        if (!active) return;
        setState((previous) => ({ ...previous, status: "error" }));
      }
    })();
    return () => {
      active = false;
    };
  }, [isAuthenticated, attempt]);

  const retry = useCallback(() => {
    setState((previous) => ({ ...previous, status: "loading" }));
    setAttempt((value) => value + 1);
  }, []);

  return { ...state, retry };
}

/** The on-air broadcast for signed-in visitors (polled while visible), else null. */
export function useHeroLiveBroadcast(isAuthenticated) {
  const [broadcast, setBroadcast] = useState(null);

  useEffect(() => {
    let active = true;
    let timeoutId = null;
    let inFlight = false;

    if (!isAuthenticated) {
      setBroadcast(null);
      return undefined;
    }

    const scheduleNextPoll = () => {
      if (!active) return;
      const delay =
        document.visibilityState === "visible" ? HERO_LIVE_BROADCAST_VISIBLE_POLL_MS : HERO_LIVE_BROADCAST_HIDDEN_POLL_MS;
      timeoutId = window.setTimeout(load, delay);
    };

    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const response = await listRealtimeSessions({ session_type: "broadcasting", status: "all" });
        if (!active) return;
        setBroadcast(selectHeroLiveBroadcast(apiData(response, [])));
      } catch {
        if (!active) return;
        setBroadcast(null);
      } finally {
        inFlight = false;
        if (timeoutId) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        scheduleNextPoll();
      }
    };

    const refreshNow = () => {
      if (!active) return;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      load();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshNow();
    };

    load();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("pageshow", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("pageshow", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isAuthenticated]);

  return broadcast;
}

/** Everything the landing page reads, in one place. */
export function useLandingData(isAuthenticated) {
  const catalog = useLandingCatalog();
  const liveClasses = useLandingLiveClasses(isAuthenticated);
  const liveBroadcast = useHeroLiveBroadcast(isAuthenticated);
  return { catalog, liveClasses, liveBroadcast };
}
