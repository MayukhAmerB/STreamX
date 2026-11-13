import { describe, expect, it } from "vitest";

import {
  buildVideoJsonLd,
  embedUrl,
  formatLongDate,
  formatRelativeDate,
  isValidVideoId,
  normalizeYouTubePayload,
  parseVideoId,
  selectMainVideo,
  serializeJsonLd,
  thumbnailUrl,
  watchUrl,
} from "./youtubeModel";
import { payload } from "./youtubeFixtures";


describe("video ids and URLs", () => {
  it.each([
    ["dBL5_4EQ47M", "dBL5_4EQ47M"],
    ["https://www.youtube.com/watch?v=dBL5_4EQ47M&t=42s", "dBL5_4EQ47M"],
    ["https://m.youtube.com/watch?feature=share&v=dBL5_4EQ47M", "dBL5_4EQ47M"],
    ["youtube.com/watch?v=dBL5_4EQ47M", "dBL5_4EQ47M"],
    ["https://youtu.be/dBL5_4EQ47M?si=abc", "dBL5_4EQ47M"],
    ["https://www.youtube.com/live/dBL5_4EQ47M?feature=shared", "dBL5_4EQ47M"],
    ["https://www.youtube.com/shorts/dBL5_4EQ47M", "dBL5_4EQ47M"],
    ["https://www.youtube.com/embed/dBL5_4EQ47M", "dBL5_4EQ47M"],
    ["https://www.youtube-nocookie.com/embed/dBL5_4EQ47M", "dBL5_4EQ47M"],
  ])("parses %s", (value, id) => {
    expect(parseVideoId(value)).toBe(id);
  });

  it.each([
    "",
    null,
    "dBL5_4EQ47",
    "dBL5_4EQ47MX",
    "https://evil.example/watch?v=dBL5_4EQ47M",
    "https://youtube.com.evil.example/watch?v=dBL5_4EQ47M",
    "https://user@www.youtube.com/watch?v=dBL5_4EQ47M",
    "https://www.youtube.com:8443/watch?v=dBL5_4EQ47M",
    "javascript:alert(1)",
    "https://www.youtube.com/watch?v=dBL5_4EQ47M&v=hWFA4oNF7gk",
    "https://www.youtube.com/@thesy3d",
    "https://www.youtube-nocookie.com/live/dBL5_4EQ47M",
  ])("rejects %s", (value) => {
    expect(parseVideoId(value)).toBeNull();
  });

  it("validates ids strictly", () => {
    expect(isValidVideoId("dBL5_4EQ47M")).toBe(true);
    expect(isValidVideoId('"><img src=x')).toBe(false);
    expect(isValidVideoId(undefined)).toBe(false);
  });

  it("builds privacy-enhanced embeds and ytimg thumbnails only for valid ids", () => {
    expect(embedUrl("dBL5_4EQ47M")).toBe(
      "https://www.youtube-nocookie.com/embed/dBL5_4EQ47M?rel=0&modestbranding=1&playsinline=1&autoplay=1"
    );
    expect(embedUrl("dBL5_4EQ47M", { autoplay: false })).not.toContain("autoplay");
    expect(embedUrl("bad")).toBeNull();
    expect(thumbnailUrl("dBL5_4EQ47M")).toBe("https://i.ytimg.com/vi/dBL5_4EQ47M/hqdefault.jpg");
    expect(thumbnailUrl("dBL5_4EQ47M", "maxres")).toBe("https://i.ytimg.com/vi/dBL5_4EQ47M/maxresdefault.jpg");
    expect(thumbnailUrl("../x")).toBeNull();
    expect(watchUrl("dBL5_4EQ47M")).toBe("https://www.youtube.com/watch?v=dBL5_4EQ47M");
  });
});

