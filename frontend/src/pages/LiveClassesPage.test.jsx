import { describe, expect, it } from "vitest";
import { sessionBelongsToCourse } from "./LiveClassesPage";

describe("sessionBelongsToCourse", () => {
  it("matches sessions linked directly to the approved course", () => {
    expect(
      sessionBelongsToCourse(
        { linked_course: { id: 11 }, linked_live_class: null },
        11
      )
    ).toBe(true);
  });

  it("matches sessions linked through a course live class", () => {
    expect(
      sessionBelongsToCourse(
        {
          linked_course: null,
          linked_live_class: { id: 8, linked_course_id: 11 },
        },
        11
      )
    ).toBe(true);
  });

  it("rejects sessions belonging to another course", () => {
    expect(
      sessionBelongsToCourse(
        {
          linked_course: { id: 12 },
          linked_live_class: { id: 9, linked_course_id: 12 },
        },
        11
      )
    ).toBe(false);
  });

  it("keeps the legacy unscoped live-class view compatible", () => {
    expect(sessionBelongsToCourse({ linked_course: null }, null)).toBe(true);
  });
});
