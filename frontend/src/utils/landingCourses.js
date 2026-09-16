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
      const leftCreatedAt = new Date(left?.created_at || "").getTime();
      const rightCreatedAt = new Date(right?.created_at || "").getTime();
      if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt)) {
        const createdOrder = leftCreatedAt - rightCreatedAt;
        if (createdOrder !== 0) return createdOrder;
      }

      const idOrder = Number(left?.id || 0) - Number(right?.id || 0);
      if (idOrder !== 0) return idOrder;
      return String(left?.title || "").localeCompare(String(right?.title || ""));
    });
}

export function selectHeroCategoryCourses({
  catalogCourses = [],
  studentCourses = [],
  fallbackCourses = [],
} = {}) {
  return ["osint", "web_pentesting"].map((category) => {
    const categoryCourses = catalogCourses.filter(
      (course) => course?.category === category && course?.is_published !== false,
    );
    const selectedCourse =
      categoryCourses.find((course) => course?.is_flagship) ||
      categoryCourses.find(isOpenLiveCourse) ||
      newestCourse(categoryCourses);

    if (!selectedCourse) {
      return fallbackCourses.find((course) => course?.category === category) || null;
    }

    const ownedCourse = studentCourses.find(
      (course) => Number(course?.id) === Number(selectedCourse?.id),
    );
    if (!ownedCourse) return selectedCourse;

    return {
      ...selectedCourse,
      ...ownedCourse,
      is_enrolled: true,
      enrollment_status: "approved",
    };
  }).filter(Boolean);
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
