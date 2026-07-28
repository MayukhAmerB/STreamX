export function hasApprovedCourseAccess(course) {
  const status = String(course?.enrollment_status || "").toLowerCase();
  return Boolean(course?.is_enrolled) || status === "paid" || status === "approved";
}

export function isOsintCourse(course) {
  return String(course?.category || "").toLowerCase() === "osint";
}

export function getPurchaseUnavailableMessage(course) {
  const reason = String(course?.purchase_unavailable_reason || "").toLowerCase();

  if (reason === "price_not_configured" || Number(course?.price || 0) <= 0) {
    return "Enrollment price has not been configured for this track.";
  }
  if (reason === "course_not_live") {
    return "This track is not open for enrollment yet.";
  }
  if (reason === "registration_closed") {
    return "Registration is closed for this batch.";
  }
  if (reason === "course_unpublished") {
    return "This track is not published for enrollment.";
  }
  if (reason === "checkout_disabled") {
    return "Secure checkout is temporarily disabled.";
  }

  return "Secure checkout is not enabled for this track yet.";
}
