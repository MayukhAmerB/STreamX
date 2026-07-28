import { describe, expect, it } from "vitest";

import { selectHeroProgramCourse, selectLandingCourses } from "./landingCourses";

describe("selectLandingCourses", () => {
  it("includes open live courses and registration-closed previous batches", () => {
    const courses = selectLandingCourses([
      { id: 1, title: "Current course", launch_status: "live", registration_closed: false },
      {
        id: 2,
        title: "Previous batch",
        launch_status: "coming_soon",
        registration_closed: true,
      },
      { id: 3, title: "Future course", launch_status: "coming_soon", registration_closed: false },
    ]);

    expect(courses.map((course) => course.id)).toEqual([1, 2]);
  });

  it("keeps open enrollment programs before closed batches", () => {
    const courses = selectLandingCourses([
      { id: 2, title: "Archived batch", launch_status: "live", registration_closed: true },
      { id: 1, title: "Open batch", launch_status: "live", registration_closed: false },
    ]);

    expect(courses.map((course) => course.id)).toEqual([1, 2]);
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
