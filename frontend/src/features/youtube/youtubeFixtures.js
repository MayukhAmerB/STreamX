// Shared API payloads for the YouTube tests (shape of GET /api/site/youtube/ data).
export const payload = (overrides = {}) => ({
  enabled: true,
  available: true,
  section: { title: "Watch Al Syed", subtitle: "Free live classes." },
  channel: {
    title: "Al Syed",
    handle: "@thesy3d",
    url: "https://www.youtube.com/@thesy3d",
    subscribe_url: "https://www.youtube.com/@thesy3d?sub_confirmation=1",
  },
  live: { is_live: false, video_id: null, title: "" },
  featured: { video_id: "hWFA4oNF7gk", title: "Destroying the Propaganda Machine", published_at: "2026-10-11T19:36:58Z", thumbnail: "x" },
  latest: [
    { video_id: "hWFA4oNF7gk", title: "Destroying the Propaganda Machine", published_at: "2026-10-11T19:36:58Z" },
    { video_id: "dBL5_4EQ47M", title: "FREE LIVE Advanced OSINT Class", published_at: "2026-09-01T10:00:00Z" },
    { video_id: "vZy0LqWsXcQ", title: "Al Syed Live Stream", published_at: "2026-08-01T10:00:00Z" },
  ],
  fetched_at: "2026-11-12T10:00:00Z",
  ...overrides,
});

export const livePayload = (overrides = {}) =>
  payload({ live: { is_live: true, video_id: "LiVe1234567", title: "Sunday OSINT live" }, ...overrides });
