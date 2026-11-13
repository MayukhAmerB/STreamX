// Track (category) availability from the server: the `tracks` block that
// GET /api/courses/ returns next to `data` (backend apps/courses/catalog_tracks.py).
// Plan §7.2 rule 1: availability always comes from here; never infer it from
// course counts or titles.

export const TRACK_STATES = Object.freeze({ OPEN: "open", COMING_SOON: "coming_soon" });

const count = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
};

/** Normalised tracks from an axios response (or the raw envelope / array); [] when absent or malformed. */
export function readCatalogTracks(source) {
  const raw = Array.isArray(source) ? source : source?.data?.tracks ?? source?.tracks;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((track) => track && typeof track.key === "string" && track.key)
    .map((track) => ({
      key: track.key,
      title: String(track.title || ""),
      state: track.state === TRACK_STATES.OPEN ? TRACK_STATES.OPEN : TRACK_STATES.COMING_SOON,
      courseCount: count(track.course_count),
      openCourseCount: count(track.open_course_count),
    }));
}

/** The track for a category key, or null when the server did not describe it (unknown, not "closed"). */
export function findCatalogTrack(tracks, key) {
  return (Array.isArray(tracks) ? tracks : []).find((track) => track.key === key) || null;
}

/** true / false from the server's state; null when unknown (e.g. the request failed). */
export function isCatalogTrackOpen(tracks, key) {
  const track = findCatalogTrack(tracks, key);
  return track ? track.state === TRACK_STATES.OPEN : null;
}

/** The calm reason a closed track shows (owner copy, plan §7.2 rule 2). */
export const TRACK_COMING_SOON_REASON = "Coming soon · No courses yet";

/**
 * How a track tile renders: { closed, count, reason }. `closed` comes only from
 * the server state; when the server said nothing the tile stays a link. A
 * closed track never shows a course count next to "No courses yet" (its
 * course_count can include coming-soon courses), so `count` is null then.
 */
export function describeTrackAvailability(tracks, key, fallbackCount = null) {
  const track = findCatalogTrack(tracks, key);
  if (track && track.state !== TRACK_STATES.OPEN) {
    return { closed: true, count: null, reason: TRACK_COMING_SOON_REASON };
  }
  return { closed: false, count: track ? track.courseCount : fallbackCount, reason: "" };
}
