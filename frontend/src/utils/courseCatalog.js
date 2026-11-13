import { getCourseLaunchStatus } from "./courseStatus";

const COURSE_CATALOG_CACHE_KEY = "course-catalog-cache:v2";
const COURSE_CATALOG_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const USER_SCOPED_COURSE_FIELDS = [
  "is_enrolled",
  "enrollment_status",
  "enrolled_at",
  "access_source",
  "access_label",
];

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeCourseArray(courses) {
  return Array.isArray(courses) ? courses.filter(Boolean) : [];
}

export function isPublicCatalogCourse(course) {
  if (!course || course.is_published === false) return false;

  const status = getCourseLaunchStatus(course);
  return status.isComingSoon || (status.isLive && !course.registration_closed);
}

export function selectPublicCatalogCourses(courses) {
  return normalizeCourseArray(courses).filter(isPublicCatalogCourse);
}

export function getCourseCategoryPath(category) {
  const normalizedCategory = String(category || "").trim().toLowerCase();
  return `/courses?category=${encodeURIComponent(normalizedCategory)}#course-category-results`;
}

function stripUserScopedCourseFields(course) {
  if (!course || typeof course !== "object") {
    return course;
  }

  const normalizedCourse = { ...course };
  USER_SCOPED_COURSE_FIELDS.forEach((field) => {
    delete normalizedCourse[field];
  });
  return normalizedCourse;
}

function sanitizeCourseCatalogForCache(courses) {
  return normalizeCourseArray(courses).map(stripUserScopedCourseFields);
}

export function filterCourseCatalog(courses, search = "") {
  const normalizedCourses = normalizeCourseArray(courses);
  const term = String(search || "").trim().toLowerCase();
  if (!term) {
    return normalizedCourses;
  }

  return normalizedCourses.filter((course) => {
    const title = String(course?.title || "").toLowerCase();
    const description = String(course?.description || "").toLowerCase();
    return title.includes(term) || description.includes(term);
  });
}

export function filterCoursesByCategory(courses, category) {
  const normalizedCategory = String(category || "").trim().toLowerCase();
  if (!normalizedCategory) {
    return [];
  }

  return normalizeCourseArray(courses).filter(
    (course) => String(course?.category || "").toLowerCase() === normalizedCategory
  );
}

export function getCourseCategoryCounts(courses) {
  const normalizedCourses = selectPublicCatalogCourses(courses);
  return {
    osint: filterCoursesByCategory(normalizedCourses, "osint").length,
    web_pentesting: filterCoursesByCategory(normalizedCourses, "web_pentesting").length,
  };
}

/**
 * The cached catalog with the time it was written ({ courses, cachedAt }):
 * lets a page show real cached data with "Last updated hh:mm" when a refresh fails.
 */
export function readCachedCourseCatalogEntry({ maxAgeMs = COURSE_CATALOG_CACHE_MAX_AGE_MS } = {}) {
  const empty = { courses: [], cachedAt: 0 };
  if (!canUseStorage()) {
    return empty;
  }

  try {
    const raw = window.localStorage.getItem(COURSE_CATALOG_CACHE_KEY);
    if (!raw) {
      return empty;
    }

    const parsed = JSON.parse(raw);
    const cachedAt = Number(parsed?.cachedAt || 0);
    const courses = sanitizeCourseCatalogForCache(parsed?.courses);
    if (!courses.length) {
      return empty;
    }
    if (cachedAt && Date.now() - cachedAt > maxAgeMs) {
      return empty;
    }
    return { courses, cachedAt };
  } catch {
    return empty;
  }
}

export function readCachedCourseCatalog(options) {
  return readCachedCourseCatalogEntry(options).courses;
}

export function writeCachedCourseCatalog(courses) {
  if (!canUseStorage()) {
    return;
  }

  const normalizedCourses = sanitizeCourseCatalogForCache(courses);
  if (!normalizedCourses.length) {
    return;
  }

  try {
    window.localStorage.setItem(
      COURSE_CATALOG_CACHE_KEY,
      JSON.stringify({
        cachedAt: Date.now(),
        courses: normalizedCourses,
      })
    );
  } catch {
    // Ignore cache write failures and keep the live response.
  }
}