describe("normalizeYouTubePayload", () => {
  it("maps the API payload for the UI", () => {
    const model = normalizeYouTubePayload(payload());
    expect(model.live).toBeNull();
    expect(model.featured).toMatchObject({ videoId: "hWFA4oNF7gk", publishedAt: "2026-10-11T19:36:58.000Z" });
    expect(model.featured.thumbnail).toBe("https://i.ytimg.com/vi/hWFA4oNF7gk/hqdefault.jpg");
    expect(model.latest).toHaveLength(3);
    expect(model.channel).toEqual({
      title: "Al Syed",
      handle: "@thesy3d",
      url: "https://www.youtube.com/@thesy3d",
      subscribeUrl: "https://www.youtube.com/@thesy3d?sub_confirmation=1",
    });
  });

  it("is null (section hidden) when disabled, unavailable, malformed or empty", () => {
    expect(normalizeYouTubePayload(payload({ enabled: false }))).toBeNull();
    expect(normalizeYouTubePayload(payload({ available: false }))).toBeNull();
    expect(normalizeYouTubePayload(null)).toBeNull();
    expect(normalizeYouTubePayload("oops")).toBeNull();
    expect(normalizeYouTubePayload(payload({ featured: null, latest: [] }))).toBeNull();
  });

  it("drops anything with an invalid id and never trusts a foreign channel URL", () => {
    const model = normalizeYouTubePayload(
      payload({
        featured: { video_id: '"><script>', title: "x" },
        latest: [{ video_id: "javascript:1", title: "x" }, { video_id: "dBL5_4EQ47M", title: "ok" }],
        live: { is_live: true, video_id: "bad", title: "x" },
        channel: { title: "Al Syed", handle: "<b>", url: "javascript:alert(1)", subscribe_url: "https://evil.example/" },
      })
    );
    expect(model.latest.map((video) => video.videoId)).toEqual(["dBL5_4EQ47M"]);
    expect(model.featured.videoId).toBe("dBL5_4EQ47M");
    expect(model.live).toBeNull();
    expect(model.channel.url).toBe("https://www.youtube.com/@thesy3d");
    expect(model.channel.subscribeUrl).toBe("https://www.youtube.com/@thesy3d");
    expect(model.channel.handle).toBe("");
  });

  it("leads with the live stream when live", () => {
    const model = normalizeYouTubePayload(payload({ live: { is_live: true, video_id: "LiVe1234567", title: "Sunday OSINT live" } }));
    expect(selectMainVideo(model)).toMatchObject({ videoId: "LiVe1234567", isLive: true, title: "Sunday OSINT live" });
    expect(selectMainVideo(normalizeYouTubePayload(payload()))).toMatchObject({ videoId: "hWFA4oNF7gk", isLive: false });
  });
});

describe("dates", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  it("formats relative and long dates", () => {
    expect(formatRelativeDate("2026-11-12T09:59:30Z", now)).toBe("just now");
    expect(formatRelativeDate("2026-11-11T10:00:00Z", now)).toBe("yesterday");
    expect(formatRelativeDate("2026-10-11T19:36:58Z", now)).toBe("last month");
    expect(formatRelativeDate("2026-10-29T10:00:00Z", now)).toBe("2 weeks ago");
    expect(formatRelativeDate("garbage", now)).toBe("");
    expect(formatLongDate("2026-10-11T19:36:58Z")).toBe("11 Oct 2026");
  });
});

describe("VideoObject JSON-LD", () => {
  const channel = { title: "Al Syed", url: "https://www.youtube.com/@thesy3d" };

  it("describes a published upload with Google's required fields", () => {
    const video = { videoId: "hWFA4oNF7gk", title: "Destroying the Propaganda Machine", publishedAt: "2026-10-11T19:36:58.000Z", isLive: false };
    const jsonLd = buildVideoJsonLd(video, channel);
    expect(jsonLd).toMatchObject({
      "@type": "VideoObject",
      name: "Destroying the Propaganda Machine",
      uploadDate: "2026-10-11T19:36:58.000Z",
      embedUrl: "https://www.youtube-nocookie.com/embed/hWFA4oNF7gk",
    });
    expect(jsonLd.thumbnailUrl[0]).toBe("https://i.ytimg.com/vi/hWFA4oNF7gk/hqdefault.jpg");
  });

  it("is skipped for live streams and undated videos", () => {
    expect(buildVideoJsonLd({ videoId: "LiVe1234567", title: "x", isLive: true, publishedAt: "2026-01-01T00:00:00Z" }, channel)).toBeNull();
    expect(buildVideoJsonLd({ videoId: "hWFA4oNF7gk", title: "x", publishedAt: null }, channel)).toBeNull();
  });

  it("serialises safely inside a script tag", () => {
    expect(serializeJsonLd({ name: "</script><script>alert(1)</script>" })).not.toContain("</script>");
  });
});
