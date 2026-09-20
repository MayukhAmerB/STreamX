import { describe, expect, it } from "vitest";

import {
  selectHeroCategoryCourses,
  selectHeroProgramCourse,
  selectLandingCourses,
} from "./landingCourses";

describe("selectLandingCourses", () => {
  it("includes upcoming and open-registration batches but excludes closed historical batches", () => {
    const courses = selectLandingCourses([
      { id: 1, title: "Current course", batch: "Batch IV", launch_status: "live", registration_closed: false },
      {
        id: 2,
        title: "Previous batch",
        batch: "Batch III",
        launch_status: "live",
        registration_closed: true,
      },
      { id: 3, title: "Future course", batch: "Batch V", launch_status: "coming_soon", registration_closed: true },
    ]);

    expect(courses.map((course) => course.id)).toEqual([1, 3]);
  });

  it("uses first-in, first-out order across discoverable batches", () => {
    const courses = selectLandingCourses([
      {
        id: 8,
        title: "Newest open batch",
        batch: "Batch V",
        launch_status: "live",
        registration_closed: false,
        created_at: "2026-09-01T00:00:00Z",
      },
      {
        id: 3,
        title: "Oldest previous batch",
        batch: "Batch III",
        launch_status: "live",
        registration_closed: true,
        created_at: "2026-06-01T00:00:00Z",
      },
      {
        id: 5,
        title: "Middle open batch",
        batch: "Batch IV",
        launch_status: "live",
        registration_closed: false,
        created_at: "2026-07-01T00:00:00Z",
      },
    ]);

    expect(courses.map((course) => course.id)).toEqual([5, 8]);
  });

  it("uses ascending IDs as the FIFO fallback when creation dates are absent", () => {
    const courses = selectLandingCourses([
      { id: 9, title: "Later", batch: "Batch V", launch_status: "live" },
      { id: 2, title: "Earlier", batch: "Batch IV", launch_status: "live" },
    ]);

    expect(courses.map((course) => course.id)).toEqual([2, 9]);
  });
});

describe("selectHeroProgramCourse", () => {
  const featuredCourse = {
    id: 20,
    title: "Previous batch",
    launch_status: "live",
    registration_closed: true,
  };

  it("shows the newest open course instead of a closed featured or owned batch", () => {
    const selected = selectHeroProgramCourse({
      featuredCourse,
      catalogCourses: [
        featuredCourse,
        {
          id: 21,
          title: "Current batch",
          launch_status: "live",
          registration_closed: false,
          purchase_available: true,
          created_at: "2026-07-28T12:00:00Z",
        },
      ],
      studentCourses: [
        { id: 20, title: "Previous batch", access_source: "purchased" },
      ],
    });

    expect(selected).toMatchObject({
      id: 21,
      title: "Current batch",
      purchase_available: true,
    });
  });

  it("uses creation time to choose the latest open course", () => {
    const selected = selectHeroProgramCourse({
      catalogCourses: [
        {
          id: 30,
          title: "Older open batch",
          launch_status: "live",
          purchase_available: true,
          created_at: "2026-06-01T00:00:00Z",
        },
        {
          id: 31,
          title: "Latest open batch",
          launch_status: "live",
          purchase_available: false,
          created_at: "2026-07-01T00:00:00Z",
        },
      ],
    });

    expect(selected).toMatchObject({ id: 31, title: "Latest open batch" });
  });

  it("preserves approved access when the student owns the current course", () => {
    const selected = selectHeroProgramCourse({
      catalogCourses: [
        {
          id: 40,
          title: "Current batch",
          launch_status: "live",
          purchase_available: true,
        },
      ],
      studentCourses: [{ id: 40, title: "Current batch" }],
    });

    expect(selected).toMatchObject({
      id: 40,
      is_enrolled: true,
      enrollment_status: "approved",
    });
  });

  it("falls back to an owned historical course when no registration is open", () => {
    const selected = selectHeroProgramCourse({
      featuredCourse,
      catalogCourses: [featuredCourse],
      studentCourses: [{ id: 20, title: "Previous batch" }],
    });

    expect(selected).toMatchObject({
      id: 20,
      is_enrolled: true,
      enrollment_status: "approved",
    });
  });

  it("uses the featured fallback when the API provides no courses", () => {
    expect(selectHeroProgramCourse({ featuredCourse })).toBe(featuredCourse);
  });
});

describe("selectHeroCategoryCourses", () => {
  it("selects one flagship card per category and preserves owned access", () => {
    const selected = selectHeroCategoryCourses({
      catalogCourses: [
        { id: 1, category: "osint", is_flagship: false, is_published: true },
        { id: 2, category: "osint", is_flagship: true, is_published: true },
        { id: 3, category: "web_pentesting", is_flagship: true, is_published: true },
      ],
      studentCourses: [{ id: 3, title: "Owned pentesting" }],
    });

    expect(selected.map((course) => course.id)).toEqual([2, 3]);
    expect(selected[1]).toMatchObject({
      is_enrolled: true,
      enrollment_status: "approved",
    });
  });

  it("uses category fallbacks without inventing database identifiers", () => {
    const fallbacks = [
      { category: "osint", card_title: "OSINT" },
      { category: "web_pentesting", card_title: "Pentesting" },
    ];

    expect(selectHeroCategoryCourses({ fallbackCourses: fallbacks })).toEqual(fallbacks);
  });
});
