import { describe, expect, it } from "vitest";
import {
  applyLectureProgressSnapshot,
  buildCourseOutline,
  findFirstPreviewLecture,
  findNextPlayableLecture,
  flattenCourseLectures,
  isLectureLocked,
  pickInitialLecture,
  resolveAdjacentLectures,
  resolveLectureDescriptions,
} from "./outlineModel";
import { makeCourse } from "./testFixtures";

describe("flattenCourseLectures", () => {
  it("keeps course order and attaches module metadata", () => {
    const lectures = flattenCourseLectures(makeCourse());
    expect(lectures.map((lecture) => lecture.id)).toEqual([11, 12, 21, 22]);
    expect(lectures[2]).toMatchObject({ section_id: 2, section_index: 1, section_title: "Recon" });
    expect(lectures[0].section_description).toBe("Module one description");
  });

  it("handles a missing course", () => {
    expect(flattenCourseLectures(null)).toEqual([]);
  });
});

describe("pickInitialLecture", () => {
  it("resumes the most recently watched lesson", () => {
    expect(pickInitialLecture(makeCourse()).id).toBe(12);
  });

  it("honours a deep-linked lesson", () => {
    expect(pickInitialLecture(makeCourse(), { preferredLectureId: "22" }).id).toBe(22);
    expect(pickInitialLecture(makeCourse(), { preferredLectureId: "999" }).id).toBe(12);
  });

  it("starts non-enrolled viewers on a free preview", () => {
    const course = makeCourse({ is_enrolled: false });
    course.sections[0].lectures[1].progress = null;
    course.sections[0].lectures[0].progress = null;
    expect(pickInitialLecture(course).id).toBe(11);
  });

  it("falls back to the first lesson when nothing is playable", () => {
    const course = makeCourse({ is_enrolled: false });
    course.sections[0].lectures[0].is_preview = false;
    expect(pickInitialLecture(course).id).toBe(11);
    expect(pickInitialLecture({ sections: [] })).toBeNull();
  });
});

describe("access", () => {
  it("locks non-preview lessons without full access", () => {
    expect(isLectureLocked({ id: 1, is_preview: false }, false)).toBe(true);
    expect(isLectureLocked({ id: 1, is_preview: true }, false)).toBe(false);
    expect(isLectureLocked({ id: 1, is_preview: false }, true)).toBe(false);
  });

  it("finds the first free preview", () => {
    expect(findFirstPreviewLecture(makeCourse()).id).toBe(11);
  });
});

describe("buildCourseOutline", () => {
  it("summarizes modules as completed/total with running time", () => {
    const outline = buildCourseOutline(makeCourse(), { currentLectureId: 12 });
    expect(outline).toMatchObject({ total: 4, completed: 1, percent: 25, modules: expect.any(Array) });
    const [first, second] = outline.modules;
    expect(first).toMatchObject({ completedCount: 1, totalCount: 2, durationSeconds: 1200, containsCurrent: true });
    expect(second).toMatchObject({ completedCount: 0, totalCount: 2, containsCurrent: false });
    expect(first.lessons.map((lesson) => lesson.status)).toEqual(["completed", "in-progress"]);
    expect(first.lessons[1]).toMatchObject({ current: true, number: 2, resumeAt: 360, percent: 40 });
    expect(second.lessons[0].number).toBe(3);
  });

  it("marks locked lessons and preview badges for non-enrolled viewers", () => {
    const outline = buildCourseOutline(makeCourse({ is_enrolled: false }));
    const lessons = outline.modules.flatMap((module) => module.lessons);
    expect(lessons.map((lesson) => lesson.locked)).toEqual([false, true, true, true]);
    expect(lessons.map((lesson) => lesson.status)).toEqual(["completed", "locked", "locked", "locked"]);
    expect(lessons[0].preview).toBe(true);
  });

  it("hides the preview badge from enrolled learners", () => {
    const outline = buildCourseOutline(makeCourse());
    expect(outline.modules[0].lessons[0].preview).toBe(false);
  });
});

describe("previous / next", () => {
  const lectures = flattenCourseLectures(makeCourse());

  it("resolves neighbours in course order across modules", () => {
    expect(resolveAdjacentLectures(lectures, 12)).toMatchObject({ index: 1, total: 4 });
    expect(resolveAdjacentLectures(lectures, 12).previous.id).toBe(11);
    expect(resolveAdjacentLectures(lectures, 12).next.id).toBe(21);
    expect(resolveAdjacentLectures(lectures, 11).previous).toBeNull();
    expect(resolveAdjacentLectures(lectures, 22).next).toBeNull();
    expect(resolveAdjacentLectures(lectures, 999)).toMatchObject({ index: -1, previous: null, next: null });
  });

  it("autoplay only targets playable lessons", () => {
    expect(findNextPlayableLecture(lectures, 11, true).id).toBe(12);
    expect(findNextPlayableLecture(lectures, 11, false)).toBeNull();
    expect(findNextPlayableLecture(lectures, 22, true)).toBeNull();
  });
});

describe("applyLectureProgressSnapshot", () => {
  it("replaces one lesson's progress immutably", () => {
    const course = makeCourse();
    const next = applyLectureProgressSnapshot(course, 21, { completed: true });
    expect(next).not.toBe(course);
    expect(next.sections[1].lectures[0].progress).toEqual({ completed: true });
    expect(course.sections[1].lectures[0].progress).toBeUndefined();
    expect(next.sections[0]).not.toBe(course.sections[0]);
  });
});

describe("resolveLectureDescriptions", () => {
  it("prefers the lesson text and adds the module text when different", () => {
    const [, , maps] = flattenCourseLectures(
      makeCourse({ sections: [...makeCourse().sections.slice(0, 1), { ...makeCourse().sections[1], description: "Recon module" }] })
    );
    expect(resolveLectureDescriptions(maps, {})).toEqual({ primary: "Lesson text", moduleDescription: "Recon module" });
  });

  it("falls back to the module, then the course description (class recordings)", () => {
    const [welcome] = flattenCourseLectures(makeCourse());
    expect(resolveLectureDescriptions(welcome, { description: "Course" })).toEqual({
      primary: "Module one description",
      moduleDescription: "",
    });
    expect(resolveLectureDescriptions({ description: "" }, { description: "Course\r\ntext" }).primary).toBe("Course\ntext");
  });
});
