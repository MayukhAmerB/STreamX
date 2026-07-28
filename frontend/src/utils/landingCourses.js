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

export function selectHeroProgramCourse({
  featuredCourse,
  catalogCourses = [],
  studentCourses = [],
} = {}) {
  const ownedCourse = studentCourses[0];
  if (!ownedCourse) {
    return featuredCourse;
  }

  const catalogCourse = catalogCourses.find(
    (course) => Number(course?.id) === Number(ownedCourse?.id)
  );

  return {
    ...(catalogCourse || {}),
    ...ownedCourse,
    is_enrolled: true,
    enrollment_status: "approved",
  };
}
