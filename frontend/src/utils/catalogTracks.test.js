import { describe, expect, it } from "vitest";

import { findCatalogTrack, isCatalogTrackOpen, readCatalogTracks, TRACK_STATES } from "./catalogTracks";

const response = {
  data: {
    success: true,
    data: [],
    tracks: [
      { key: "osint", title: "Open Source Intelligence", state: "open", course_count: 2, open_course_count: 1 },
      { key: "web_pentesting", title: "Web Application & API Security", state: "coming_soon", course_count: 0, open_course_count: 0 },
    ],
  },
};

describe("catalog tracks", () => {
  it("reads the tracks block next to data", () => {
    expect(readCatalogTracks(response)).toEqual([
      { key: "osint", title: "Open Source Intelligence", state: "open", courseCount: 2, openCourseCount: 1 },
      { key: "web_pentesting", title: "Web Application & API Security", state: "coming_soon", courseCount: 0, openCourseCount: 0 },
    ]);
    expect(readCatalogTracks(response.data)).toHaveLength(2);
    expect(readCatalogTracks(response.data.tracks)).toHaveLength(2);
  });

  it("treats anything but 'open' as coming soon and drops malformed rows", () => {
    const tracks = readCatalogTracks([{ key: "osint", state: "OPEN!", course_count: "x" }, null, { title: "no key" }]);
    expect(tracks).toEqual([{ key: "osint", title: "", state: TRACK_STATES.COMING_SOON, courseCount: 0, openCourseCount: 0 }]);
  });

  it("answers unknown (null), never 'closed', when the server said nothing", () => {
    const tracks = readCatalogTracks(response);
    expect(isCatalogTrackOpen(tracks, "osint")).toBe(true);
    expect(isCatalogTrackOpen(tracks, "web_pentesting")).toBe(false);
    expect(isCatalogTrackOpen(tracks, "cloud")).toBeNull();
    expect(isCatalogTrackOpen(readCatalogTracks({ data: { data: [] } }), "osint")).toBeNull();
    expect(findCatalogTrack(null, "osint")).toBeNull();
  });
});
