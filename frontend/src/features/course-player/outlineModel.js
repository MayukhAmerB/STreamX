// Course structure logic for the player: flattening, access, per-module
// progress and previous/next resolution. Pure functions (no React).

/** Lecture enriched with the module (section) it belongs to. */
export function withSectionMetadata(lecture, section = {}, sectionIndex) {
  return {
    ...lecture,
    section_id: section.id ?? lecture?.section_id ?? null,
    section_index: Number.isInteger(sectionIndex) ? sectionIndex : lecture?.section_index ?? 0,
    section_title: section.title || lecture?.section_title || "",
    section_description: section.description || lecture?.section_description || "",
  };
}

export function flattenCourseLectures(course) {
  return (course?.sections || []).flatMap((section, sectionIndex) =>
    (section.lectures || []).map((lecture) => withSectionMetadata(lecture, section, sectionIndex))
  );
}

/** Enrolled students and the course's instructor can play every lesson. */
export function hasFullCourseAccess(course) {
  return Boolean(course?.is_enrolled || course?.enrollment_status === "approved");
}

/** A lesson is locked when the viewer has no full access and it is not a free preview. */
export function isLectureLocked(lecture, fullAccess) {
  if (!lecture) return true;
  return !fullAccess && !lecture.is_preview;
}

export function getLectureDuration(lecture) {
  return Math.max(0, Number(lecture?.stream_duration_seconds || lecture?.progress?.duration_seconds || 0));
}

/** "locked" | "completed" | "in-progress" | "not-started" */
export function getLessonStatus(lecture, locked = false) {
  if (locked) return "locked";
  if (lecture?.progress?.completed) return "completed";
  const position = Number(
    lecture?.progress?.resume_position_seconds || lecture?.progress?.last_position_seconds || 0
  );
  if (position > 0 || Number(lecture?.progress?.percent_complete || 0) > 0) return "in-progress";
  return "not-started";
}

export function getResumePosition(lecture) {
  if (lecture?.progress?.completed) return 0;
  return Math.max(0, Number(lecture?.progress?.resume_position_seconds || 0));
}

/**
 * Lecture to open first: an explicitly requested one (deep link), else the
 * most recently watched playable lesson, else the first playable lesson,
 * else the first lesson (which then shows the locked state).
 */
export function pickInitialLecture(course, { preferredLectureId = null } = {}) {
  const lectures = flattenCourseLectures(course);
  if (!lectures.length) return null;

  if (preferredLectureId !== null && preferredLectureId !== undefined && preferredLectureId !== "") {
    const preferred = lectures.find((lecture) => String(lecture.id) === String(preferredLectureId));
    if (preferred) return preferred;
  }

  const fullAccess = hasFullCourseAccess(course);
  const playable = lectures.filter((lecture) => !isLectureLocked(lecture, fullAccess));

  const mostRecent = [...playable]
    .filter((lecture) => lecture?.progress?.updated_at)
    .sort(
      (left, right) =>
        new Date(right.progress.updated_at).getTime() - new Date(left.progress.updated_at).getTime()
    )[0];
  if (mostRecent) return mostRecent;
  return playable[0] || lectures[0];
}

export function findLecture(course, lectureId) {
  if (lectureId === null || lectureId === undefined) return null;
  return flattenCourseLectures(course).find((lecture) => String(lecture.id) === String(lectureId)) || null;
}

export function applyLectureProgressSnapshot(course, lectureId, progress) {
  if (!course) return course;
  return {
    ...course,
    sections: (course.sections || []).map((section) => ({
      ...section,
      lectures: (section.lectures || []).map((lecture) =>
        lecture.id === lectureId ? { ...lecture, progress } : lecture
      ),
    })),
  };
}

/** Previous / next lesson in course order (locked lessons included). */
export function resolveAdjacentLectures(orderedLectures, currentLectureId) {
  const list = Array.isArray(orderedLectures) ? orderedLectures : [];
  const index = list.findIndex((lecture) => String(lecture.id) === String(currentLectureId));
  return {
    index,
    total: list.length,
    previous: index > 0 ? list[index - 1] : null,
    next: index >= 0 && index < list.length - 1 ? list[index + 1] : null,
  };
}

/** Next lesson after the current one that the viewer can actually play. */
export function findNextPlayableLecture(orderedLectures, currentLectureId, fullAccess) {
  const list = Array.isArray(orderedLectures) ? orderedLectures : [];
  const index = list.findIndex((lecture) => String(lecture.id) === String(currentLectureId));
  if (index < 0) return null;
  return list.slice(index + 1).find((lecture) => !isLectureLocked(lecture, fullAccess)) || null;
}

export function getCourseProgressSummary(course) {
  const lectures = flattenCourseLectures(course);
  const completed = lectures.filter((lecture) => lecture?.progress?.completed).length;
  const total = lectures.length;
  return {
    total,
    completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
    moduleCount: (course?.sections || []).length,
  };
}

/**
 * Outline model for the lessons list: modules with "3/8" progress, total
 * running time, and per-lesson status / number / lock.
 */
export function buildCourseOutline(course, { currentLectureId = null } = {}) {
  const fullAccess = hasFullCourseAccess(course);
  let lessonNumber = 0;
  const modules = (course?.sections || []).map((section, sectionIndex) => {
    const lessons = (section.lectures || []).map((lecture) => {
      lessonNumber += 1;
      const locked = isLectureLocked(lecture, fullAccess);
      return {
        id: lecture.id,
        lecture: withSectionMetadata(lecture, section, sectionIndex),
        number: lessonNumber,
        title: lecture.title || `Lesson ${lessonNumber}`,
        status: getLessonStatus(lecture, locked),
        locked,
        // The "Preview" badge only matters to viewers without full access.
        preview: Boolean(lecture.is_preview) && !fullAccess,
        current: currentLectureId !== null && String(lecture.id) === String(currentLectureId),
        durationSeconds: getLectureDuration(lecture),
        percent: Math.max(0, Math.min(100, Number(lecture?.progress?.percent_complete || 0))),
        resumeAt: getResumePosition(lecture),
      };
    });
    return {
      id: section.id ?? `module-${sectionIndex}`,
      index: sectionIndex,
      title: section.title || `Module ${sectionIndex + 1}`,
      description: section.description || "",
      lessons,
      completedCount: lessons.filter((lesson) => lesson.status === "completed").length,
      totalCount: lessons.length,
      durationSeconds: lessons.reduce((sum, lesson) => sum + lesson.durationSeconds, 0),
      containsCurrent: lessons.some((lesson) => lesson.current),
    };
  });
  return { modules, fullAccess, ...getCourseProgressSummary(course) };
}

/** First free-preview lesson, used by the locked state's secondary action. */
export function findFirstPreviewLecture(course) {
  return flattenCourseLectures(course).find((lecture) => lecture.is_preview) || null;
}

/**
 * The text shown in Overview: the lesson's own description, else its
 * module's description (class recordings inherit it), else the course's.
 * `moduleDescription` is only returned when it adds something new.
 */
export function resolveLectureDescriptions(lecture, course) {
  const clean = (value) => String(value || "").replace(/\r\n/g, "\n").trim();
  const lessonText = clean(lecture?.description);
  const moduleText = clean(lecture?.section_description);
  const courseText = clean(course?.description);
  return {
    primary: lessonText || moduleText || courseText,
    moduleDescription: lessonText && moduleText && moduleText !== lessonText ? moduleText : "",
  };
}
