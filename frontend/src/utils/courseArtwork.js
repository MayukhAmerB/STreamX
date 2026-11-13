const CATEGORY_ARTWORK = Object.freeze({
  osint: "/course-art/osint-program-v2.webp",
  web_pentesting: "/course-art/pentesting-program-v2.webp",
});

export function resolveCourseArtworkFallback(category) {
  return CATEGORY_ARTWORK[String(category || "").toLowerCase()] || "";
}

export function resolveCourseArtwork(course) {
  const configuredThumbnail = String(course?.thumbnail || "").trim();
  if (configuredThumbnail) return configuredThumbnail;

  return resolveCourseArtworkFallback(course?.category);
}
