import { getCourseLaunchStatus } from "./courseStatus";

function courseTimestamp(course) {
  const timestamp = new Date(course?.created_at || course?.updated_at || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function newestCourse(courses = []) {
  return [...courses].sort((left, right) => {
    const timestampOrder = courseTimestamp(right) - courseTimestamp(left);
    if (timestampOrder !== 0) return timestampOrder;
    return Number(right?.id || 0) - Number(left?.id || 0);
  })[0];
}

function isOpenLiveCourse(course) {
  return (
    course?.is_published !== false &&
    !course?.registration_closed &&
    getCourseLaunchStatus(course).isLive
  );
}

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
  const openCourses = catalogCourses.filter(isOpenLiveCourse);
  const currentCourse = newestCourse(openCourses);

  if (currentCourse) {
    const ownedCurrentCourse = studentCourses.find(
      (course) => Number(course?.id) === Number(currentCourse?.id)
    );

    if (!ownedCurrentCourse) {
      return currentCourse;
    }

    return {
      ...currentCourse,
      ...ownedCurrentCourse,
      is_enrolled: true,
      enrollment_status: "approved",
    };
  }

  const ownedCourse = newestCourse(studentCourses);
  if (ownedCourse) {
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

  return (
    newestCourse(catalogCourses.filter((course) => course?.is_published !== false)) ||
    featuredCourse
  );
}
