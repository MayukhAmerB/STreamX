export function getCourseLaunchStatus(course) {
  const backendStatus = String(course?.launch_status || "").toLowerCase();
  if (backendStatus === "live") {
    return { key: "live", label: "Live", isLive: true, isComingSoon: false };
  }
  if (backendStatus === "coming_soon") {
    return { key: "coming_soon", label: "Coming Soon", isLive: false, isComingSoon: true };
  }

  const title = String(course?.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  const compact = title.replace(/\s+/g, "");

  if (title.includes("osint")) {
    return { key: "live", label: "Live", isLive: true, isComingSoon: false };
  }

  if (
    title.includes("web application pentesting") ||
    compact.includes("webapplicationpentesting")
  ) {
    return { key: "coming_soon", label: "Coming Soon", isLive: false, isComingSoon: true };
  }

  return { key: "default", label: "Available", isLive: true, isComingSoon: false };
}
