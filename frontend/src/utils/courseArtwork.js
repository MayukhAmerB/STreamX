const CATEGORY_ARTWORK = Object.freeze({
  osint: "/course-art/osint-program-v2.png",
  web_pentesting: "/course-art/pentesting-program-v2.png",
});

export function resolveCourseArtwork(course) {
  const configuredThumbnail = String(course?.thumbnail || "").trim();
  if (configuredThumbnail) return configuredThumbnail;

  return CATEGORY_ARTWORK[String(course?.category || "").toLowerCase()] || "";
}
