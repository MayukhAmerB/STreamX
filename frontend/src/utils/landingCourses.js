import { getCourseLaunchStatus } from "./courseStatus";

export function selectLandingCourses(courses = []) {
  return courses
    .filter((course) => {
      const status = getCourseLaunchStatus(course);
      return status.isLive || Boolean(course?.registration_closed);
    })
    .sort((left, right) => {
      const closedOrder =
        Number(Boolean(left?.registration_closed)) -
        Number(Boolean(right?.registration_closed));
      if (closedOrder !== 0) return closedOrder;

      return String(left?.title || "").localeCompare(String(right?.title || ""));
    });
}
