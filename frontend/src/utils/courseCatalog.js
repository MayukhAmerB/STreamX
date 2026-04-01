const COURSE_CATALOG_CACHE_KEY = "course-catalog-cache:v1";
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

export function readCachedCourseCatalog({ maxAgeMs = COURSE_CATALOG_CACHE_MAX_AGE_MS } = {}) {
  if (!canUseStorage()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(COURSE_CATALOG_CACHE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    const cachedAt = Number(parsed?.cachedAt || 0);
    const courses = sanitizeCourseCatalogForCache(parsed?.courses);
    if (!courses.length) {
      return [];
    }
    if (cachedAt && Date.now() - cachedAt > maxAgeMs) {
      return [];
    }
    return courses;
  } catch {
    return [];
  }
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
